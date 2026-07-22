import { describe, expect, test } from "bun:test"
import type { ProviderConfig } from "../src/config"
import { collectSecrets, MIN_SECRET_LENGTH, makeRedactor, REDACTED } from "../src/redaction"

const LONG = "sk-ant-0123456789abcdef0123456789" // well over the threshold

describe("collectSecrets", () => {
  test("collects apiKey, accessToken, and refreshToken from config, deduplicated", () => {
    const providers: Record<string, ProviderConfig> = {
      anthropic: { apiKey: `${LONG}-a` },
      openai: { accessToken: `${LONG}-b`, refreshToken: `${LONG}-c` },
      // A duplicate value across providers collapses to one entry.
      kimi: { apiKey: `${LONG}-a` },
    }
    const secrets = collectSecrets(providers, {})
    expect(secrets).toContain(`${LONG}-a`)
    expect(secrets).toContain(`${LONG}-b`)
    expect(secrets).toContain(`${LONG}-c`)
    expect(secrets).toHaveLength(3)
  })

  test("includes supported environment credential overlays", () => {
    const secrets = collectSecrets({}, { MOONSHOT_API_KEY: `${LONG}-kimi` })
    expect(secrets).toContain(`${LONG}-kimi`)
  })

  test("ignores values shorter than the threshold", () => {
    const short = "x".repeat(MIN_SECRET_LENGTH - 1)
    const secrets = collectSecrets({ anthropic: { apiKey: short } }, {})
    expect(secrets).not.toContain(short)
  })
})

describe("makeRedactor", () => {
  test("replaces each occurrence of a secret within strings", () => {
    const redact = makeRedactor([`${LONG}-a`])
    expect(redact(`before ${LONG}-a after`)).toBe(`before ${REDACTED} after`)
  })

  test("redacts recursively through arrays and objects", () => {
    const redact = makeRedactor([`${LONG}-a`])
    const input = {
      role: "user",
      content: [{ type: "tool-result", result: { value: `key is ${LONG}-a here` } }],
    }
    const output = redact(input) as typeof input
    expect(JSON.stringify(output)).not.toContain(`${LONG}-a`)
    expect(output.content[0]!.result.value).toBe(`key is ${REDACTED} here`)
  })

  test("is identity when there are no secrets to redact", () => {
    const redact = makeRedactor([])
    const value = { a: "ordinary text" }
    expect(redact(value)).toBe(value)
  })

  test("does not corrupt ordinary short text", () => {
    const redact = makeRedactor(["ok"]) // below threshold, filtered out
    expect(redact("this is ok and fine")).toBe("this is ok and fine")
  })
})
