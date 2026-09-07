import assert from "node:assert/strict"
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  classifyPoolFailure,
  createKeyPool,
  maskKey,
  preflightKeyPool,
  probeFromQuota,
  resolvePoolEntries,
  streamWithKeyPool,
} from "../src/key-pool.ts"
import { loadPoolSpec, savePoolSpec } from "../src/pool-store.ts"
import type { CommandCodeQuota, CommandCodeQuotaResult } from "../src/quota-types.ts"
import type { AssistantMessageEvent, AssistantMessageEventStreamLike } from "../src/types.ts"
import { collectEvents, createTestEventStream, makeContext, makeModel } from "./helpers.ts"

function errorStream(message: string): AssistantMessageEventStreamLike {
  const stream = createTestEventStream()
  stream.push({
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api: "commandcode-custom",
      provider: "commandcode",
      model: "m",
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
      timestamp: 0,
    },
  })
  stream.end()
  return stream
}

function completedStream(text: string, withStart = true): AssistantMessageEventStreamLike {
  const stream = createTestEventStream()
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "commandcode-custom",
    provider: "commandcode",
    model: "m",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: 0,
  }
  const events: AssistantMessageEvent[] = [
    ...(withStart ? [{ type: "start" as const, partial: message }] : []),
    { type: "text_delta" as const, contentIndex: 0, delta: text, partial: message },
    { type: "done" as const, reason: "stop" as const, message },
  ]
  for (const event of events) stream.push(event)
  stream.end()
  return stream
}

describe("classifyPoolFailure()", () => {
  it("classifies quota exhaustion", () => {
    assert.equal(classifyPoolFailure("API Error: 429 quota exceeded for this key").kind, "quota")
    assert.equal(classifyPoolFailure("insufficient credits").kind, "quota")
    assert.equal(classifyPoolFailure("weekly usage limit reached").kind, "quota")
    assert.equal(classifyPoolFailure("status: 402 payment required").kind, "other")
  })

  it("classifies dead credentials as auth", () => {
    assert.equal(classifyPoolFailure("401 Unauthorized").kind, "auth")
    assert.equal(classifyPoolFailure("invalid_api_key: the key was revoked").kind, "auth")
  })

  it("keeps non-key failures out of the pool", () => {
    assert.equal(
      classifyPoolFailure("context_length_exceeded: This model's context window is too large").kind,
      "other",
    )
    assert.equal(classifyPoolFailure("Request aborted").kind, "other")
    assert.equal(classifyPoolFailure("502 Bad Gateway").kind, "other")
    assert.equal(classifyPoolFailure(undefined).kind, "other")
  })

  it("honours retry-after text over the default cooldown", () => {
    const quota = classifyPoolFailure("rate limit exceeded — retry after 90s")
    assert.equal(quota.kind, "quota")
    assert.equal(quota.cooldownMs, 90_000)
    const auth = classifyPoolFailure("401 Unauthorized")
    assert.equal(auth.cooldownMs, 60 * 60_000)
    const generic = classifyPoolFailure("quota exhausted")
    assert.equal(generic.cooldownMs, 5 * 60_000)
  })
})

describe("maskKey()", () => {
  it("never exposes the whole credential", () => {
    const masked = maskKey("user_abcdefghijklmnopqrstuvwxyz")
    assert.ok(masked.startsWith("user_ab"))
    assert.ok(masked.endsWith("wxyz"))
    assert.ok(!masked.includes("cdefgh"))
  })
})

describe("createKeyPool()", () => {
  function clock() {
    let now = 1_000_000
    return { now: () => now, advance: (ms: number) => (now += ms) }
  }

  it("cools a failed key and re-admits it after the wall-clock bound", () => {
    const time = clock()
    const pool = createKeyPool(["k1", "k2"], { now: time.now })
    pool.noteFailure("k1", "quota", 60_000)
    assert.deepEqual(pool.candidates(), ["k2", "k1"])
    assert.equal(pool.available("k1"), false)
    time.advance(60_000)
    assert.equal(pool.available("k1"), true)
    assert.deepEqual(pool.candidates(), ["k1", "k2"])
  })

  it("ignores non-key failures", () => {
    const time = clock()
    const pool = createKeyPool(["k1", "k2"], { now: time.now })
    pool.noteFailure("k1", "other", undefined)
    assert.equal(pool.available("k1"), true)
  })

  it("prefers the last success", () => {
    const time = clock()
    const pool = createKeyPool(["k1", "k2"], { now: time.now })
    pool.noteSuccess("k2")
    assert.equal(pool.candidates()[0], "k2")
    pool.noteFailure("k2", "quota", 10_000)
    assert.equal(pool.candidates()[0], "k1")
  })

  it("ranks preflight order and keeps unknown keys last", () => {
    const time = clock()
    const pool = createKeyPool(["k1", "k2", "k3"], { now: time.now })
    pool.rank(["k3", "k1"])
    assert.deepEqual(pool.candidates(), ["k3", "k1", "k2"])
  })

  it("records probe stats and masked display", () => {
    const time = clock()
    const pool = createKeyPool(["user_abcdefghijklmnopqrstuvwxyz"], { now: time.now })
    pool.noteProbe("user_abcdefghijklmnopqrstuvwxyz", true)
    pool.annotate("user_abcdefghijklmnopqrstuvwxyz", { label: "alice", detail: "$9 left" })
    const [entry] = pool.snapshot()
    assert.equal(entry?.probesOk, 1)
    assert.equal(entry?.label, "alice")
    assert.equal(entry?.detail, "$9 left")
    assert.ok(!JSON.stringify(pool.snapshot()).includes("cdefgh"))
    assert.equal(pool.entryCount(), 1)
  })

  it("adds, prefers and removes keys", () => {
    const time = clock()
    const pool = createKeyPool(["k1", "k2"], { now: time.now })
    pool.addKey("k3")
    pool.addKey("k3")
    assert.deepEqual(pool.keys(), ["k1", "k2", "k3"])
    assert.equal(pool.entryCount(), 3)
    assert.ok(pool.prefer("k3"))
    assert.equal(pool.candidates()[0], "k3")
    pool.noteFailure("k1", "quota", 30_000)
    assert.equal(pool.available("k1"), false)
    // Prefer is a user override: it clears cooldown and pins the head.
    assert.ok(pool.prefer("k1"))
    assert.equal(pool.available("k1"), true)
    assert.equal(pool.candidates()[0], "k1")
    assert.ok(pool.removeKey("k2"))
    assert.ok(!pool.removeKey("nope"))
    assert.deepEqual(pool.keys(), ["k1", "k3"])
    assert.equal(pool.entryCount(), 2)
  })

  it("find resolves index, label and key tail", () => {
    const time = clock()
    const pool = createKeyPool(["user_aaaa1111", "user_bbbb2222"], { now: time.now })
    pool.annotate("user_bbbb2222", { label: "work" })
    assert.equal(pool.find("2"), "user_bbbb2222")
    assert.equal(pool.find("1"), "user_aaaa1111")
    assert.equal(pool.find("work"), "user_bbbb2222")
    assert.equal(pool.find("2222"), "user_bbbb2222")
    assert.equal(pool.find("3"), undefined)
    assert.equal(pool.find("nope"), undefined)
  })
})

describe("resolvePoolEntries()", () => {
  it("resolves literal keys, env names and account slugs", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-pool-"))
    try {
      const authPath = join(dir, "auth.json")
      writeFileSync(
        authPath,
        JSON.stringify({ "commandcode-b": { type: "api", key: "user_bbbb111122223333" } }),
      )
      const resolved = resolvePoolEntries(
        ["user_litteral00001111", "EXTRA_POOL_KEY", "b", "MISSING_POOL_KEY", "nope-account"],
        { EXTRA_POOL_KEY: "user_envvvvvvv2222" },
        [authPath],
      )
      assert.equal(resolved[0]?.key, "user_litteral00001111")
      assert.equal(resolved[1]?.key, "user_envvvvvvv2222")
      assert.equal(resolved[2]?.key, "user_bbbb111122223333")
      assert.equal(resolved[3]?.error, "env var MISSING_POOL_KEY is not set")
      assert.match(resolved[4]?.error ?? "", /no key configured for account "nope-account"/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("dedupes identical keys and keeps order", () => {
    const resolved = resolvePoolEntries(["user_aaaa00001111", "USER_B", "user_aaaa00001111"], {
      USER_B: "user_aaaa00001111",
    })
    assert.equal(resolved[0]?.key, "user_aaaa00001111")
    assert.equal(resolved[1]?.key, "user_aaaa00001111")
  })
})

describe("probeFromQuota()", () => {
  function quotaResult(overrides: Partial<CommandCodeQuota> = {}): CommandCodeQuotaResult {
    return {
      ok: true,
      quota: {
        account: { login: "alice", orgId: null, keyName: "main" },
        credits: {
          monthlyCredits: 10,
          purchasedCredits: 0,
          freeCredits: 0,
          remainingCredits: 5,
          windowLimits: [],
        },
        subscription: null,
        summary: null,
        ...overrides,
      },
    }
  }

  it("scores healthy keys by remaining credits", () => {
    const probe = probeFromQuota("k1", quotaResult(), () => 0)
    assert.equal(probe.ok, true)
    assert.equal(probe.score, 5)
    assert.equal(probe.label, "alice/main")
    assert.equal(probe.cooldownUntil, undefined)
  })

  it("pre-cools an exhausted window until its reset instant", () => {
    const probe = probeFromQuota(
      "k1",
      quotaResult({
        credits: {
          monthlyCredits: 10,
          purchasedCredits: 0,
          freeCredits: 0,
          remainingCredits: 5,
          windowLimits: [{ window: "fiveHour", used: 10, cap: 10, resetAt: 5_000 }],
        },
      }),
      () => 1_000,
    )
    assert.equal(probe.ok, true)
    assert.equal(probe.score, 0)
    assert.equal(probe.cooldownUntil, 5_000_000)
    assert.match(probe.detail ?? "", /fiveHour/)
  })

  it("keeps failed probes as unknown, not exhausted", () => {
    const probe = probeFromQuota("k1", {
      ok: false,
      error: { kind: "network", message: "offline" },
    })
    assert.equal(probe.ok, false)
    assert.equal(probe.cooldownUntil, undefined)
    assert.equal(probe.detail, "offline")
  })
})

describe("preflightKeyPool()", () => {
  it("ranks healthy keys, cools exhausted ones, counts failures", async () => {
    const pool = createKeyPool(["kLow", "kHigh", "kDead", "kErr"])
    const results = await preflightKeyPool({
      pool,
      baseUrl: "https://test",
      fetchQuota: async (options) => {
        if (options.apiKey === "kErr") throw new Error("boom")
        if (options.apiKey === "kDead") {
          return {
            ok: true,
            quota: {
              account: { login: "dead", orgId: null },
              credits: {
                monthlyCredits: 0,
                purchasedCredits: 0,
                freeCredits: 0,
                remainingCredits: 0,
                windowLimits: [],
              },
              subscription: null,
              summary: null,
            },
          }
        }
        return {
          ok: true,
          quota: {
            account: { login: options.apiKey, orgId: null },
            credits: {
              monthlyCredits: 0,
              purchasedCredits: 0,
              freeCredits: 0,
              remainingCredits: options.apiKey === "kHigh" ? 9 : 1,
              windowLimits: [],
            },
            subscription: null,
            summary: null,
          },
        }
      },
    })
    assert.deepEqual(pool.candidates(), ["kHigh", "kLow", "kErr", "kDead"])
    assert.equal(pool.available("kDead"), false)
    assert.equal(pool.available("kErr"), true)
    const byDisplay = new Map(pool.snapshot().map((entry) => [entry.display, entry]))
    assert.equal(byDisplay.get(maskKey("kHigh"))?.probesOk, 1)
    assert.equal(byDisplay.get(maskKey("kErr"))?.probesFailed, 1)
    assert.equal(byDisplay.get(maskKey("kDead"))?.label, "dead")
  })
})

describe("streamWithKeyPool()", () => {
  it("re-issues a quota failure on the next key before any content", async () => {
    const pool = createKeyPool(["kBad", "kGood"])
    const attempts: string[] = []
    const stream = streamWithKeyPool({
      createStream: createTestEventStream,
      model: makeModel(),
      candidates: pool.candidates(),
      attempt: (key) => {
        attempts.push(key)
        return key === "kBad" ? errorStream("429 quota exceeded") : completedStream("ok")
      },
      available: (key) => pool.available(key),
      aborted: () => false,
      noteFailure: (key, kind, ms, detail) => pool.noteFailure(key, kind, ms, detail),
      noteSuccess: (key) => pool.noteSuccess(key),
    })
    const events = await collectEvents(stream)
    assert.deepEqual(attempts, ["kBad", "kGood"])
    assert.equal(events.at(-1)?.type, "done")
    assert.equal(pool.available("kBad"), false)
    assert.equal(pool.available("kGood"), true)
  })

  it("never fails over once content has streamed", async () => {
    const pool = createKeyPool(["k1", "k2"])
    const attempts: string[] = []
    const halfStream = (): AssistantMessageEventStreamLike => {
      const stream = createTestEventStream()
      const message = {
        role: "assistant" as const,
        content: [],
        api: "x",
        provider: "commandcode",
        model: "m",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error" as const,
        errorMessage: "429 quota exceeded mid-stream",
        timestamp: 0,
      }
      stream.push({ type: "text_delta", contentIndex: 0, delta: "hal", partial: message })
      stream.push({ type: "error", reason: "error", error: message })
      stream.end()
      return stream
    }
    const stream = streamWithKeyPool({
      createStream: createTestEventStream,
      model: makeModel(),
      candidates: pool.candidates(),
      attempt: (key) => {
        attempts.push(key)
        return halfStream()
      },
      available: (key) => pool.available(key),
      aborted: () => false,
      noteFailure: (key, kind, ms, detail) => pool.noteFailure(key, kind, ms, detail),
      noteSuccess: (key) => pool.noteSuccess(key),
    })
    const events = await collectEvents(stream)
    assert.equal(attempts.length, 1)
    assert.equal(
      events.some((event) => event.type === "text_delta"),
      true,
    )
    assert.equal(events.at(-1)?.type, "error")
    assert.equal(pool.available("k1"), true)
  })

  it("passes non-key errors through untouched", async () => {
    const pool = createKeyPool(["k1", "k2"])
    const attempts: string[] = []
    const stream = streamWithKeyPool({
      createStream: createTestEventStream,
      model: makeModel(),
      candidates: pool.candidates(),
      attempt: (key) => {
        attempts.push(key)
        return errorStream("500 internal server error")
      },
      available: (key) => pool.available(key),
      aborted: () => false,
      noteFailure: (key, kind, ms, detail) => pool.noteFailure(key, kind, ms, detail),
      noteSuccess: (key) => pool.noteSuccess(key),
    })
    const events = await collectEvents(stream)
    assert.equal(attempts.length, 1)
    assert.equal(events.at(-1)?.type, "error")
  })

  it("surfaces the raw error when the host aborted", async () => {
    const pool = createKeyPool(["k1", "k2"])
    const attempts: string[] = []
    const stream = streamWithKeyPool({
      createStream: createTestEventStream,
      model: makeModel(),
      candidates: pool.candidates(),
      attempt: (key) => {
        attempts.push(key)
        return errorStream("429 quota exceeded")
      },
      available: (key) => pool.available(key),
      aborted: () => true,
      noteFailure: (key, kind, ms, detail) => pool.noteFailure(key, kind, ms, detail),
      noteSuccess: (key) => pool.noteSuccess(key),
    })
    await collectEvents(stream)
    assert.equal(attempts.length, 1)
  })

  it("reports pool exhaustion when every key failed", async () => {
    const pool = createKeyPool(["k1", "k2"])
    const stream = streamWithKeyPool({
      createStream: createTestEventStream,
      model: makeModel(),
      candidates: pool.candidates(),
      attempt: () => errorStream("429 quota exceeded"),
      available: (key) => pool.available(key),
      aborted: () => false,
      noteFailure: (key, kind, ms, detail) => pool.noteFailure(key, kind, ms, detail),
      noteSuccess: (key) => pool.noteSuccess(key),
    })
    const events = await collectEvents(stream)
    const last = events.at(-1)
    assert.equal(last?.type, "error")
    if (last?.type === "error") {
      assert.match(last.error.errorMessage ?? "", /every pool key failed/)
    }
    assert.equal(pool.available("k1"), false)
    assert.equal(pool.available("k2"), false)
  })

  it("works unchanged for a single-key pool", async () => {
    const pool = createKeyPool(["only"])
    const stream = streamWithKeyPool({
      createStream: createTestEventStream,
      model: makeModel(),
      candidates: pool.candidates(),
      attempt: () => completedStream("hi"),
      available: (key) => pool.available(key),
      aborted: () => false,
      noteFailure: (key, kind, ms, detail) => pool.noteFailure(key, kind, ms, detail),
      noteSuccess: (key) => pool.noteSuccess(key),
    })
    const events = await collectEvents(stream)
    assert.equal(events.at(-1)?.type, "done")
  })
})

describe("pool-store", () => {
  it("round-trips entries and rejects malformed files", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-pool-spec-"))
    try {
      const path = join(dir, "commandcode-key-pool.json")
      assert.equal(loadPoolSpec(path), undefined)
      savePoolSpec(path, ["commandcode", "alt", " user_x "])
      assert.deepEqual(loadPoolSpec(path), ["commandcode", "alt", "user_x"])
      writeFileSync(path, "{not json")
      assert.equal(loadPoolSpec(path), undefined)
      writeFileSync(path, JSON.stringify({ nope: 1 }))
      assert.equal(loadPoolSpec(path), undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("saves with owner-only mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-pool-mode-"))
    try {
      const path = join(dir, "commandcode-key-pool.json")
      savePoolSpec(path, ["user_aaaa"])
      assert.equal(statSync(path).mode & 0o777, 0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
