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
import { createCommandCodeTransportRouter } from "./src/transport.ts"

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
  const displayName = account.primary
    ? "Command Code"
    : `Command Code (${account.provider})`
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
  transport: ReturnType<typeof createCommandCodeTransportRouter>
}

export default async function (pi: ExtensionAPI) {
  const apiBase = process.env.COMMANDCODE_API_BASE ?? DEFAULT_PROVIDER_API_BASE
  const modelsUrl = process.env.COMMANDCODE_MODELS_URL ?? DEFAULT_MODELS_URL
  const modelsTimeoutMs = getModelsTimeoutMs()
  const modelsCachePath =
    process.env.COMMANDCODE_MODELS_CACHE ?? join(getAgentDir(), "commandcode-models.json")
  const accounts = parseAccounts()

  // One transport router + generate stream + key scope per account. Transports
  // must not be shared: the router memoizes the last (apiKey → transport)
  // selection, and mixing accounts would misroute Go-plan fallback requests.
  const routes: readonly AccountRoute[] = accounts.map((account) => {
    const slots = account.primary ? ["commandcode", "command-code"] : [account.provider]
    const configuredKey = () =>
      getConfiguredApiKey({
        envNames: account.envNames,
        slots,
        allowLegacyGlobal: account.primary,
      })
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
    return { account, configuredKey, transport }
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
        route.transport.stream(
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
      return createProviderConfig(
        route.account,
        models,
        apiBase,
        route.transport.stream,
        route.configuredKey,
      )
    },
    getTransport: primaryRoute.transport.getTransport,
    providerNames: accounts.map((account) => account.provider),
    accountTransports: () =>
      routes.map(
        (route) => `transport ${route.account.provider}: ${route.transport.getTransport()}`,
      ),
  })

  pi.on("session_shutdown", () => {
    runtime.dispose()
  })

  await runtime.initialize()
}
