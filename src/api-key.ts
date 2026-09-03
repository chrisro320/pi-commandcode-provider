import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function defaultAuthPaths(home: string): string[] {
  return [
    join(home, ".commandcode", "auth.json"),
    join(home, ".pi", "agent", "auth.json"),
    join(home, ".omp", "agent", "auth.json"),
  ]
}

function apiKeyFromCredential(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined

  if (stringValue(value.type) === "oauth") return stringValue(value.access)
  if (stringValue(value.type) === "api") return stringValue(value.key)
  return stringValue(value.access) ?? stringValue(value.key)
}

/**
 * Slots consulted in `auth.json`, primary first. The upstream reader accepts
 * `commandcode` and the legacy `command-code` key; account aliases add their
 * own provider-name slot (e.g. `commandcode-b`). The bare `apiKey` field is a
 * legacy global and is only honored for the primary account.
 */
export interface ConfiguredApiKeyOptions {
  env?: NodeJS.ProcessEnv
  authPaths?: readonly string[]
  homeDir?: () => string
  /** Env var names consulted before the auth-file slots (account-scoped). */
  envNames?: readonly string[]
  /** auth.json slots consulted, in order (account-scoped). */
  slots?: readonly string[]
  /** Honor the bare legacy `apiKey` field (primary only). */
  allowLegacyGlobal?: boolean
}

export function getConfiguredApiKey(
  options: ConfiguredApiKeyOptions = {},
): string | undefined {
  const env = options.env ?? process.env
  const envNames = options.envNames ?? ["COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"]
  for (const name of envNames) {
    const value = env[name]
    if (value) return value
  }

  const home = options.homeDir?.() ?? homedir()
  const authPaths = options.authPaths ?? defaultAuthPaths(home)
  const slots = options.slots ?? ["commandcode", "command-code"]
  const allowLegacyGlobal = options.allowLegacyGlobal ?? slots[0] === "commandcode"

  for (const authPath of authPaths) {
    try {
      if (!existsSync(authPath)) continue
      const parsed: unknown = JSON.parse(readFileSync(authPath, "utf-8"))
      if (!isRecord(parsed)) continue

      if (allowLegacyGlobal) {
        const apiKey = stringValue(parsed.apiKey)
        if (apiKey) return apiKey
      }

      for (const slot of slots) {
        const direct = stringValue(parsed[slot])
        if (direct) return direct
        const providerKey = apiKeyFromCredential(parsed[slot])
        if (providerKey) return providerKey
      }
    } catch {
      // Ignore malformed or unreadable auth files.
    }
  }

  return undefined
}
