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
import { AnthropicMessages } from "@swain/llms/protocols"
import { Effect, Stream } from "effect"
import {
  fatalErrorChunks,
  invalidToolJsonChunks,
  maxTokensTurnChunks,
  nonfatalFactChunks,
  textTurnChunks,
  thinkingTurnChunks,
  toolUseTurnChunks,
} from "./fixtures/anthropic-message-events"

const prepareSync = (
  ...args: Parameters<typeof AnthropicMessages.prepare>
): Effect.Effect.Success<ReturnType<typeof AnthropicMessages.prepare>> =>
  Effect.runSync(AnthropicMessages.prepare(...args))

const prepareFailure = (...args: Parameters<typeof AnthropicMessages.prepare>) =>
  Effect.runSync(AnthropicMessages.prepare(...args).pipe(Effect.flip))

const decodeAll = (chunks: Array<unknown>) =>
  Effect.runPromise(
    AnthropicMessages.decode(Stream.fromIterable(chunks)).pipe(Stream.runCollect),
  ).then((events) => Array.from(events))

const decodeFailure = (chunks: Array<unknown>) =>
  Effect.runPromise(
    AnthropicMessages.decode(Stream.fromIterable(chunks)).pipe(Stream.runCollect, Effect.flip),
  )

const toolCallId = ToolCallId.make("toolu_01")

const bunTurn = (timed: boolean) => [
  Message.user("What is bun?", false, timed ? { createdAt: "2026-07-17T10:00:00.000Z" } : {}),
  Message.assistant(
    [{ type: "tool-call", toolCallId, name: "lookup", input: { query: "bun" } }],
    timed
      ? { createdAt: "2026-07-17T10:00:01.000Z", responseDurationMs: 1000, turnDurationMs: 3000 }
      : {},
  ),
  Message.user(
    [
      {
        type: "tool-result",
        toolCallId,
        name: "lookup",
        result: { type: "json", value: { answer: "a fast js runtime" } },
        ...(timed && { durationMs: 420 }),
      },
    ],
    false,
    timed ? { createdAt: "2026-07-17T10:00:01.420Z" } : {},
  ),
]

describe("AnthropicMessages.prepare", () => {
  test("timing metadata never reaches the request body", () => {
    const timed = prepareSync({ modelId: "claude-sonnet-4-5", messages: bunTurn(true) })
    const untimed = prepareSync({ modelId: "claude-sonnet-4-5", messages: bunTurn(false) })
    expect(timed.body).toEqual(untimed.body)
    const serialized = JSON.stringify(timed.body)
    for (const key of ["createdAt", "responseDurationMs", "turnDurationMs", "durationMs"]) {
      expect(serialized).not.toContain(key)
    }
  })

  test("builds the expected body for system + user + tool definitions", () => {
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
    const { path, headers, body } = prepareSync({
      modelId: "claude-sonnet-4-5",
      system: SystemContent.text("You are helpful."),
      messages: [
        Message.user("What is bun?"),
        Message.assistant([
          {
            type: "tool-call",
            toolCallId: ToolCallId.make("toolu_01"),
            name: "lookup",
            input: { query: "bun" },
          },
        ]),
        Message.user([
          { type: "text", text: "Summarize that." },
          {
            type: "tool-result",
            toolCallId: ToolCallId.make("toolu_01"),
            name: "lookup",
            result: { type: "json", value: { answer: "a fast js runtime" } },
            isError: false,
          },
        ]),
      ],
      tools: [lookup],
      toolChoice: "auto",
      generation: GenerationOptions.make({ maxTokens: 512, stop: ["END"] }),
      providerOptions: { anthropic: { caching: false } },
    })

    expect(path).toBe("/messages")
    expect(headers).toEqual({
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    })
    expect(body).toEqual({
      model: "claude-sonnet-4-5",
      messages: [
        { role: "user", content: [{ type: "text", text: "What is bun?" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_01", name: "lookup", input: { query: "bun" } }],
        },
        {
          role: "user",
          // tool_result blocks are reordered before text per Anthropic's constraint
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01",
              content: '{"answer":"a fast js runtime"}',
              is_error: false,
            },
            { type: "text", text: "Summarize that." },
          ],
        },
      ],
      stream: true,
      max_tokens: 512,
      system: "You are helpful.",
      tools: [
        {
          name: "lookup",
          description: "Look up a value",
          input_schema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: "auto" },
      stop_sequences: ["END"],
    })
  })

  test("text tool results lower to string content and named tool choice to type tool", () => {
    const { body } = prepareSync({
      modelId: "claude-sonnet-4-5",
      messages: [
        Message.user([
          {
            type: "tool-result",
            toolCallId: ToolCallId.make("toolu_02"),
            result: { type: "text", value: "plain result" },
          },
        ]),
      ],
      toolChoice: { type: "tool", name: "lookup" },
      providerOptions: { anthropic: { caching: false } },
    })
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_02", content: "plain result" }],
      },
    ])
    expect(body.tool_choice).toEqual({ type: "tool", name: "lookup" })
  })

  test("adds ephemeral cache_control breakpoints on tools, system, and the last message by default", () => {
    const lookup = Tool.define({
      name: "lookup",
      description: "Look up a value",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    })
    const { body } = prepareSync({
      modelId: "claude-sonnet-4-5",
      system: SystemContent.text("You are helpful."),
      messages: [Message.user("What is bun?")],
      tools: [lookup],
    })
    const ephemeral = { type: "ephemeral" }
    // System is lowered to a content-block array carrying the breakpoint.
    expect(body.system).toEqual([
      { type: "text", text: "You are helpful.", cache_control: ephemeral },
    ])
    // The last (only) tool carries a breakpoint, caching the whole tool block.
    const tools = body.tools as ReadonlyArray<Record<string, unknown>>
    expect(tools.at(-1)?.cache_control).toEqual(ephemeral)
    // The last content block of the last message carries a breakpoint.
    const messages = body.messages as ReadonlyArray<{ content: ReadonlyArray<unknown> }>
    expect(messages.at(-1)?.content.at(-1)).toEqual({
      type: "text",
      text: "What is bun?",
      cache_control: ephemeral,
    })
  })

  test("omits cache_control when caching is disabled", () => {
    const { body } = prepareSync({
      modelId: "m",
      system: SystemContent.text("sys"),
      messages: [Message.user("hi")],
      providerOptions: { anthropic: { caching: false } },
    })
    expect(body.system).toBe("sys")
    expect(JSON.stringify(body)).not.toContain("cache_control")
  })

  test("max_tokens defaults when the request carries none", () => {
    const { body } = prepareSync({ modelId: "m", messages: [Message.user("hi")] })
    expect(body.max_tokens).toBe(4096)
    const configured = prepareSync(
      { modelId: "m", messages: [Message.user("hi")] },
      { defaultMaxTokens: 1024 },
    )
    expect(configured.body.max_tokens).toBe(1024)
  })

  test("sequencing constraints fail locally with invalid-request", () => {
    const emptyMessages = prepareFailure({ modelId: "m", messages: [] })
    expect(emptyMessages).toBeInstanceOf(LLMError)
    expect(emptyMessages.reason).toBe("invalid-request")

    const assistantFirst = prepareFailure({
      modelId: "m",
      messages: [Message.assistant("hello")],
    })
    expect(assistantFirst.reason).toBe("invalid-request")

    const emptyContent = prepareFailure({
      modelId: "m",
      messages: [Message.user([])],
    })
    expect(emptyContent.reason).toBe("invalid-request")
  })
})

describe("AnthropicMessages.decode", () => {
  test("text deltas produce lifecycle events with usage on finish", async () => {
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

  test("cache tokens roll into activeContextTokens", async () => {
    const chunks: Array<unknown> = [
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 12,
            output_tokens: 1,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 900,
          },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ]
    const events = await decodeAll(chunks)
    const finish = events.at(-1)
    // 12 input + 4 output + 100 cache-creation + 900 cache-read.
    expect(finish).toEqual({
      type: "finish",
      reason: "stop",
      usage: { inputTokens: 12, outputTokens: 4, activeContextTokens: 1016 },
    })
  })

  test("tool-use partial JSON produces input lifecycle events and final tool-call", async () => {
    const events = await decodeAll(toolUseTurnChunks)
    expect(events as Array<unknown>).toEqual([
      { type: "text-start", contentId: "text-1" },
      { type: "text-delta", contentId: "text-1", text: "Looking it up." },
      { type: "text-end", contentId: "text-1" },
      { type: "tool-input-start", toolCallId: "toolu_01", name: "lookup" },
      { type: "tool-input-delta", toolCallId: "toolu_01", text: '{"query":' },
      { type: "tool-input-delta", toolCallId: "toolu_01", text: '"bun"}' },
      { type: "tool-input-end", toolCallId: "toolu_01", name: "lookup" },
      { type: "tool-call", toolCallId: "toolu_01", name: "lookup", input: { query: "bun" } },
      {
        type: "finish",
        reason: "tool-call",
        usage: { inputTokens: 30, outputTokens: 15, activeContextTokens: 45 },
      },
    ])
  })

  test("thinking deltas produce reasoning events and signature deltas stay local", async () => {
    const events = await decodeAll(thinkingTurnChunks)
    expect(events as Array<unknown>).toEqual([
      { type: "reasoning-start", contentId: "reasoning-1" },
      { type: "reasoning-delta", contentId: "reasoning-1", text: "Consider" },
      { type: "reasoning-delta", contentId: "reasoning-1", text: " carefully." },
      { type: "reasoning-end", contentId: "reasoning-1" },
      { type: "text-start", contentId: "text-1" },
      { type: "text-delta", contentId: "text-1", text: "The answer is 4." },
      { type: "text-end", contentId: "text-1" },
      {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: 20, outputTokens: 9, activeContextTokens: 29 },
      },
    ])
    const summary = await Effect.runPromise(LLMTurnSummary.fromEvents(events))
    expect(summary.reasoning).toBe("Consider carefully.")
    expect(summary.text).toBe("The answer is 4.")
  })

  test("max_tokens stop reason lowers to length", async () => {
    const events = await decodeAll(maxTokensTurnChunks)
    const finish = events.at(-1)
    expect(finish).toEqual({
      type: "finish",
      reason: "length",
      usage: { inputTokens: 6, outputTokens: 2, activeContextTokens: 8 },
    })
  })

  test("nonfatal error facts map to ProviderError and the stream still finishes", async () => {
    const events = await decodeAll(nonfatalFactChunks)
    const providerErrors = events.filter(LLMEvent.is.providerError)
    expect(providerErrors).toEqual([
      {
        type: "provider-error",
        message: "degraded quality period",
        code: "informational_notice",
        recoverable: true,
      },
    ])
    const summary = await Effect.runPromise(LLMTurnSummary.fromEvents(events))
    expect(summary.text).toBe("Hi there")
    expect(summary.finish.reason).toBe("stop")
  })

  test("fatal error events fail with LLMError", async () => {
    const error = await decodeFailure(fatalErrorChunks)
    expect(error).toBeInstanceOf(LLMError)
    expect(error.reason).toBe("overloaded")
    expect(error.retryable).toBe(true)
  })

  test("malformed tool input JSON fails with invalid-provider-output", async () => {
    const error = await decodeFailure(invalidToolJsonChunks)
    expect(error).toBeInstanceOf(LLMError)
    expect(error.reason).toBe("invalid-provider-output")
  })

  test("successful fixture streams end with exactly one final finish", async () => {
    for (const fixture of [
      textTurnChunks,
      toolUseTurnChunks,
      thinkingTurnChunks,
      nonfatalFactChunks,
      maxTokensTurnChunks,
    ]) {
      const events = await decodeAll(fixture)
      const finishes = events.filter(LLMEvent.is.finish)
      expect(finishes).toHaveLength(1)
      expect(events.at(-1)?.type).toBe("finish")
      await Effect.runPromise(LLMTurnSummary.fromEvents(events))
    }
  })
})
