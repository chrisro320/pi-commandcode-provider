/**
 * Command Code provider for pi.
 *
 * Uses Command Code's documented Provider API:
 * https://api.commandcode.ai/provider/v1
 *
 * Multi-account fork: `COMMANDCODE_ACCOUNTS=b,c` registers additional
 * `commandcode-b` / `commandcode-c` OMP providers sharing this catalog. Each
 * account gets its own credential slot (`/login` per provider), its own
 * env/auth-file key scope, its own custom API name, and its own transport
 * router — selecting a model selects the account.
 *
 * Key-pool fork feature: `COMMANDCODE_KEY_POOL=b,c,ENV_NAME,user_...` puts
 * several keys behind the SINGLE `commandcode` provider; a quota/auth
 * failure transparently re-issues the request on the next key, and a
 * startup/`/commandcode-pool refresh` preflight ranks keys by remaining
 * quota. See `src/key-pool.ts`.
 */

import { AssistantMessageEventStream } from "@earendil-works/pi-ai"
import * as piAiCompat from "@earendil-works/pi-ai/compat"
import { streamSimple as streamNativeProvider } from "@earendil-works/pi-ai/compat"
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent"
import { join } from "node:path"

import { getConfiguredApiKey } from "./src/api-key.ts"
import { parseAccounts, type CommandCodeAccount } from "./src/accounts.ts"
import { pickCommandCodeApiKey, withResolvedCommandCodeApiKey } from "./src/converters.ts"
import {
  createKeyPool,
  maskKey,
  preflightKeyPool,
  resolvePoolEntries,
  streamWithKeyPool,
  type KeyPool,
} from "./src/key-pool.ts"
import { loadPoolSpec, savePoolSpec } from "./src/pool-store.ts"
import { createStreamCommandCode } from "./src/core.ts"
import { calculateCommandCodeCost } from "./src/cost.ts"
import {
  apiForModelId,
  baseUrlForModel,
  DEFAULT_MODELS_URL,
  DEFAULT_PROVIDER_API_BASE,
  getModelsTimeoutMs,
  inputModalitiesForModel,
  loadCachedCommandCodeModels,
  loadCommandCodeModels,
  MODEL_EFFORTS,
  thinkingMetadataForModel,
  type CommandCodeModel,
} from "./src/models.ts"
import { getApiKey as getOAuthApiKey, login, refreshToken } from "./src/oauth.ts"
import { normalizeCommandCodeMessage } from "./src/overflow.ts"
import { MODEL_COSTS, ZERO_MODEL_COST } from "./src/pricing.ts"
import { registerCommandCodeQuota } from "./src/quota-command.ts"
import { createCommandCodeRuntime } from "./src/runtime.ts"
import {
  createCommandCodeTransportRouter,
  type CommandCodeTransportRouter,
} from "./src/transport.ts"

const COMMAND_CODE_API = "commandcode-custom"
const COMPAT_SOURCE_ID = "pi-commandcode-provider"

type CompatStreamFunction = (
  model: Parameters<typeof streamNativeProvider>[0],
  context: Parameters<typeof streamNativeProvider>[1],
  options?: Parameters<typeof streamNativeProvider>[2],
) => AssistantMessageEventStream

/**
 * pi's compat entrypoint exposes `registerApiProvider`; Oh My Pi maps
 * `@earendil-works/pi-ai/compat` onto its own pi-ai, which lacks that export
 * and registers custom APIs itself inside `registerProvider`. Resolve the
 * function at runtime so the extension loads on both hosts.
 */
function compatApiProviderRegistrar(): ((...args: unknown[]) => unknown) | undefined {
  const register = (piAiCompat as { registerApiProvider?: unknown }).registerApiProvider
  return typeof register === "function" ? (register as (...args: unknown[]) => unknown) : undefined
}

/**
 * The custom API id for one account. OMP's `registerCustomApi` stores ONE
 * stream function per api name (`customApiRegistry.set`), so accounts must
 * not share `commandcode-custom` — the last registration would serve every
 * account's models and defeat per-account transports.
 */
function apiIdForAccount(account: CommandCodeAccount): string {
  return account.primary ? COMMAND_CODE_API : `${COMMAND_CODE_API}${account.commandSuffix}`
}

/**
 * The `apiKey` handed to `registerProvider` means different things per host.
 *
 * pi parses `$COMMAND_CODE_API_KEY` as an env template: unresolved means
 * "not configured", so `/login` credentials and `--api-key` take over, and
 * the entry keeps the API-key auth method registered next to OAuth. Without
 * it pi composes an OAuth-only provider and drops stored `api_key`
 * credentials and `--api-key`.
 *
 * Oh My Pi has no template notion: an unresolved value stays a literal config
 * override that shadows its `/login` credential store and is sent verbatim as
 * `Authorization: Bearer $COMMAND_CODE_API_KEY`. There, omit `apiKey` unless
 * a real key is configured; OMP then reads env keys and stored credentials
 * itself.
 *
 * Multi-account fork: key resolution is scoped to the account (its env names
 * and auth.json slots only — an alias never reads the primary's key), so
 * per-provider `/login` credentials cannot be shadowed cross-account.
 *
 * Hosts are told apart by the same `registerApiProvider` probe used for the
 * compat registry: pi exports it, OMP does not.
 */
function providerApiKey(account: CommandCodeAccount, configuredKey: () => string | undefined) {
  const onPi = compatApiProviderRegistrar() !== undefined
  const configured = pickCommandCodeApiKey(configuredKey(), undefined)
  if (configured) return configured
  return onPi ? `$${account.envNames[0]}` : undefined
}

function commandCodeHeaders(): Record<string, string> | undefined {
  if (process.env.CMD_ZDR === "1" || process.env.COMMANDCODE_ZDR === "1") {
    return { "x-cmd-zdr": "1" }
  }
  return undefined
}

function createProviderConfig(
  account: CommandCodeAccount,
  models: readonly CommandCodeModel[],
  apiBase: string,
  streamCommandCode: ProviderConfig["streamSimple"],
  configuredKey: () => string | undefined,
): ProviderConfig {
  const headers = commandCodeHeaders()
  const api = apiIdForAccount(account)
  const displayName = account.primary ? "Command Code" : `Command Code (${account.provider})`
  return {
    name: displayName,
    baseUrl: apiBase,
    apiKey: providerApiKey(account, configuredKey),
    api,
    streamSimple: streamCommandCode,
    headers,
    oauth: {
      name: displayName,
      login,
      refreshToken,
      getApiKey: getOAuthApiKey,
    },
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      api,
      baseUrl: baseUrlForModel(apiBase, model.api),
      reasoning: model.reasoning,
      ...(thinkingMetadataForModel(model.id) ?? {}),
      input: [...inputModalitiesForModel(model.id)],
      cost: MODEL_COSTS[model.id] ?? ZERO_MODEL_COST,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      headers,
      compat:
        model.api === "openai-completions"
          ? {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: MODEL_EFFORTS[model.id] !== undefined,
              maxTokensField: "max_tokens",
            }
          : {
              supportsEagerToolInputStreaming: false,
              supportsLongCacheRetention: false,
              supportsCacheControlOnTools: false,
              supportsToolReferences: false,
              ...(model.reasoning ? { forceAdaptiveThinking: true } : {}),
            },
    })),
  }
}

function legacyApiBase(providerApiBase: string): string {
  return providerApiBase.replace(/\/provider\/v1\/?$/, "")
}

interface AccountRoute {
  account: CommandCodeAccount
  configuredKey: () => string | undefined
  transport: CommandCodeTransportRouter
  /** Pool-wrapped stream for the primary account; raw transport otherwise. */
  stream: ProviderConfig["streamSimple"]
}

/**
 * Pool membership: the spec file (written by `/commandcode-pool add/remove`)
 * wins over the `COMMANDCODE_KEY_POOL` env seed once it exists. Entries keep
 * the env syntax (literal key, account slug, or ENV var name) and are
 * re-resolved against env/auth.json on every load.
 */
function loadPoolEntries(specPath: string): string[] {
  const stored = loadPoolSpec(specPath)
  if (stored) return stored
  return (process.env.COMMANDCODE_KEY_POOL ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

export default async function (pi: ExtensionAPI) {
  const apiBase = process.env.COMMANDCODE_API_BASE ?? DEFAULT_PROVIDER_API_BASE
  const modelsUrl = process.env.COMMANDCODE_MODELS_URL ?? DEFAULT_MODELS_URL
  const modelsTimeoutMs = getModelsTimeoutMs()
  const modelsCachePath =
    process.env.COMMANDCODE_MODELS_CACHE ?? join(getAgentDir(), "commandcode-models.json")
  const accounts = parseAccounts()
  const poolSpecPath = join(getAgentDir(), "commandcode-key-pool.json")
  let poolEntries = loadPoolEntries(poolSpecPath)
  const resolvedSeed = resolvePoolEntries(poolEntries)
  const poolWarnings = resolvedSeed
    .filter((entry) => entry.error)
    .map((entry) => `pool entry "${entry.entry}": ${entry.error}`)
  const seedKeys: string[] = []
  for (const entry of resolvedSeed) {
    if (entry.key && !seedKeys.includes(entry.key)) seedKeys.push(entry.key)
  }
  // The pool object always exists (possibly empty): `/commandcode-pool add`
  // can bootstrap membership at runtime. Chat uses pool failover only while
  // it holds keys; an empty pool defers to the plain per-account credential.
  const pool = createKeyPool(seedKeys)
  for (const warning of poolWarnings) console.warn(`[commandcode] ${warning}`)

  // One transport router + generate stream + key scope per account. Transports
  // must not be shared: the router memoizes the last (apiKey → transport)
  // selection, and mixing accounts would misroute Go-plan fallback requests.
  const routes: readonly AccountRoute[] = accounts.map((account) => {
    const slots = account.primary ? ["commandcode", "command-code"] : [account.provider]
    const baseKey = () =>
      getConfiguredApiKey({
        envNames: account.envNames,
        slots,
        allowLegacyGlobal: account.primary,
      })
    // Key pool: the primary provider serves every pool key per attempt, so
    // the host-visible "current" key (status, quota probe) is the pool head.
    const configuredKey: () => string | undefined =
      account.primary && pool ? () => pool.candidates()[0] ?? baseKey() : baseKey
    const resolveStreamOptions = (options?: Parameters<typeof streamNativeProvider>[2]) =>
      withResolvedCommandCodeApiKey(options, configuredKey())
    const streamGenerate = createStreamCommandCode({
      createStream: () => new AssistantMessageEventStream(),
      calculateCost: calculateCommandCodeCost,
      apiBase: legacyApiBase(apiBase),
      envNames: account.envNames,
      slots,
      allowLegacyGlobal: account.primary,
    })
    const transport = createCommandCodeTransportRouter({
      createStream: () => new AssistantMessageEventStream(),
      streamProvider: (model, context, options) =>
        streamNativeProvider(
          { ...model, api: apiForModelId(model.id), compat: model.compatConfig ?? model.compat },
          context,
          resolveStreamOptions(options),
        ),
      streamGenerate: (model, context, options) =>
        streamGenerate(model, context, resolveStreamOptions(options)),
    })
    const stream: ProviderConfig["streamSimple"] = account.primary
      ? (model, context, options) => {
          const candidates = pool.candidates()
          if (candidates.length === 0) {
            // Membership not (yet) configured: plain single-credential path.
            return transport.stream(model, context, resolveStreamOptions(options))
          }
          return streamWithKeyPool({
            createStream: () => new AssistantMessageEventStream(),
            model,
            candidates,
            attempt: (key) => transport.stream(model, context, { ...options, apiKey: key }),
            available: (key) => pool.available(key),
            aborted: () => options?.signal?.aborted === true,
            noteFailure: (key, kind, cooldownMs, detail) =>
              pool.noteFailure(key, kind, cooldownMs, detail),
            noteSuccess: (key) => pool.noteSuccess(key),
          })
        }
      : transport.stream
    return { account, configuredKey, transport, stream }
  })
  const routeByProvider = new Map(routes.map((route) => [route.account.provider, route]))
  const primaryRoute = routeByProvider.get("commandcode")
  if (!primaryRoute) throw new Error("internal: primary Command Code route missing")

  // pi dispatches the main chat through the registered provider, but sibling
  // extensions that call `streamSimple` from `@earendil-works/pi-ai/compat`
  // with a Command Code model resolve `model.api` through the compat
  // api-registry, which knows nothing about extension providers. Register each
  // account's custom api so those calls reach that account's transport. The
  // registry resolves no credentials for extension providers, so fall back to
  // the account-scoped configured key when the caller passes none or a
  // placeholder.
  const registrar = compatApiProviderRegistrar()
  if (registrar) {
    for (const route of routes) {
      const compatStream: CompatStreamFunction = (model, context, options) =>
        route.stream(
          model,
          context,
          withResolvedCommandCodeApiKey(options, route.configuredKey()),
        ) as AssistantMessageEventStream
      registrar(
        { api: apiIdForAccount(route.account), stream: compatStream, streamSimple: compatStream },
        COMPAT_SOURCE_ID,
      )
    }
  }

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return
    const normalized = normalizeCommandCodeMessage(event.message, ctx.model?.provider)
    return normalized ? { message: normalized.message } : undefined
  })

  registerCommandCodeQuota(pi, {
    apiBase: legacyApiBase(apiBase),
    headers: commandCodeHeaders(),
    accounts: routes.map((route) => ({
      provider: route.account.provider,
      commandName: `commandcode-quota${route.account.commandSuffix}`,
      label: route.account.primary
        ? "Command Code"
        : `Command Code ${route.account.commandSuffix.replace(/^-/, "")}`,
      configuredKey: route.configuredKey,
    })),
  })

  {
    const persist = (entries: readonly string[]) => {
      poolEntries = [...entries]
      savePoolSpec(poolSpecPath, poolEntries)
    }
    const probeKey = (key: string) => {
      void preflightKeyPool({
        pool,
        baseUrl: legacyApiBase(apiBase),
        extraHeaders: commandCodeHeaders(),
        keys: [key],
      })
    }
    const statusLines = (): string[] => {
      const now = Date.now()
      // `keys()` and `snapshot()` share the record insertion order.
      const snapshots = pool.snapshot()
      const byKey = new Map(pool.keys().map((key, index) => [key, snapshots[index]]))
      return pool.candidates().map((key, index) => {
        const entry = byKey.get(key)
        const parts = [maskKey(key)]
        if (entry?.label) parts.push(entry.label)
        if (index === 0) parts.push("active")
        if (entry?.cooldownUntil !== undefined) {
          parts.push(`cooling ${Math.max(0, Math.round((entry.cooldownUntil - now) / 1000))}s`)
        }
        if (entry?.detail) parts.push(entry.detail)
        return `${index + 1}. ${parts.join(" · ")}`
      })
    }
    pi.registerCommand("commandcode-pool", {
      description:
        "Key pool: list | add <key|slug|ENV> | remove <n|label|tail> | use <n|label|tail> | refresh",
      handler: async (args, ctx) => {
        const [verb = "", ...rest] = args.trim().split(/\s+/)
        switch (verb) {
          case "":
          case "list": {
            if (pool.keys().length === 0) {
              ctx.ui.notify(
                "Key pool is empty (single-credential mode). Add one: /commandcode-pool add <key|slug|ENV>",
                "info",
              )
              return
            }
            ctx.ui.notify(
              `Command Code key pool (${pool.keys().length} keys):\n${statusLines().join("\n")}`,
              "info",
            )
            return
          }
          case "add": {
            const entry = rest[0]
            if (!entry) {
              ctx.ui.notify("Usage: /commandcode-pool add <key|slug|ENV>", "warning")
              return
            }
            const [resolvedEntry] = resolvePoolEntries([entry])
            if (!resolvedEntry?.key) {
              ctx.ui.notify(
                `Cannot add "${entry}": ${resolvedEntry?.error ?? "unresolved"}`,
                "error",
              )
              return
            }
            if (pool.keys().includes(resolvedEntry.key)) {
              ctx.ui.notify(`"${entry}" is already in the pool.`, "warning")
              return
            }
            pool.addKey(resolvedEntry.key)
            persist([...poolEntries, entry])
            probeKey(resolvedEntry.key)
            ctx.ui.notify(`Added ${entry} (${maskKey(resolvedEntry.key)}); probing quota.`, "info")
            return
          }
          case "remove": {
            const query = rest.join(" ")
            const key = query ? pool.find(query) : undefined
            if (!key) {
              ctx.ui.notify(
                `No unique key matches "${query}". Run /commandcode-pool to list.`,
                "error",
              )
              return
            }
            if (pool.keys().length <= 1) {
              ctx.ui.notify(
                "That is the last pool key; removing it returns to single-credential mode.",
                "warning",
              )
            }
            pool.removeKey(key)
            const removal = resolvePoolEntries(poolEntries).findIndex((e) => e.key === key)
            if (removal >= 0) {
              persist(poolEntries.filter((_, index) => index !== removal))
            }
            ctx.ui.notify(`Removed ${maskKey(key)} from the pool.`, "info")
            return
          }
          case "use": {
            const query = rest.join(" ")
            const key = query ? pool.find(query) : undefined
            if (!key) {
              ctx.ui.notify(
                `No unique key matches "${query}". Run /commandcode-pool to list.`,
                "error",
              )
              return
            }
            pool.prefer(key)
            ctx.ui.notify(`Active pool key is now ${maskKey(key)} (cooldown cleared).`, "info")
            return
          }
          case "refresh": {
            const results = await preflightKeyPool({
              pool,
              baseUrl: legacyApiBase(apiBase),
              extraHeaders: commandCodeHeaders(),
            })
            ctx.ui.notify(
              `Probed ${results.length} keys.\n${statusLines().join("\n")}`,
              results.every((result) => result.ok) ? "info" : "warning",
            )
            return
          }
          default:
            ctx.ui.notify(
              "Usage: /commandcode-pool [list|add <key|slug|ENV>|remove <n|label>|use <n|label>|refresh]",
              "warning",
            )
        }
      },
    })
  }

  const runtime = createCommandCodeRuntime<ProviderConfig, ExtensionCommandContext>(pi, {
    endpoint: modelsUrl,
    cachePath: modelsCachePath,
    loadModels: (signal) =>
      loadCommandCodeModels({
        url: modelsUrl,
        cachePath: modelsCachePath,
        timeoutMs: modelsTimeoutMs,
        signal,
      }),
    loadCachedModels: () => loadCachedCommandCodeModels(modelsCachePath),
    createProviderConfig: (models, providerName) => {
      const route = routeByProvider.get(providerName) ?? primaryRoute
      return createProviderConfig(route.account, models, apiBase, route.stream, route.configuredKey)
    },
    getTransport: primaryRoute.transport.getTransport,
    providerNames: accounts.map((account) => account.provider),
    accountTransports: () => [
      ...routes.map(
        (route) => `transport ${route.account.provider}: ${route.transport.getTransport()}`,
      ),
      ...(pool.keys().length > 0 ? [`pool: ${pool.keys().length}/${pool.entryCount()} keys`] : []),
    ],
  })

  pi.on("session_shutdown", () => {
    runtime.dispose()
  })

  await runtime.initialize()
  if (pool.keys().length > 0) {
    // Non-blocking: reactive failover works unprobed; preflight only ranks
    // by remaining quota and pre-cools already-exhausted keys.
    void preflightKeyPool({
      pool,
      baseUrl: legacyApiBase(apiBase),
      extraHeaders: commandCodeHeaders(),
    })
  }
}
