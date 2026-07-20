import { describe, expect, test } from "bun:test"
import type { HttpClientRequest } from "@effect/platform"
import { HttpClient, HttpClientResponse } from "@effect/platform"
import type { LLMEvent, Model } from "@swain/llms"
import {
  ContentId,
  LLM,
  LLMError,
  LLMTurnSummary,
  Message,
  ModelId,
  ProviderId,
  ToolCallId,
} from "@swain/llms"
import { OpenAI } from "@swain/llms/providers"
import { Effect, Layer, Stream } from "effect"
import { textTurnChunks, toolCallTurnChunks } from "./fixtures/openai-chat-events"

const model: Model = {
  id: ModelId.make("test-model"),
  provider: ProviderId.make("test"),
  streamTurn: () => Stream.empty,
}

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

const contentId = ContentId.make("content-1")
const toolId = ToolCallId.make("call-1")

const successfulEvents: Array<LLMEvent> = [
  { type: "reasoning-start", contentId },
  { type: "reasoning-delta", contentId, text: "Think." },
  { type: "reasoning-end", contentId },
  { type: "text-start", contentId },
  { type: "text-delta", contentId, text: "Hello" },
  { type: "text-delta", contentId, text: " world" },
  { type: "text-end", contentId },
  { type: "tool-input-start", toolCallId: toolId, name: "lookup" },
  { type: "tool-input-delta", toolCallId: toolId, text: '{"query":"bun"}' },
  { type: "tool-input-end", toolCallId: toolId, name: "lookup" },
  { type: "tool-call", toolCallId: toolId, name: "lookup", input: { query: "bun" } },
  { type: "provider-error", message: "minor fact", recoverable: true },
  {
    type: "finish",
    reason: "tool-call",
    usage: { inputTokens: 10, outputTokens: 5, activeContextTokens: 15 },
  },
]

describe("LLM.request", () => {
  test("prompt becomes one trailing user message", () => {
    const request = LLM.request({ model, prompt: "Say hello." })

    expect(request.messages).toHaveLength(1)
    expect(request.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "Say hello." }],
    })
  })

  test("prompt appends after existing messages", () => {
    const request = LLM.request({
      model,
      messages: [Message.user("First."), Message.assistant("Reply.")],
      prompt: "Second.",
    })

    expect(request.messages).toHaveLength(3)
    expect(request.messages[2]?.role).toBe("user")
  })

  test("system stays on the request and never becomes a chronological message", () => {
    const request = LLM.request({
      model,
      system: "You are a helpful coding assistant.",
      prompt: "Hi.",
    })

    expect(request.system).toEqual({ text: "You are a helpful coding assistant." })
    expect(request.messages).toHaveLength(1)
    expect(request.messages.every((message) => message.role !== ("system" as string))).toBe(true)
  })

  test("tools and generation options normalize into schema values", () => {
    const request = LLM.request({
      model,
      prompt: "Hi.",
      tools: [{ name: "lookup", description: "Look up a value", inputSchema: { type: "object" } }],
      generation: { maxTokens: 64 },
    })

    expect(request.tools?.[0]?.name).toBe("lookup")
    expect(request.generation?.maxTokens).toBe(64)
  })
})

describe("LLM turn runtime", () => {
  test("end-to-end tracer: OpenAI model streams a fixture-backed turn through LLM.streamTurn", async () => {
    const request = LLM.request({
      model: OpenAI.configure({ apiKey: "k" }).chat("gpt-4.1-mini"),
      system: "You are helpful.",
      prompt: "Say hello.",
    })
    const events = await Effect.runPromise(
      LLM.streamTurn(request).pipe(
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.provide(stubLayer(textTurnChunks)),
      ),
    )

    const types = events.map((event) => event.type)
    expect(types).toEqual(["text-start", "text-delta", "text-delta", "text-end", "finish"])
    const summary = await Effect.runPromise(LLMTurnSummary.fromEvents(events))
    expect(summary.text).toBe("Hello world")
    expect(summary.finish.reason).toBe("stop")
    expect(summary.usage).toEqual({ inputTokens: 12, outputTokens: 4, activeContextTokens: 16 })
  })

  test("tracer covers the tool-call lifecycle", async () => {
    const request = LLM.request({
      model: OpenAI.configure({ apiKey: "k" }).chat("gpt-4.1-mini"),
      prompt: "Look something up.",
    })
    const events = await Effect.runPromise(
      LLM.streamTurn(request).pipe(
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.provide(stubLayer(toolCallTurnChunks)),
      ),
    )

    expect(events.map((event) => event.type)).toEqual([
      "tool-input-start",
      "tool-input-delta",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "finish",
    ])
    const summary = await Effect.runPromise(LLMTurnSummary.fromEvents(events))
    expect(summary.toolCalls).toHaveLength(1)
    expect(summary.toolCalls[0]?.input).toEqual({ query: "bun" })
    expect(summary.finish.reason).toBe("tool-call")
  })

  test("generateTurn collects a fixture-backed stream into { events }", async () => {
    const request = LLM.request({
      model: OpenAI.configure({ apiKey: "k" }).chat("gpt-4.1-mini"),
      prompt: "Say hello.",
    })
    const response = await Effect.runPromise(
      LLM.generateTurn(request).pipe(Effect.provide(stubLayer(textTurnChunks))),
    )

    expect(response).toEqual({ events: expect.any(Array) })
    expect(Object.keys(response)).toEqual(["events"])
    expect(response.events.at(-1)?.type).toBe("finish")
  })

  test("streamTurn returns events without forcing collection", async () => {
    let pulled = 0
    const lazyModel: Model = {
      id: ModelId.make("lazy"),
      provider: ProviderId.make("test"),
      streamTurn: () =>
        Stream.fromIterableEffect(
          Effect.sync(() => {
            pulled += 1
            return successfulEvents
          }),
        ),
    }
    const stream = LLM.streamTurn(LLM.request({ model: lazyModel, prompt: "Hi." }))
    expect(pulled).toBe(0)

    const events = await Effect.runPromise(
      stream.pipe(
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.provide(stubLayer([])),
      ),
    )
    expect(pulled).toBe(1)
    expect(events).toHaveLength(successfulEvents.length)
  })

  test("generateTurn populates LLMError.eventsSoFar on mid-stream failure", async () => {
    const partial = successfulEvents.slice(0, 4)
    const failingModel: Model = {
      id: ModelId.make("failing"),
      provider: ProviderId.make("test"),
      streamTurn: () =>
        Stream.concat(
          Stream.fromIterable(partial),
          Stream.fail(new LLMError({ reason: "server-error", message: "boom", retryable: true })),
        ),
    }
    const error = await Effect.runPromise(
      LLM.generateTurn(LLM.request({ model: failingModel, prompt: "Hi." })).pipe(
        Effect.flip,
        Effect.provide(stubLayer([])),
      ),
    )

    expect(error).toBeInstanceOf(LLMError)
    expect(error.reason).toBe("server-error")
    expect(error.eventsSoFar).toEqual(partial)
  })
})

describe("LLMTurnSummary.fromEvents", () => {
  test("derives text, reasoning, tool calls, provider errors, usage, and finish", async () => {
    const summary = await Effect.runPromise(LLMTurnSummary.fromEvents(successfulEvents))

    expect(summary.text).toBe("Hello world")
    expect(summary.reasoning).toBe("Think.")
    expect(summary.toolCalls).toEqual([
      { type: "tool-call", toolCallId: toolId, name: "lookup", input: { query: "bun" } },
    ])
    expect(summary.assistantContent.map((content) => content.type)).toEqual([
      "reasoning",
      "text",
      "tool-call",
    ])
    expect(summary.providerErrors).toEqual([
      { type: "provider-error", message: "minor fact", recoverable: true },
    ])
    expect(summary.usage).toEqual({ inputTokens: 10, outputTokens: 5, activeContextTokens: 15 })
    expect(summary.finish.reason).toBe("tool-call")
  })

  const expectInvalid = async (events: ReadonlyArray<LLMEvent>) => {
    const error = await Effect.runPromise(Effect.flip(LLMTurnSummary.fromEvents(events)))
    expect(error).toBeInstanceOf(LLMError)
    expect(error.reason).toBe("invalid-provider-output")
  }

  test("rejects a missing finish event", async () => {
    await expectInvalid([{ type: "text-start", contentId }])
  })

  test("rejects multiple finish events", async () => {
    await expectInvalid([
      { type: "finish", reason: "stop" },
      { type: "finish", reason: "stop" },
    ])
  })

  test("rejects a non-final finish event", async () => {
    await expectInvalid([
      { type: "finish", reason: "stop" },
      { type: "text-start", contentId },
    ])
  })

  test("rejects invalid text lifecycle order", async () => {
    await expectInvalid([
      { type: "text-delta", contentId, text: "x" },
      { type: "finish", reason: "stop" },
    ])
  })

  test("rejects invalid reasoning lifecycle order", async () => {
    await expectInvalid([
      { type: "reasoning-end", contentId },
      { type: "finish", reason: "stop" },
    ])
  })

  test("rejects invalid tool lifecycle order", async () => {
    await expectInvalid([
      { type: "tool-input-start", toolCallId: toolId, name: "lookup" },
      { type: "tool-call", toolCallId: toolId, name: "lookup", input: {} },
      { type: "finish", reason: "stop" },
    ])
  })
})
