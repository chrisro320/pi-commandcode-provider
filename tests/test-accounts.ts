import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { getConfiguredApiKey } from "../src/api-key.ts"
import { getApiKey } from "../src/converters.ts"
import { isCommandCodeProvider, parseAccounts, PRIMARY_PROVIDER } from "../src/accounts.ts"
import { normalizeCommandCodeMessage } from "../src/overflow.ts"

describe("parseAccounts()", () => {
  it("returns the primary alone when COMMANDCODE_ACCOUNTS is unset", () => {
    const accounts = parseAccounts({})
    assert.equal(accounts.length, 1)
    assert.deepEqual(accounts[0], {
      provider: PRIMARY_PROVIDER,
      commandSuffix: "",
      primary: true,
      envNames: ["COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"],
    })
  })

  it("expands short slugs and full provider names identically", () => {
    const short = parseAccounts({ COMMANDCODE_ACCOUNTS: "b" })
    const full = parseAccounts({ COMMANDCODE_ACCOUNTS: "commandcode-b" })
    assert.deepEqual(short, full)
    assert.equal(short[1]?.provider, "commandcode-b")
    assert.equal(short[1]?.commandSuffix, "-b")
    assert.deepEqual(short[1]?.envNames, ["COMMAND_CODE_API_KEY_B", "COMMANDCODE_API_KEY_B"])
  })

  it("dedupes and keeps the primary first", () => {
    const accounts = parseAccounts({ COMMANDCODE_ACCOUNTS: "commandcode,b,b,c" })
    assert.deepEqual(
      accounts.map((account) => account.provider),
      ["commandcode", "commandcode-b", "commandcode-c"],
    )
  })

  it("slug with punctuation maps env suffix safely", () => {
    const accounts = parseAccounts({ COMMANDCODE_ACCOUNTS: "work-laptop" })
    assert.equal(accounts[1]?.provider, "commandcode-work-laptop")
    assert.deepEqual(accounts[1]?.envNames, [
      "COMMAND_CODE_API_KEY_WORK_LAPTOP",
      "COMMANDCODE_API_KEY_WORK_LAPTOP",
    ])
  })
})

describe("isCommandCodeProvider()", () => {
  it("accepts primary and aliases, rejects unrelated providers", () => {
    assert.equal(isCommandCodeProvider("commandcode"), true)
    assert.equal(isCommandCodeProvider("commandcode-b"), true)
    assert.equal(isCommandCodeProvider("openai"), false)
    assert.equal(isCommandCodeProvider(undefined), false)
  })
})

describe("alias key isolation", () => {
  const overflow = {
    role: "assistant",
    provider: "commandcode-b",
    stopReason: "error",
    errorMessage: "This model's context window is too large",
  }

  it("normalizes overflow errors on alias providers", () => {
    const normalized = normalizeCommandCodeMessage(overflow)
    assert.ok(normalized)
    assert.match(normalized.message.errorMessage, /^context_length_exceeded:/)
  })

  function authFileWith(contents: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "cc-accounts-"))
    const authPath = join(dir, "auth.json")
    writeFileSync(authPath, JSON.stringify(contents))
    return authPath
  }

  it("api-key reader: alias slot resolves, primary key never leaks", () => {
    const authPath = authFileWith({
      commandcode: { type: "api", key: "primary-key" },
      "commandcode-b": { type: "oauth", access: "alias-key" },
    })
    try {
      assert.equal(
        getConfiguredApiKey({
          env: {},
          authPaths: [authPath],
          envNames: ["COMMAND_CODE_API_KEY_B"],
          slots: ["commandcode-b"],
          allowLegacyGlobal: false,
        }),
        "alias-key",
      )
      // Bare legacy global apiKey field is primary-only.
      const legacy = authFileWith({ apiKey: "legacy-global", "commandcode-b": "alias-key" })
      assert.equal(
        getConfiguredApiKey({
          env: {},
          authPaths: [legacy],
          envNames: ["COMMAND_CODE_API_KEY_B"],
          slots: ["commandcode-b"],
          allowLegacyGlobal: false,
        }),
        "alias-key",
      )
      rmSync(legacy, { force: true })
    } finally {
      rmSync(authPath, { force: true })
      rmSync(join(authPath, ".."), { recursive: true, force: true })
    }
  })

  it("converters reader: alias env wins, no primary fallback", () => {
    assert.equal(
      getApiKey({
        env: { COMMAND_CODE_API_KEY: "primary-key", COMMAND_CODE_API_KEY_B: "alias-key" },
        authPaths: [],
        envNames: ["COMMAND_CODE_API_KEY_B"],
        slots: ["commandcode-b"],
        allowLegacyGlobal: false,
      }),
      "alias-key",
    )
    assert.equal(
      getApiKey({
        env: { COMMAND_CODE_API_KEY: "primary-key" },
        authPaths: [],
        envNames: ["COMMAND_CODE_API_KEY_B"],
        slots: ["commandcode-b"],
        allowLegacyGlobal: false,
      }),
      undefined,
    )
  })
})
