import { describe, expect, test } from "bun:test"
import {
  GenerationOptions,
  LLMError,
  LLMEvent,
  LLMTurnSummary,
  Message,
  SystemContent,
  Tool,
  ToolCallId,
} from "@swain/llms"
import { OpenAIChat } from "@swain/llms/protocols"
import { Effect, Stream } from "effect"
import {
  invalidToolJsonChunks,
  noFinishReasonChunks,
  reasoningTurnChunks,
  textTurnChunks,
  toolCallTurnChunks,
} from "./fixtures/openai-chat-events"
import { timingTurn } from "./fixtures/timing"

const decodeAll = (chunks: Array<unknown>) =>
  Effect.runPromise(OpenAIChat.decode(Stream.fromIterable(chunks)).pipe(Stream.runCollect)).then(
    (events) => Array.from(events),
  )

const decodeFailure = (chunks: Array<unknown>) =>
  Effect.runPromise(
    OpenAIChat.decode(Stream.fromIterable(chunks)).pipe(Stream.runCollect, Effect.flip),
  )

const bunTurn = (timed: boolean) =>
  timingTurn({ callId: "call_1", result: { type: "text", value: "a fast js runtime" }, timed })

describe("OpenAIChat.prepare", () => {
  test("timing metadata never reaches the request body", () => {
    const timed = OpenAIChat.prepare({ modelId: "gpt-4.1-mini", messages: bunTurn(true) })
    const untimed = OpenAIChat.prepare({ modelId: "gpt-4.1-mini", messages: bunTurn(false) })
    expect(timed.body).toEqual(untimed.body)
    const serialized = JSON.stringify(timed.body)
    for (const key of ["createdAt", "responseDurationMs", "turnDurationMs", "durationMs"]) {
      expect(serialized).not.toContain(key)
    }
  })

  test("builds the expected request body for text + tool definitions", () => {
    const lookup = Tool.define({
      name: "lookup",
      description: "Look up a value",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    })
    const { path, body } = OpenAIChat.prepare({
      modelId: "gpt-4.1-mini",
      system: SystemContent.text("You are helpful."),
      messages: [
        Message.user("What is bun?"),
        Message.assistant([
          {
            type: "tool-call",
            toolCallId: ToolCallId.make("call_1"),
            name: "lookup",
            input: { query: "bun" },
          },
        ]),
        Message.user([
          {
            type: "tool-result",
            toolCallId: ToolCallId.make("call_1"),
            name: "lookup",
            result: { type: "text", value: "a fast js runtime" },
          },
          { type: "text", text: "Summarize that." },
        ]),
      ],
      tools: [lookup],
      toolChoice: "auto",
      generation: GenerationOptions.make({ maxTokens: 256, stop: ["END"] }),
      providerOptions: { openai: { temperature: 0.2, topP: 0.9, seed: 42 } },
    })

    expect(path).toBe("/chat/completions")
    expect(body).toEqual({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "What is bun?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: '{"query":"bun"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "a fast js runtime" },
        { role: "user", content: "Summarize that." },
      ],
      stream: true,
      stream_options: { include_usage: true },
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look up a value",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: "auto",
      max_tokens: 256,
      stop: ["END"],
      temperature: 0.2,
      top_p: 0.9,
      seed: 42,
    })
  })

  test("omits stream_options for profiles that reject it and only reads its own options key", () => {
    const { body } = OpenAIChat.prepare(
      {
        modelId: "deepseek-chat",
        messages: [Message.user("hi")],
        providerOptions: {
          deepseek: { temperature: 1.3 },
          openai: { temperature: 0.1 },
        },
      },
      { optionsKey: "deepseek", includeUsage: false },
    )
    expect(body.stream_options).toBeUndefined()
    expect(body.temperature).toBe(1.3)
    expect(body.model).toBe("deepseek-chat")
  })

  test("named tool choice lowers to a function reference", () => {
    const { body } = OpenAIChat.prepare({
      modelId: "gpt-4.1-mini",
      messages: [Message.user("hi")],
      toolChoice: { type: "tool", name: "lookup" },
    })
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "lookup" } })
  })

  test("prompt_cache_key is sent only when the option is set", () => {
    const withKey = OpenAIChat.prepare({
      modelId: "gpt-4.1-mini",
      messages: [Message.user("hi")],
      providerOptions: { openai: { promptCacheKey: "swain-session-1" } },
    })
    expect(withKey.body.prompt_cache_key).toBe("swain-session-1")
    const without = OpenAIChat.prepare({ modelId: "gpt-4.1-mini", messages: [Message.user("hi")] })
    expect(without.body.prompt_cache_key).toBeUndefined()
  })
})

describe("OpenAIChat.decode", () => {
  test("streaming text chunks produce text-start, text-delta, text-end", async () => {
    const events = await decodeAll(textTurnChunks)
    expect(events as Array<unknown>).toEqual([
      { type: "text-start", contentId: "text-1" },
      { type: "text-delta", contentId: "text-1", text: "Hello" },
      { type: "text-delta", contentId: "text-1", text: " world" },
      { type: "text-end", contentId: "text-1" },
      {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: 12, outputTokens: 4, activeContextTokens: 16 },
      },
    ])
    const summary = await Effect.runPromise(LLMTurnSummary.fromEvents(events))
    expect(summary.text).toBe("Hello world")
  })

  test("streaming tool-call chunks produce input lifecycle events and final parsed tool-call", async () => {
    const events = await decodeAll(toolCallTurnChunks)
    expect(events as Array<unknown>).toEqual([
      { type: "tool-input-start", toolCallId: "call_abc", name: "lookup" },
      { type: "tool-input-delta", toolCallId: "call_abc", text: '{"query":' },
      { type: "tool-input-delta", toolCallId: "call_abc", text: '"bun"}' },
      { type: "tool-input-end", toolCallId: "call_abc", name: "lookup" },
      { type: "tool-call", toolCallId: "call_abc", name: "lookup", input: { query: "bun" } },
      {
        type: "finish",
        reason: "tool-call",
        usage: { inputTokens: 30, outputTokens: 9, activeContextTokens: 39 },
      },
    ])
  })

  test("invalid tool-call JSON fails with invalid-provider-output", async () => {
    const error = await decodeFailure(invalidToolJsonChunks)
    expect(error).toBeInstanceOf(LLMError)
    expect(error.reason).toBe("invalid-provider-output")
  })

  test("reasoning deltas are preserved when present", async () => {
    const events = await decodeAll(reasoningTurnChunks)
    expect(events as Array<unknown>).toEqual([
      { type: "reasoning-start", contentId: "reasoning-1" },
      { type: "reasoning-delta", contentId: "reasoning-1", text: "Consider" },
      { type: "reasoning-delta", contentId: "reasoning-1", text: " carefully." },
      { type: "reasoning-end", contentId: "reasoning-1" },
      { type: "text-start", contentId: "text-1" },
      { type: "text-delta", contentId: "text-1", text: "The answer is 4." },
      { type: "text-end", contentId: "text-1" },
      { type: "finish", reason: "stop" },
    ])
    const summary = await Effect.runPromise(LLMTurnSummary.fromEvents(events))
    expect(summary.reasoning).toBe("Consider carefully.")
    expect(summary.text).toBe("The answer is 4.")
  })

  test("a stream without a usable finish reason synthesizes finish reason unknown", async () => {
    const events = await decodeAll(noFinishReasonChunks)
    const finish = events.at(-1)
    expect(finish).toEqual({ type: "finish", reason: "unknown" })
  })

  test("successful fixture streams end with exactly one final finish", async () => {
    for (const fixture of [textTurnChunks, toolCallTurnChunks, reasoningTurnChunks]) {
      const events = await decodeAll(fixture)
      const finishes = events.filter(LLMEvent.is.finish)
      expect(finishes).toHaveLength(1)
      expect(events.at(-1)?.type).toBe("finish")
      await Effect.runPromise(LLMTurnSummary.fromEvents(events))
    }
  })
})
