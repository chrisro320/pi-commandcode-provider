import { getConfiguredApiKey } from "./api-key.ts"
import { pickCommandCodeApiKey } from "./converters.ts"
import { fetchCommandCodeQuota, redactValue } from "./quota.ts"
import { formatQuota } from "./quota-format.ts"

export interface QuotaCommandContext {
  waitForIdle?: () => Promise<void>
  modelRegistry?: {
    getApiKeyForProvider?: (provider: string) => Promise<string | undefined>
  }
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void
  }
}

interface QuotaCommandApi {
  registerCommand(
    name: string,
    options: {
      description: string
      handler: (args: string, ctx: QuotaCommandContext) => Promise<void>
    },
  ): void
}

interface RegisterQuotaCommandOptions {
  apiBase: string
  headers?: Record<string, string>
  getConfiguredKey?: () => string | undefined
  fetchQuota?: typeof fetchCommandCodeQuota
  /**
   * Multi-account fork: register one command per account. `provider` is the
   * OMP credential slot queried via the model registry; `commandName` is the
   * slash command (primary keeps `commandcode-quota`); `configuredKey` scopes
   * the auth-file/env fallback to that account. When omitted, behaves like
   * upstream: a single primary command.
   */
  accounts?: readonly {
    provider: string
    commandName: string
    label: string
    configuredKey?: () => string | undefined
  }[]
}

export function registerCommandCodeQuota(
  pi: QuotaCommandApi,
  options: RegisterQuotaCommandOptions,
): void {
  const getConfiguredKey = options.getConfiguredKey ?? getConfiguredApiKey
  const fetchQuota = options.fetchQuota ?? fetchCommandCodeQuota

  const accounts = options.accounts ?? [
    { provider: "commandcode", commandName: "commandcode-quota", label: "Command Code" },
  ]

  for (const account of accounts) {
    pi.registerCommand(account.commandName, {
      description: `Show ${account.label} account usage and quota`,
      handler: async (_args, ctx) => {
        await ctx.waitForIdle?.()
        const registryKey = await ctx.modelRegistry?.getApiKeyForProvider?.(account.provider)
        const fallbackKey = (account.configuredKey ?? getConfiguredKey)()
        const apiKey = pickCommandCodeApiKey(registryKey, fallbackKey)
        if (!apiKey) {
          ctx.ui.notify(
            `${account.label} quota requires an API key. Run /login and select ${account.label}, or set its COMMAND_CODE_API_KEY.`,
            "warning",
          )
          return
        }

        const result = await fetchQuota({
          apiKey,
          baseUrl: options.apiBase,
          extraHeaders: options.headers,
        })
        if (!result.ok) {
          ctx.ui.notify(redactValue(result.error.message), "error")
          return
        }
        ctx.ui.notify(formatQuota(result.quota), "info")
      },
    })
  }
}
