import { describe, expect, test } from "bun:test"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { LLMClient } from "@swain/llms/client"
import { OpenAICodex, type RefreshedCodexCredentials } from "@swain/llms/providers"
import { Effect, Layer, Stream } from "effect"

// A JWT is header.payload.signature; only the base64url payload is read.
const jwt = (payload: Record<string, unknown>): string =>
  `hdr.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`

const ACCOUNT_CLAIM = "https://api.openai.com/auth"
const EXPIRED = jwt({ exp: 1000, [ACCOUNT_CLAIM]: { chatgpt_account_id: "acct_old" } })
const FRESH = jwt({ exp: 9_999_999_999, [ACCOUNT_CLAIM]: { chatgpt_account_id: "acct_new" } })

interface Harness {
  readonly requests: Array<HttpClientRequest.HttpClientRequest>
  readonly layer: Layer.Layer<HttpClient.HttpClient>
}

// Routes the OAuth token endpoint to a JSON refresh response and the Codex
// responses endpoint to an empty SSE stream (enough to exercise the request).
const harness = (tokenBody: unknown): Harness => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push(request)
      const isToken = request.url.includes("/oauth/token")
      const body = isToken ? JSON.stringify(tokenBody) : "data: [DONE]\n\n"
      const contentType = isToken ? "application/json" : "text/event-stream"
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body, { status: 200, headers: { "content-type": contentType } }),
        ),
      )
    }),
  )
  return { requests, layer }
}

const runTurn = (
  config: Parameters<typeof OpenAICodex.configure>[0],
  layer: Layer.Layer<HttpClient.HttpClient>,
) => {
  const model = OpenAICodex.configure(config).model("gpt-5.5")
  const request = LLMClient.request({ model, prompt: "hi" })
  return Effect.runPromise(
    request.model.streamTurn(request).pipe(Stream.runDrain, Effect.provide(layer)),
  )
}

describe("OpenAICodex automatic token refresh", () => {
  test("refreshes an expired access token and reports the rotated credentials", async () => {
    const { requests, layer } = harness({ access_token: FRESH, refresh_token: "rt_new" })
    let refreshed: RefreshedCodexCredentials | undefined
    await runTurn(
      {
        credentialResolver: () => ({ accessToken: EXPIRED, refreshToken: "rt_old" }),
        onCredentialsRefreshed: (creds) => {
          refreshed = creds
        },
      },
      layer,
    )

    expect(requests.some((r) => r.url.includes("auth.openai.com/oauth/token"))).toBe(true)
    expect(refreshed).toEqual({
      accessToken: FRESH,
      refreshToken: "rt_new",
      accountId: "acct_new",
    })
    // The responses request uses the freshly minted access token, not the expired one.
    const responsesReq = requests.find((r) => r.url.includes("/codex/responses"))
    expect(responsesReq?.headers.authorization).toBe(`Bearer ${FRESH}`)
  })

  test("keeps the rotating refresh token when the endpoint omits a new one", async () => {
    const { layer } = harness({ access_token: FRESH })
    let refreshed: RefreshedCodexCredentials | undefined
    await runTurn(
      {
        credentialResolver: () => ({ accessToken: EXPIRED, refreshToken: "rt_old" }),
        onCredentialsRefreshed: (creds) => {
          refreshed = creds
        },
      },
      layer,
    )
    expect(refreshed?.refreshToken).toBe("rt_old")
  })

  test("does not refresh a still-valid access token", async () => {
    const { requests, layer } = harness({ access_token: FRESH, refresh_token: "rt_new" })
    let refreshedCalled = false
    await runTurn(
      {
        credentialResolver: () => ({ accessToken: FRESH, refreshToken: "rt_old" }),
        onCredentialsRefreshed: () => {
          refreshedCalled = true
        },
      },
      layer,
    )
    expect(requests.some((r) => r.url.includes("/oauth/token"))).toBe(false)
    expect(refreshedCalled).toBe(false)
  })

  test("does not refresh when no refresh token is available", async () => {
    const { requests, layer } = harness({ access_token: FRESH })
    await runTurn({ credentialResolver: () => ({ accessToken: EXPIRED }) }, layer)
    expect(requests.some((r) => r.url.includes("/oauth/token"))).toBe(false)
  })

  test("concurrent expired-token turns coalesce into a single token exchange", async () => {
    // A slow token endpoint keeps the owner's refresh in flight while the second
    // turn enters, so they must share one exchange rather than each rotating the
    // refresh token and invalidating the other.
    let tokenExchanges = 0
    const layer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const isToken = request.url.includes("/oauth/token")
        if (isToken) tokenExchanges += 1
        const body = isToken
          ? JSON.stringify({ access_token: FRESH, refresh_token: "rt_new" })
          : "data: [DONE]\n\n"
        const contentType = isToken ? "application/json" : "text/event-stream"
        const respond = Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(body, { status: 200, headers: { "content-type": contentType } }),
          ),
        )
        return isToken ? respond.pipe(Effect.delay("20 millis")) : respond
      }),
    )
    const config = { credentialResolver: () => ({ accessToken: EXPIRED, refreshToken: "rt_shared" }) }
    await Promise.all([runTurn(config, layer), runTurn(config, layer)])
    expect(tokenExchanges).toBe(1)
  })
})
