import { describe, expect, test } from "bun:test"
import type { HttpClientRequest } from "@effect/platform"
import { HttpClient, HttpClientResponse } from "@effect/platform"
import { Effect, Layer } from "effect"
import { exaSearch, makeWebSearch } from "../src/tools/web-search"

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

describe("WebSearch timing opt-in", () => {
  test("opts into duration recording", () => {
    const tool = makeWebSearch({ search: () => Effect.succeed({ results: [] }) })
    expect(tool.recordDuration).toBe(true)
  })
})

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
