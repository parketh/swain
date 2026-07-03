import { describe, expect, test } from "bun:test"
import { HttpClient, HttpClientError, HttpClientResponse } from "@effect/platform"
import type { HttpClientRequest } from "@effect/platform"
import { Duration, Effect, Layer, Stream } from "effect"
import { LLMError } from "@swain/llms"
import { Auth, Http } from "@swain/llms/transport"

const stubClient = (
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  )

const sseResponse = (request: HttpClientRequest.HttpClientRequest, body: string, status = 200) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(body, { status, headers: { "content-type": "text/event-stream" } }),
    ),
  )

const runFailure = (
  request: HttpClientRequest.HttpClientRequest,
  layer: Layer.Layer<HttpClient.HttpClient>,
) =>
  Effect.runPromise(
    Http.streamSseJson(request).pipe(Stream.runCollect, Effect.flip, Effect.provide(layer)),
  )

describe("Auth", () => {
  test("resolveSecret prefers explicit value over env", async () => {
    process.env.SWAIN_TEST_KEY = "from-env"
    const value = await Effect.runPromise(
      Auth.resolveSecret({ value: "explicit", env: "SWAIN_TEST_KEY", subject: "test" }),
    )
    expect(value).toBe("explicit")
  })

  test("resolveSecret falls back to env", async () => {
    process.env.SWAIN_TEST_KEY = "from-env"
    const value = await Effect.runPromise(
      Auth.resolveSecret({ env: "SWAIN_TEST_KEY", subject: "test" }),
    )
    expect(value).toBe("from-env")
  })

  test("missing credentials fail with auth-failed", async () => {
    delete process.env.SWAIN_TEST_MISSING
    const error = await Effect.runPromise(
      Auth.resolveSecret({ env: "SWAIN_TEST_MISSING", subject: "test" }).pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(LLMError)
    expect(error.reason).toBe("auth-failed")
  })

  test("mergeHeaders merges without mutating inputs", () => {
    const base = { a: "1", b: "2" }
    const extra = { b: "3", c: "4" }
    const merged = Auth.mergeHeaders(base, undefined, extra)
    expect(merged).toEqual({ a: "1", b: "3", c: "4" })
    expect(base).toEqual({ a: "1", b: "2" })
    expect(extra).toEqual({ b: "3", c: "4" })
  })

  test("toHeaders renders bearer and static header auth", () => {
    expect(Auth.toHeaders(Auth.none)).toEqual({})
    expect(Auth.toHeaders(Auth.bearer("tok"))).toEqual({ Authorization: "Bearer tok" })
    expect(Auth.toHeaders(Auth.header("x-api-key", "k"))).toEqual({ "x-api-key": "k" })
  })
})

describe("Http.prepareJson", () => {
  test("builds method, URL, headers, and JSON body without network", async () => {
    const request = Http.prepareJson({
      url: "https://api.example.com/v1/chat/completions",
      headers: { Authorization: "Bearer tok" },
      body: { model: "m", stream: true },
    })
    expect(request.method).toBe("POST")
    expect(request.url).toBe("https://api.example.com/v1/chat/completions")
    expect(request.headers.authorization).toBe("Bearer tok")
    expect(request.headers["content-type"]).toBe("application/json")
    const body = request.body
    expect(body._tag).toBe("Uint8Array")
    if (body._tag === "Uint8Array") {
      expect(JSON.parse(new TextDecoder().decode(body.body))).toEqual({
        model: "m",
        stream: true,
      })
    }
  })
})

describe("Http.streamSseJson", () => {
  test("streams parsed SSE JSON values and stops at [DONE]", async () => {
    const layer = stubClient((request) =>
      sseResponse(
        request,
        'data: {"n":1}\n\nevent: delta\ndata: {"n":2}\n\ndata: [DONE]\n\ndata: {"n":3}\n\n',
      ),
    )
    const request = Http.prepareJson({ url: "https://api.example.com/x", body: {} })
    const events = await Effect.runPromise(
      Http.streamSseJson(request).pipe(Stream.runCollect, Effect.provide(layer)),
    )
    expect(Array.from(events)).toEqual([{ json: { n: 1 } }, { event: "delta", json: { n: 2 } }])
  })

  test("429 maps to rate-limited with retryAfter", async () => {
    const layer = stubClient((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("slow down", { status: 429, headers: { "retry-after": "30" } }),
        ),
      ),
    )
    const request = Http.prepareJson({ url: "https://api.example.com/x", body: {} })
    const error = await runFailure(request, layer)
    expect(error).toBeInstanceOf(LLMError)
    expect(error.reason).toBe("rate-limited")
    expect(error.retryable).toBe(true)
    expect(error.retryAfter).toEqual(Duration.seconds(30))
  })

  test("529 maps to overloaded, retryable", async () => {
    const layer = stubClient((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 529 }))),
    )
    const request = Http.prepareJson({ url: "https://api.example.com/x", body: {} })
    const error = await runFailure(request, layer)
    expect(error.reason).toBe("overloaded")
    expect(error.retryable).toBe(true)
  })

  test("401 maps to auth-failed", async () => {
    const layer = stubClient((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 401 }))),
    )
    const request = Http.prepareJson({ url: "https://api.example.com/x", body: {} })
    const error = await runFailure(request, layer)
    expect(error.reason).toBe("auth-failed")
    expect(error.retryable).toBe(false)
  })

  test("5xx maps to server-error and 4xx to invalid-request", async () => {
    const mk = (status: number) =>
      stubClient((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status }))),
      )
    const request = Http.prepareJson({ url: "https://api.example.com/x", body: {} })
    expect((await runFailure(request, mk(500))).reason).toBe("server-error")
    expect((await runFailure(request, mk(400))).reason).toBe("invalid-request")
  })

  test("network failures map to network-error without leaking HttpClientError", async () => {
    const layer = stubClient((request) =>
      Effect.fail(
        new HttpClientError.RequestError({ request, reason: "Transport", cause: "boom" }),
      ),
    )
    const request = Http.prepareJson({ url: "https://api.example.com/x", body: {} })
    const error = await runFailure(request, layer)
    expect(error).toBeInstanceOf(LLMError)
    expect(error.reason).toBe("network-error")
    expect(error.retryable).toBe(true)
  })

  test("malformed SSE JSON fails with invalid-provider-output", async () => {
    const layer = stubClient((request) => sseResponse(request, "data: {not json}\n\n"))
    const request = Http.prepareJson({ url: "https://api.example.com/x", body: {} })
    const error = await runFailure(request, layer)
    expect(error.reason).toBe("invalid-provider-output")
  })
})
