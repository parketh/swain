import { describe, expect, test } from "bun:test"
import { generatePkce, parseCallback } from "../src/codex-oauth"

describe("generatePkce", () => {
  test("verifier is 43+ url-safe chars, challenge is base64url, and it is random", () => {
    const { verifier, challenge } = generatePkce()
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,}$/)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(generatePkce().verifier).not.toBe(verifier)
  })
})

describe("parseCallback", () => {
  test("returns the code when state matches", () => {
    expect(parseCallback("http://localhost:1455/auth/callback?code=abc&state=st", "st")).toEqual({
      code: "abc",
    })
  })
  test("rejects a state mismatch", () => {
    expect(
      "error" in parseCallback("http://localhost:1455/auth/callback?code=abc&state=bad", "st"),
    ).toBe(true)
  })
  test("surfaces an oauth error param", () => {
    expect(
      "error" in
        parseCallback("http://localhost:1455/auth/callback?error=access_denied&state=st", "st"),
    ).toBe(true)
  })
})
