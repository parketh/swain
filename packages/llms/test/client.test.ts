import { describe, expect, test } from "bun:test"
import type { HttpClientRequest } from "@effect/platform"
import { HttpClient, HttpClientResponse } from "@effect/platform"
import { LLMClient, LLMTurnSummary } from "@swain/llms"
import { OpenAI } from "@swain/llms/providers"
import { Effect, Layer, Stream } from "effect"
import { textTurnChunks, toolCallTurnChunks } from "./fixtures/openai-chat-events"

const sseBody = (chunks: ReadonlyArray<unknown>) =>
  `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`

const stubLayer = (chunks: ReadonlyArray<unknown>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(sseBody(chunks), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      ),
    ),
  )

const model = OpenAI.configure({ apiKey: "k" }).chat("gpt-4.1-mini")

describe("LLMClient", () => {
  test("streamTurn resolves HttpClient from the layer, not the caller", async () => {
    const request = LLMClient.request({ model, prompt: "Say hello." })
    const events = await Effect.runPromise(
      LLMClient.streamTurn(request).pipe(
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.provide(LLMClient.layer),
        Effect.provide(stubLayer(textTurnChunks)),
      ),
    )
    const summary = await Effect.runPromise(LLMTurnSummary.fromEvents(events))
    expect(summary.text).toBe("Hello world")
    expect(summary.finish.reason).toBe("stop")
  })

  test("generateTurn collects a fixture-backed turn through the service", async () => {
    const request = LLMClient.request({ model, prompt: "Look something up." })
    const response = await Effect.runPromise(
      LLMClient.generateTurn(request).pipe(
        Effect.provide(LLMClient.layer),
        Effect.provide(stubLayer(toolCallTurnChunks)),
      ),
    )
    const summary = await Effect.runPromise(LLMTurnSummary.fromEvents(response.events))
    expect(summary.toolCalls).toHaveLength(1)
    expect(summary.finish.reason).toBe("tool-call")
  })
})
