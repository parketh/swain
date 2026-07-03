import { describe, expect, test } from "bun:test"
import type { HttpClientRequest } from "@effect/platform"
import { HttpClient, HttpClientResponse } from "@effect/platform"
import type { Model } from "@swain/llms"
import { ModelId, ProviderId } from "@swain/llms"
import { Effect, Layer, Stream } from "effect"
import { autoApproval, makePermissions } from "../src/permission"
import { createSessionState } from "../src/state"
import { ToolContext } from "../src/tools"
import { WebFetch } from "../src/tools/web-fetch"
import { exaSearch } from "../src/tools/web-search"

const model: Model = {
  id: ModelId.make("test-model"),
  provider: ProviderId.make("test"),
  streamTurn: () => Stream.empty,
}

const toolContextLayer = Layer.succeed(ToolContext, {
  session: createSessionState({ workingDirectory: "/", model, currentDate: "2026-07-04" }),
  abortSignal: new AbortController().signal,
  permission: makePermissions("auto", autoApproval),
})

const jsonResponse = (payload: unknown) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    ),
  )

const capturingClient = (payload: unknown) => {
  const captured: { request?: HttpClientRequest.HttpClientRequest } = {}
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      captured.request = request
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      )
    }),
  )
  return { layer, captured }
}

const decodeBody = (request: HttpClientRequest.HttpClientRequest): unknown => {
  const body = request.body
  if (body._tag !== "Uint8Array") throw new Error("expected a Uint8Array body")
  return JSON.parse(new TextDecoder().decode(body.body))
}

const exaPayload = {
  requestId: "req-1",
  results: [
    {
      title: "Bun",
      url: "https://bun.sh",
      text: "Fast JS runtime",
      publishedDate: "2026-01-01",
      author: null,
      id: "a",
    },
  ],
  costDollars: { total: 0.001 },
}

describe("exaSearch", () => {
  test("sends a provider-neutral body with the api key header", async () => {
    process.env.EXA_API_KEY = "exa-key"
    const { layer, captured } = capturingClient(exaPayload)
    await Effect.runPromise(
      exaSearch({ query: "bun runtime", numResults: 3 }).pipe(Effect.provide(layer)),
    )
    expect(captured.request?.url).toBe("https://api.exa.ai/search")
    expect(captured.request?.headers["x-api-key"]).toBe("exa-key")
    expect(decodeBody(captured.request!)).toEqual({ query: "bun runtime", numResults: 3 })
  })

  test("threads exa-specific options through providerOptions.exa", async () => {
    process.env.EXA_API_KEY = "exa-key"
    const { layer, captured } = capturingClient(exaPayload)
    await Effect.runPromise(
      exaSearch({ query: "bun", providerOptions: { exa: { type: "neural" } } }).pipe(
        Effect.provide(layer),
      ),
    )
    expect(decodeBody(captured.request!)).toEqual({ query: "bun", type: "neural" })
  })

  test("maps the exa response to provider-neutral results", async () => {
    process.env.EXA_API_KEY = "exa-key"
    const output = await Effect.runPromise(
      exaSearch({ query: "bun" }).pipe(Effect.provide(jsonResponse(exaPayload))),
    )
    expect(output.results).toEqual([
      {
        title: "Bun",
        url: "https://bun.sh",
        text: "Fast JS runtime",
        publishedDate: "2026-01-01",
      },
    ])
  })

  test("fails with a typed error when the api key is missing", async () => {
    process.env.EXA_API_KEY = ""
    const error = await Effect.runPromise(
      exaSearch({ query: "bun" }).pipe(Effect.provide(jsonResponse(exaPayload)), Effect.flip),
    )
    expect(error.tool).toBe("WebSearch")
    expect(error.reason).toBe("precondition-failed")
  })
})

describe("WebFetch", () => {
  const htmlLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("<html>hi</html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        ),
      ),
    ),
  )

  const binaryLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("bytes", { status: 200, headers: { "content-type": "image/png" } }),
        ),
      ),
    ),
  )

  test("returns text for text/html responses", async () => {
    const result = await Effect.runPromise(
      WebFetch.call({ url: "https://example.com" }).pipe(
        Effect.provide(htmlLayer),
        Effect.provide(toolContextLayer),
      ),
    )
    expect(result.supported).toBe(true)
    expect(result.text).toBe("<html>hi</html>")
  })

  test("reports unsupported for non-text responses without body text", async () => {
    const result = await Effect.runPromise(
      WebFetch.call({ url: "https://example.com/x.png" }).pipe(
        Effect.provide(binaryLayer),
        Effect.provide(toolContextLayer),
      ),
    )
    expect(result.supported).toBe(false)
    expect(result.text).toBeUndefined()
  })
})
