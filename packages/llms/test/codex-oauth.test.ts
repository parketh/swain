import { describe, expect, test } from "bun:test"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { buildAuthorizeUrl, exchangeCode, OPENAI_CODEX_REDIRECT_URI } from "@swain/llms/providers"
import { Effect, Layer } from "effect"

// A JWT is header.payload.signature; only the base64url payload is read.
const jwt = (payload: Record<string, unknown>): string =>
  `hdr.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`

const ACCOUNT_CLAIM = "https://api.openai.com/auth"
const FRESH = jwt({ exp: 9_999_999_999, [ACCOUNT_CLAIM]: { chatgpt_account_id: "acct_new" } })

interface Harness {
  readonly requests: Array<HttpClientRequest.HttpClientRequest>
  readonly layer: Layer.Layer<HttpClient.HttpClient>
}

const harness = (tokenBody: unknown): Harness => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push(request)
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(tokenBody), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      )
    }),
  )
  return { requests, layer }
}

describe("buildAuthorizeUrl", () => {
  test("includes the server-required params", () => {
    const url = new URL(buildAuthorizeUrl({ codeChallenge: "chal", state: "st" }))
    const q = url.searchParams
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize")
    expect(q.get("response_type")).toBe("code")
    expect(q.get("code_challenge")).toBe("chal")
    expect(q.get("code_challenge_method")).toBe("S256")
    expect(q.get("state")).toBe("st")
    expect(q.get("redirect_uri")).toBe(OPENAI_CODEX_REDIRECT_URI)
    expect(q.get("codex_cli_simplified_flow")).toBe("true")
    expect(q.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann")
    expect(q.get("scope")).toBe("openid profile email offline_access")
    expect(q.get("originator")).toBe("codex_cli_rs")
  })
})

describe("exchangeCode", () => {
  test("exchanges an auth code for rotated credentials", async () => {
    const { requests, layer } = harness({ access_token: FRESH, refresh_token: "rt_new" })
    const creds = await Effect.runPromise(
      exchangeCode("auth_code", "verifier").pipe(Effect.provide(layer)),
    )
    expect(creds).toEqual({ accessToken: FRESH, refreshToken: "rt_new", accountId: "acct_new" })
    expect(requests.find((r) => r.url.includes("/oauth/token"))).toBeDefined()
  })

  test("fails with a typed auth error (not a defect) when the token body is null", async () => {
    const { layer } = harness(null)
    const error = await Effect.runPromise(
      exchangeCode("auth_code", "verifier").pipe(Effect.provide(layer), Effect.flip),
    )
    expect(error._tag).toBe("LLMError")
  })
})
