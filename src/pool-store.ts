/**
 * Persistent membership record for the key pool (fork feature).
 *
 * `COMMANDCODE_KEY_POOL` (env) seeds the pool at startup; once
 * `/commandcode-pool add|remove` mutates membership, this spec file becomes
 * the live record and takes precedence over the env value. Entries keep the
 * same syntax as the env var (literal key, account slug, or ENV var name),
 * re-resolved against env/auth.json on every load — so rotating a slug's
 * credential through `/login` still flows into the pool untouched.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"

export function loadPoolSpec(path: string): string[] | undefined {
  try {
    if (!existsSync(path)) return undefined
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
    if (!("entries" in parsed)) return undefined
    const entries: unknown = parsed.entries
    if (!Array.isArray(entries)) return undefined
    return entries
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  } catch {
    return undefined
  }
}

export function savePoolSpec(path: string, entries: readonly string[]): void {
  // Entries can carry literal keys, so keep auth.json's 0600 discipline.
  writeFileSync(path, `${JSON.stringify({ entries: [...entries] }, null, 2)}\n`, { mode: 0o600 })
}
