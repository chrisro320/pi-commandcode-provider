/**
 * Multi-account support (fork-local).
 *
 * The upstream plugin registers a single `commandcode` provider whose API key
 * resolves from one env var and one `auth.json` slot. Command Code Go-plan
 * accounts have no formal API key — access rides on the browser `/login`
 * credential, and OMP installs any `registerProvider({ apiKey })` value as a
 * highest-priority config override (`#installProviderApiKey`) that shadows the
 * per-provider credential store. Reusing the global key for an alias therefore
 * pins account #2 to account #1 forever.
 *
 * Each account is registered as its own OMP provider name so `/login` stores a
 * distinct credential and request dispatch resolves a distinct key:
 *   - primary                    → provider "commandcode",      env COMMAND_CODE_API_KEY
 *   - COMMANDCODE_ACCOUNTS="b"   → provider "commandcode-b",    env COMMAND_CODE_API_KEY_B,
 *                                                            auth.json slot "commandcode-b"
 *
 * Aliases NEVER fall back to the primary env/slot. An unconfigured alias omits
 * its apiKey entirely so OMP resolves it from the `commandcode-b` credential
 * written by `/login`.
 */

export const PRIMARY_PROVIDER = "commandcode"

export interface CommandCodeAccount {
  /** OMP/pi provider name, e.g. "commandcode" or "commandcode-b". */
  provider: string
  /** Slash-command suffix: "" for the primary, "-b" for the alias. */
  commandSuffix: string
  /** True only for the primary "commandcode" account. */
  primary: boolean
  /** Env var names consulted for this account, in precedence order. */
  envNames: readonly string[]
}

function normalizeProviderSlug(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
  if (!slug) return ""
  return slug.startsWith("commandcode") ? slug : `commandcode-${slug}`
}

/**
 * Parse the account list from `COMMANDCODE_ACCOUNTS` (comma separated slugs).
 * Always returns the primary first; duplicates removed, order stable.
 */
export function parseAccounts(env: NodeJS.ProcessEnv = process.env): CommandCodeAccount[] {
  const accounts: CommandCodeAccount[] = [
    {
      provider: PRIMARY_PROVIDER,
      commandSuffix: "",
      primary: true,
      envNames: ["COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"],
    },
  ]
  const taken: Record<string, true> = { [PRIMARY_PROVIDER]: true }

  const extras = (env.COMMANDCODE_ACCOUNTS ?? "")
    .split(",")
    .map((part) => normalizeProviderSlug(part))
    .filter((part) => part.length > 0)

  for (const provider of extras) {
    if (taken[provider]) continue
    taken[provider] = true
    const slug = provider.slice("commandcode-".length)
    const suffix = slug.toUpperCase().replace(/[^A-Z0-9]/g, "_")
    accounts.push({
      provider,
      commandSuffix: `-${slug}`,
      primary: false,
      envNames: [`COMMAND_CODE_API_KEY_${suffix}`, `COMMANDCODE_API_KEY_${suffix}`],
    })
  }
  return accounts
}

/**
 * Is `provider` a Command Code provider (primary or any alias)? Durable domain
 * predicate for the message normalizer and compat router.
 */
export function isCommandCodeProvider(provider: string | undefined): boolean {
  if (!provider) return false
  return provider === PRIMARY_PROVIDER || provider.startsWith(`${PRIMARY_PROVIDER}-`)
}

/**
 * Credential scope for one `COMMANDCODE_ACCOUNTS` slug without parsing the
 * whole env list. `b` → provider `commandcode-b` with its own env names and
 * auth slot; the primary slug (`commandcode`) resolves the primary scope.
 * Used by the key pool so a slug entry reuses exactly the scopes that
 * per-account /login writes.
 */
export function accountForSlug(slug: string): Pick<
  CommandCodeAccount,
  "provider" | "commandSuffix" | "primary" | "envNames"
> & {
  slots: readonly string[]
} {
  const normalized = normalizeProviderSlug(slug)
  if (!normalized || normalized === PRIMARY_PROVIDER) {
    return {
      provider: PRIMARY_PROVIDER,
      commandSuffix: "",
      primary: true,
      envNames: ["COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"],
      slots: [PRIMARY_PROVIDER, "command-code"],
    }
  }
  const suffix = normalized
    .slice("commandcode-".length)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")
  return {
    provider: normalized,
    commandSuffix: `-${normalized.slice("commandcode-".length)}`,
    primary: false,
    envNames: [`COMMAND_CODE_API_KEY_${suffix}`, `COMMANDCODE_API_KEY_${suffix}`],
    slots: [normalized],
  }
}
