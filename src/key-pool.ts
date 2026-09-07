/**
 * API-key pool with automatic failover (fork feature).
 *
 * Command Code Go-plan accounts share one quota envelope per login; when one
 * account's credits or usage window runs out, every request on it fails until
 * the window resets. The pool keeps several keys behind the single
 * `commandcode` provider and transparently re-issues a request on the next
 * key when a failure is attributable to the key itself (quota exhausted,
 * rate limited, invalid credential) — before any streamed content has been
 * handed to the host, so the retry is invisible to the conversation.
 *
 * Two mechanisms:
 *   - reactive: a terminal error event classified as key-scoped cools the
 *     key down and the request is retried on the next candidate;
 *   - proactive: a startup/quota preflight reads each key's usage through
 *     the same endpoints `/commandcode-quota` uses, ranks healthy keys first
 *     and pre-cools keys whose window is already spent.
 *
 * Cooldowns are wall-clock bounds re-read on every selection, so an expired
 * cooldown re-admits the key instantly without timers or bookkeeping.
 */

import { getConfiguredApiKey } from "./api-key.ts"
import { accountForSlug } from "./accounts.ts"
import { commandCodeErrorMessage, normalizeCommandCodeErrorMessage } from "./overflow.ts"
import { fetchCommandCodeQuota } from "./quota.ts"
import type { CommandCodeQuotaResult } from "./quota-types.ts"
import type { AssistantMessageEvent, AssistantMessageEventStreamLike, ModelLike } from "./types.ts"

export const DEFAULT_QUOTA_COOLDOWN_MS = 5 * 60_000
export const DEFAULT_AUTH_COOLDOWN_MS = 60 * 60_000
export const MAX_COOLDOWN_MS = 6 * 60 * 60_000

export type PoolFailureKind = "quota" | "auth" | "other"

const QUOTA_PATTERNS = [
  /\bquota\b/i,
  /\brate[_\s-]*limit(?:ed|s)?\b/i,
  /\btoo\s+many\s+requests\b/i,
  /\bstatus(?:[_\s-]*code)?\s*[:=(]?\s*429\b/i,
  /\b429\b/,
  /\b(?:insufficient|exhausted?|depleted|out\s+of)\b[\s\S]{0,40}\b(?:credits?|balance|funds?|allowance|quota)\b/i,
  /\b(?:credits?|balance|funds?|allowance)\b[\s\S]{0,40}\b(?:insufficient|exhausted?|depleted|not\s+available)\b/i,
  /\b(?:reached|exceeded|hit)\b[\s\S]{0,24}\b(?:usage|cap)\b/i,
  /\b(?:five[\s_-]*hour|weekly|daily|monthly)\s+(?:usage\s+)?limit\b/i,
  /\bupgrade[_\s-]*required\b/i,
]

const AUTH_PATTERNS = [
  /\bstatus(?:[_\s-]*code)?\s*[:=(]?\s*40[13]\b/i,
  /\b40[13]\b/,
  /\bunauthorized\b/i,
  /\binvalid[_\s-]*(?:api[_\s-]*key|authorization|token|credential)\b/i,
  /\b(?:api[_\s-]*key|token|credential)\b[\s\S]{0,24}\b(?:invalid|expired|revoked|rejected)\b/i,
  /\brejected the api key\b/i,
]

const NON_KEY_PATTERNS = [/\baborted?\b/i, /\buser[_\s-]*(?:cancel|abort)\b/i]

const RETRY_AFTER_PATTERN =
  /\bretry(?:[_\s-]*after)?[^\d]{0,16}(\d+(?:\.\d+)?)\s*(ms|m(?:illi)?s(?:econds?)?|s(?:ec(?:onds?)?)?|m(?:in(?:utes?)?)?|h(?:ours?)?)/i

/**
 * Classify a redacted terminal-error message into the pool's reaction.
 * `quota` = the key is spent or throttled (cool down minutes; retry-after
 * text wins when present). `auth` = the credential itself is dead (cool down
 * an hour). `other` = not the key's fault (context overflow, abort, generic
 * 5xx); never cool or re-route on it.
 */
export function classifyPoolFailure(errorMessage: string | undefined): {
  kind: PoolFailureKind
  cooldownMs?: number
} {
  const text = errorMessage ?? ""
  if (!text) return { kind: "other" }
  // Context-window overflow shares wording with quota errors; the shared
  // normalizer already encodes the precedence rules (explicit quota/429
  // wording wins over overflow phrasing).
  if (normalizeCommandCodeErrorMessage(text)?.startsWith("context_length_exceeded:")) {
    return { kind: "other" }
  }
  const retryAfter = parseRetryAfterMs(text)
  if (QUOTA_PATTERNS.some((pattern) => pattern.test(text))) {
    return { kind: "quota", cooldownMs: clampCooldown(retryAfter ?? DEFAULT_QUOTA_COOLDOWN_MS) }
  }
  if (AUTH_PATTERNS.some((pattern) => pattern.test(text))) {
    return { kind: "auth", cooldownMs: clampCooldown(retryAfter ?? DEFAULT_AUTH_COOLDOWN_MS) }
  }
  if (NON_KEY_PATTERNS.some((pattern) => pattern.test(text))) return { kind: "other" }
  return { kind: "other" }
}

function clampCooldown(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_QUOTA_COOLDOWN_MS
  return Math.min(ms, MAX_COOLDOWN_MS)
}

function parseRetryAfterMs(text: string): number | undefined {
  const match = RETRY_AFTER_PATTERN.exec(text)
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value)) return undefined
  const unit = (match[2] ?? "s").toLowerCase()
  if (unit.startsWith("ms")) return value
  if (unit.startsWith("h")) return value * 3_600_000
  if (unit.startsWith("m")) return value * 60_000
  return value * 1000
}

/** Never echo a full credential: keep a short head and tail for humans. */
export function maskKey(key: string): string {
  if (key.length <= 12) return `[${key.slice(0, 3)}…]`
  return `${key.slice(0, 7)}…${key.slice(-4)}`
}

export interface PoolEntrySnapshot {
  /** Masked identifier, safe to print. */
  display: string
  /** Final key characters, for distinguishing colliding masks. */
  tail: string
  /** Account label from the quota probe (login / key name), when known. */
  label?: string
  /** Epoch ms until which the key is held out of rotation, when cooling. */
  cooldownUntil?: number
  /** Why the key is cooling / last observed usage line. */
  detail?: string
  probesOk: number
  probesFailed: number
}

interface KeyRecord {
  key: string
  label?: string
  detail?: string
  /** Requested hold time; effective only while in the future. */
  cooldownTarget?: number
  probesOk: number
  probesFailed: number
}

export interface KeyPool {
  /** Candidate order: preferred (last success) first, cooled keys last. */
  candidates(): string[]
  available(key: string): boolean
  noteFailure(key: string, kind: PoolFailureKind, cooldownMs?: number, detail?: string): void
  noteSuccess(key: string): void
  /** Attach probe metadata and optionally (re)cool until an absolute time. */
  annotate(key: string, info: { label?: string; detail?: string; cooldownUntil?: number }): void
  /** Record one quota-probe outcome for /commandcode-pool display. */
  noteProbe(key: string, ok: boolean): void
  /** Admit a new key at the end of the rotation (idempotent). */
  addKey(key: string): void
  /** Drop a key from rotation; returns false when it was never present. */
  removeKey(key: string): boolean
  /** Pin `key` as the next-used head of the rotation. */
  prefer(key: string): boolean
  /** Resolve a user query (1-based rotation index, label, or key tail). */
  find(query: string): string | undefined
  /** Configuration-time entries incl. unresolved ones; > keys().length when a spec entry failed. */
  entryCount(): number
  /** Reorder keys by preflight health; appends any key the order omits. */
  rank(ordered: readonly string[]): void
  snapshot(): readonly PoolEntrySnapshot[]
  keys(): string[]
}

/**
 * Mutable pool state: candidate order, sticky preference and wall-clock
 * cooldowns. A key whose cooldown has elapsed is available again the moment
 * selection re-reads `now`, so cooling needs no timers.
 */
export function createKeyPool(
  keys: readonly string[],
  options: { now?: () => number } = {},
): KeyPool {
  const now = options.now ?? Date.now
  let specCount = keys.length
  const records = new Map<string, KeyRecord>()
  for (const key of keys) {
    if (!records.has(key)) records.set(key, { key, probesOk: 0, probesFailed: 0 })
  }
  let preferredKey: string | undefined

  function activeCooldownUntil(key: string): number | undefined {
    const target = records.get(key)?.cooldownTarget
    return target !== undefined && target > now() ? target : undefined
  }

  return {
    candidates() {
      const all = [...records.keys()]
      const live = all.filter((key) => activeCooldownUntil(key) === undefined)
      const cold = all.filter((key) => activeCooldownUntil(key) !== undefined)
      if (preferredKey) {
        const index = live.indexOf(preferredKey)
        if (index > 0) {
          live.splice(index, 1)
          live.unshift(preferredKey)
        }
      }
      return [...live, ...cold]
    },
    available(key) {
      return activeCooldownUntil(key) === undefined
    },
    noteFailure(key, kind, cooldownMs, detail) {
      const record = records.get(key)
      if (!record || kind === "other") return
      const ms = clampCooldown(
        cooldownMs ?? (kind === "auth" ? DEFAULT_AUTH_COOLDOWN_MS : DEFAULT_QUOTA_COOLDOWN_MS),
      )
      record.cooldownTarget = now() + ms
      record.detail = detail
    },
    noteSuccess(key) {
      const record = records.get(key)
      if (!record) return
      record.cooldownTarget = undefined
      preferredKey = key
    },
    annotate(key, info) {
      const record = records.get(key)
      if (!record) return
      if (info.label !== undefined) record.label = info.label
      if (info.detail !== undefined) record.detail = info.detail
      if (info.cooldownUntil !== undefined) record.cooldownTarget = info.cooldownUntil
    },
    noteProbe(key, ok) {
      const record = records.get(key)
      if (!record) return
      if (ok) record.probesOk += 1
      else record.probesFailed += 1
    },
    addKey(key) {
      if (records.has(key)) return
      records.set(key, { key, probesOk: 0, probesFailed: 0 })
      specCount += 1
    },
    removeKey(key) {
      if (!records.delete(key)) return false
      if (preferredKey === key) preferredKey = undefined
      specCount = Math.max(0, specCount - 1)
      return true
    },
    prefer(key) {
      const record = records.get(key)
      if (!record) return false
      // An explicit user choice overrides any reactive cooling on that key.
      record.cooldownTarget = undefined
      preferredKey = key
      return true
    },
    find(query) {
      const rotation = this.candidates()
      const asIndex = Number(query)
      if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= rotation.length) {
        return rotation[asIndex - 1]
      }
      const needle = query.toLowerCase()
      const matches = rotation.filter((key) => {
        const record = records.get(key)
        return (
          (record?.label?.toLowerCase().includes(needle) ?? false) ||
          key.toLowerCase().endsWith(needle) ||
          maskKey(key).toLowerCase().includes(needle)
        )
      })
      return matches.length === 1 ? matches[0] : undefined
    },
    entryCount() {
      return specCount
    },
    rank(ordered) {
      const next = new Map<string, KeyRecord>()
      for (const key of ordered) {
        const record = records.get(key)
        if (record) next.set(key, record)
      }
      for (const [key, record] of records) if (!next.has(key)) next.set(key, record)
      records.clear()
      for (const [key, record] of next) records.set(key, record)
    },
    snapshot() {
      return [...records.values()].map((record) => ({
        display: maskKey(record.key),
        tail: record.key.slice(-4),
        label: record.label,
        cooldownUntil: activeCooldownUntil(record.key),
        detail: record.detail,
        probesOk: record.probesOk,
        probesFailed: record.probesFailed,
      }))
    },
    keys() {
      return [...records.keys()]
    },
  }
}

export interface FailoverDeps {
  createStream: () => AssistantMessageEventStreamLike
  model: ModelLike
  /** Ordered candidate keys to try for THIS request (pool.candidates()). */
  candidates: readonly string[]
  /** Start one attempt bound to `key`; returns its event stream. */
  attempt: (key: string) => AssistantMessageEventStreamLike
  available: (key: string) => boolean
  /** Cancellation from the host aborts failover: the stream is surfaced as-is. */
  aborted: () => boolean
  noteFailure: (
    key: string,
    kind: PoolFailureKind,
    cooldownMs: number | undefined,
    detail: string,
  ) => void
  noteSuccess: (key: string) => void
  classify?: typeof classifyPoolFailure
}

/**
 * Run one request across the pool. Events are forwarded live; a terminal
 * quota/auth error that arrives BEFORE any content is emitted cools the key
 * and re-issues the attempt on the next candidate. Once content has streamed
 * (or the host aborted, or the error is not key-scoped) the event is passed
 * through untouched — mid-stream failover would duplicate half a message.
 */
export function streamWithKeyPool(deps: FailoverDeps): AssistantMessageEventStreamLike {
  const output = deps.createStream()
  const classify = deps.classify ?? classifyPoolFailure
  const syntheticError = (message: string): Extract<AssistantMessageEvent, { type: "error" }> => ({
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api: deps.model.api,
      provider: deps.model.provider,
      model: deps.model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: message,
      timestamp: Date.now(),
    },
  })

  const run = async () => {
    const tried: string[] = []
    let lastError: Extract<AssistantMessageEvent, { type: "error" }> | undefined
    for (const key of deps.candidates) {
      if (!deps.available(key)) continue
      tried.push(key)
      const stream = deps.attempt(key)
      let pendingStart: AssistantMessageEvent | undefined
      let contentSeen = false
      let terminal: Extract<AssistantMessageEvent, { type: "done" | "error" }> | undefined
      for await (const event of stream) {
        if (event.type === "done" || event.type === "error") {
          terminal = event
          break
        }
        if (contentSeen) {
          output.push(event)
          continue
        }
        if (event.type === "start") {
          pendingStart = event
          continue
        }
        contentSeen = true
        if (pendingStart) {
          output.push(pendingStart)
          pendingStart = undefined
        }
        output.push(event)
      }

      if (!terminal) {
        // Attempt ended without a terminal event; nothing to fail over from.
        if (pendingStart) output.push(pendingStart)
        output.end()
        return
      }
      if (terminal.type === "done") {
        if (pendingStart) output.push(pendingStart)
        deps.noteSuccess(key)
        output.push(terminal)
        output.end()
        return
      }

      const message = commandCodeErrorMessage(terminal.error.errorMessage ?? terminal.error) ?? ""
      const { kind, cooldownMs } = classify(message || undefined)
      const retryable =
        kind !== "other" && !contentSeen && !deps.aborted() && deps.candidates.length > 1
      if (!retryable) {
        output.push(terminal)
        output.end()
        return
      }
      deps.noteFailure(key, kind, cooldownMs, message)
      lastError = terminal
    }

    if (lastError) {
      const extra =
        tried.length < deps.candidates.length
          ? "all remaining pool keys are cooling down; retry later or run /commandcode-pool"
          : "every pool key failed; retry later or run /commandcode-pool"
      const previous = lastError.error.errorMessage
      output.push({
        ...lastError,
        error: {
          ...lastError.error,
          errorMessage: previous ? `${previous} — ${extra}` : `Command Code pool: ${extra}`,
        },
      })
      output.end()
      return
    }
    output.push(
      syntheticError(
        "No Command Code pool key is available (all keys are cooling down). Run /commandcode-pool for status.",
      ),
    )
    output.end()
  }
  run().catch((error: unknown) => {
    output.push(syntheticError(error instanceof Error ? error.message : String(error)))
    output.end()
  })
  return output
}

export interface ResolvedPoolEntry {
  /** Original spec token from COMMANDCODE_KEY_POOL. */
  entry: string
  key?: string
  error?: string
}

/**
 * Resolve `COMMANDCODE_KEY_POOL` entries to concrete keys. Each entry is one of:
 *   - a literal key (starts with `user_`/`cc_`),
 *   - an account slug reusing the multi-account scopes (`b` →
 *     COMMAND_CODE_API_KEY_B / auth.json slot `commandcode-b`; the slug
 *     `commandcode` resolves the primary scope),
 *   - an ENV VAR NAME in upper snake case holding the key.
 * Order is preserved and duplicates removed; unresolved entries report a
 * per-entry error so a typo never silently drops a credential from the pool.
 */
export function resolvePoolEntries(
  entries: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  authPaths?: readonly string[],
): ResolvedPoolEntry[] {
  const seen = new Set<string>()
  return entries.map((rawEntry) => {
    const entry = rawEntry.trim()
    if (!entry) return { entry: rawEntry, error: "empty entry" }
    let key: string | undefined
    if (/^(?:user_|cc_)/.test(entry)) {
      key = entry
    } else if (/^[A-Z][A-Z0-9_]*$/.test(entry)) {
      key = env[entry]?.trim() || undefined
      if (!key) return { entry, error: `env var ${entry} is not set` }
    } else {
      const account = accountForSlug(entry)
      key = getConfiguredApiKey({
        env,
        authPaths,
        envNames: account.envNames,
        slots: account.slots,
        allowLegacyGlobal: false,
      })
      if (!key) return { entry, error: `no key configured for account "${entry}"` }
    }
    if (seen.has(key)) return { entry, key }
    seen.add(key)
    return { entry, key }
  })
}

export interface PoolProbeResult {
  key: string
  ok: boolean
  /** Healthy keys are sorted by this headroom score, descending. */
  score: number
  label?: string
  detail?: string
  /** Healthy-but-spent key: hold out of rotation until this instant. */
  cooldownUntil?: number
}

/**
 * Summarize one quota payload into pool ranking data: `score` orders healthy
 * keys (most remaining credits first); a key whose credits or usage window is
 * already spent is pre-cooled using the API's own reset time.
 */
export function probeFromQuota(
  key: string,
  result: CommandCodeQuotaResult,
  now: () => number = Date.now,
): PoolProbeResult {
  if (!result.ok) {
    return { key, ok: false, score: 0, detail: result.error.message }
  }
  const { credits, account } = result.quota
  const label = [account.login, account.keyName].filter(Boolean).join("/") || undefined
  const current = now()
  const windows = credits?.windowLimits ?? []
  const blocked = windows.filter((limit) => limit.cap > 0 && limit.used >= limit.cap)
  if (blocked.length > 0) {
    const resets = blocked.map((limit) => (limit.resetAt ?? 0) * 1000).filter((ms) => ms > current)
    const until = resets.length > 0 ? Math.min(...resets) : current + DEFAULT_QUOTA_COOLDOWN_MS
    const names = blocked.map((limit) => limit.window).join(", ")
    return {
      key,
      ok: true,
      score: 0,
      label,
      detail: `window limit reached (${names})`,
      cooldownUntil: until,
    }
  }
  const remaining = credits?.remainingCredits
  if (remaining !== undefined && remaining <= 0) {
    return {
      key,
      ok: true,
      score: 0,
      label,
      detail: "no credits remaining",
      cooldownUntil: current + DEFAULT_QUOTA_COOLDOWN_MS,
    }
  }
  const usedParts = windows.map(
    (limit) => `${limit.window} ${Math.round((limit.used / Math.max(limit.cap, 1)) * 100)}%`,
  )
  const creditsPart = remaining === undefined ? "" : `$${remaining.toFixed(2)} left`
  return {
    key,
    ok: true,
    score: remaining ?? 1,
    label,
    detail: [creditsPart, ...usedParts].filter(Boolean).join(" · ") || "quota ok",
  }
}

export interface PreflightDeps {
  pool: KeyPool
  baseUrl: string
  fetchQuota?: typeof fetchCommandCodeQuota
  extraHeaders?: Record<string, string>
  now?: () => number
  /** Pool keys to probe; defaults to the pool's current key set. */
  keys?: readonly string[]
}

/**
 * Probe every pool key's quota concurrently and apply the outcome: healthy
 * keys ranked most-headroom-first, exhausted keys cooled until their window
 * reset, labels/details cached for `/commandcode-pool`. A failed probe never
 * removes a key (unknown ≠ exhausted) but is counted for status display.
 * Never throws.
 */
export async function preflightKeyPool(deps: PreflightDeps): Promise<readonly PoolProbeResult[]> {
  const fetchQuota = deps.fetchQuota ?? fetchCommandCodeQuota
  const now = deps.now ?? Date.now
  const keys = deps.keys ?? deps.pool.keys()
  const results = await Promise.all(
    keys.map(async (key) => {
      try {
        const result = await fetchQuota({
          apiKey: key,
          baseUrl: deps.baseUrl,
          extraHeaders: deps.extraHeaders,
        })
        return probeFromQuota(key, result, now)
      } catch (error) {
        return {
          key,
          ok: false,
          score: 0,
          detail: error instanceof Error ? error.message : String(error),
        } satisfies PoolProbeResult
      }
    }),
  )
  for (const probe of results) {
    deps.pool.noteProbe(probe.key, probe.ok)
    deps.pool.annotate(probe.key, {
      label: probe.label,
      detail: probe.detail,
      cooldownUntil: probe.cooldownUntil,
    })
  }
  const healthy = results
    .filter((probe) => probe.ok && probe.cooldownUntil === undefined)
    .sort((a, b) => b.score - a.score)
    .map((probe) => probe.key)
  if (healthy.length > 0) deps.pool.rank(healthy)
  return results
}
