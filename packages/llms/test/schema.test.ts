import { describe, expect, test } from "bun:test"
import * as schema from "@swain/llms/schema"
import {
  ContentId,
  Finish,
  LLMError,
  LLMEvent,
  LLMTurnSummary,
  Message,
  ReasoningDelta,
  ReasoningEnd,
  ReasoningStart,
  renderCompaction,
  TextDelta,
  TextEnd,
  TextStart,
  Tool,
  ToolCall,
  ToolCallId,
  ToolChoice,
  ToolInputDelta,
  ToolInputEnd,
  ToolInputStart,
  ToolResultContent,
} from "@swain/llms/schema"
import { Effect, Either, Schema } from "effect"

const contentId = ContentId.make("content-1")
const toolCallId = ToolCallId.make("call-1")

const textLifecycle = [
  TextStart.make({ type: "text-start", contentId }),
  TextDelta.make({ type: "text-delta", contentId, text: "Hello" }),
  TextDelta.make({ type: "text-delta", contentId, text: " world" }),
  TextEnd.make({ type: "text-end", contentId }),
]

const toolLifecycle = [
  ToolInputStart.make({ type: "tool-input-start", toolCallId, name: "lookup" }),
  ToolInputDelta.make({ type: "tool-input-delta", toolCallId, text: '{"query":' }),
  ToolInputDelta.make({ type: "tool-input-delta", toolCallId, text: '"x"}' }),
  ToolInputEnd.make({ type: "tool-input-end", toolCallId, name: "lookup" }),
  ToolCall.make({ type: "tool-call", toolCallId, name: "lookup", input: { query: "x" } }),
]

const finish = Finish.make({
  type: "finish",
  reason: "tool-call",
  usage: { inputTokens: 10, outputTokens: 20 },
})

const expectInvalidProviderOutput = (events: ReadonlyArray<LLMEvent>) => {
  const result = Effect.runSync(Effect.either(LLMTurnSummary.fromEvents(events)))
  expect(Either.isLeft(result)).toBe(true)
  if (Either.isLeft(result)) {
    expect(result.left).toBeInstanceOf(LLMError)
    expect(result.left.reason).toBe("invalid-provider-output")
  }
}

const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

describe("message constructors", () => {
  test("Message.user normalizes strings into TextContent", () => {
    const message = Message.user("hi")
    expect(message).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "hi" }],
    })
    expect(message.createdAt).toMatch(isoRe)
  })

  test("Message.assistant normalizes strings into TextContent", () => {
    const message = Message.assistant("hello")
    expect(message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    })
    expect(message.createdAt).toMatch(isoRe)
  })

  test("constructors accept explicit createdAt and duration timing", () => {
    const user = Message.user("hi", false, { createdAt: "2026-07-17T10:00:00.000Z" })
    expect(user.createdAt).toBe("2026-07-17T10:00:00.000Z")
    const assistant = Message.assistant("done", {
      createdAt: "2026-07-17T10:00:02.000Z",
      responseDurationMs: 330,
      turnDurationMs: 2000,
    })
    expect(assistant.responseDurationMs).toBe(330)
    expect(assistant.turnDurationMs).toBe(2000)
  })

  test("a fully timed message round-trips through decode", () => {
    const message = Message.assistant(
      [{ type: "tool-call", toolCallId, name: "WebSearch", input: { query: "x" } }],
      { createdAt: "2026-07-17T10:00:01.250Z", responseDurationMs: 1250, turnDurationMs: 2000 },
    )
    const decoded = Schema.decodeUnknownEither(Message)(JSON.parse(JSON.stringify(message)))
    expect(Either.isRight(decoded)).toBe(true)
    if (Either.isRight(decoded) && decoded.right.role === "assistant") {
      expect(decoded.right.createdAt).toBe("2026-07-17T10:00:01.250Z")
      expect(decoded.right.responseDurationMs).toBe(1250)
      expect(decoded.right.turnDurationMs).toBe(2000)
    }
  })

  test("a tool result carrying durationMs round-trips through decode", () => {
    const result = ToolResultContent.make({
      type: "tool-result",
      toolCallId,
      name: "WebSearch",
      result: { type: "json", value: { results: [] } },
      durationMs: 420,
    })
    const message = Message.user([result], false, { createdAt: "2026-07-17T10:00:01.670Z" })
    const decoded = Schema.decodeUnknownEither(Message)(JSON.parse(JSON.stringify(message)))
    expect(Either.isRight(decoded)).toBe(true)
    if (Either.isRight(decoded)) {
      const block = decoded.right.content[0] as ToolResultContent
      expect(block.durationMs).toBe(420)
    }
  })

  test("a message missing createdAt fails to decode", () => {
    const decoded = Schema.decodeUnknownEither(Message)({
      role: "user",
      content: [{ type: "text", text: "unstamped" }],
    })
    expect(Either.isLeft(decoded)).toBe(true)
  })

  test("a non-ISO createdAt fails to decode", () => {
    const decoded = Schema.decodeUnknownEither(Message)({
      role: "user",
      content: [{ type: "text", text: "hi" }],
      createdAt: "yesterday",
    })
    expect(Either.isLeft(decoded)).toBe(true)
  })

  test("a negative duration fails to decode", () => {
    const decoded = Schema.decodeUnknownEither(Message)({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      createdAt: "2026-07-17T10:00:00.000Z",
      responseDurationMs: -1,
    })
    expect(Either.isLeft(decoded)).toBe(true)
  })

  test("no constructor permits a system role in messages", () => {
    const decoded = Schema.decodeUnknownEither(Message)({
      role: "system",
      content: [{ type: "text", text: "privileged" }],
    })
    expect(Either.isLeft(decoded)).toBe(true)
  })

  test("no public ToolMessage exists", () => {
    expect((schema as Record<string, unknown>).ToolMessage).toBeUndefined()
  })

  test("user messages can contain ToolResultContent", () => {
    const result = ToolResultContent.make({
      type: "tool-result",
      toolCallId,
      name: "lookup",
      result: { type: "json", value: { hits: 3 } },
    })
    const message = Message.user([result])
    expect(message.content).toEqual([result])
    expect(Either.isRight(Schema.decodeUnknownEither(Message)(message))).toBe(true)
  })

  test("a meta model-switch user message round-trips through decode", () => {
    const message = Message.user(
      [
        {
          type: "model-switch",
          from: { provider: "anthropic", modelId: "claude-opus-4-8", variant: "high" },
          to: { provider: "deepseek", modelId: "deepseek-v4-pro", variant: "max" },
          reason: "escalating for a correctness-sensitive step",
          requestedBy: "router",
        },
      ],
      true,
    )
    expect(message.isMeta).toBe(true)
    const decoded = Schema.decodeUnknownEither(Message)(JSON.parse(JSON.stringify(message)))
    expect(Either.isRight(decoded)).toBe(true)
  })

  test("a meta compaction user message round-trips through decode", () => {
    const message = Message.user(
      [{ type: "compaction", reason: "manual", compactedMessages: 42, summary: "## Goal\n..." }],
      true,
    )
    expect(message.isMeta).toBe(true)
    const decoded = Schema.decodeUnknownEither(Message)(JSON.parse(JSON.stringify(message)))
    expect(Either.isRight(decoded)).toBe(true)
  })

  test("renderCompaction renders a marker plus the summary as text", () => {
    const text = renderCompaction({
      type: "compaction",
      reason: "auto",
      compactedMessages: 7,
      summary: "## Goal\nShip it",
    })
    expect(text).toContain("7 earlier messages summarized")
    expect(text).toContain("<summary>")
    expect(text).toContain("Ship it")
  })
})

describe("tools", () => {
  test("Tool.define builds a tool", () => {
    const tool = Tool.define({
      name: "lookup",
      description: "Look up a value",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    })
    expect(tool.name).toBe("lookup")
  })

  test("Tool.define preserves an optional outputSchema", () => {
    const tool = Tool.define({
      name: "lookup",
      description: "Look up a value",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      outputSchema: { type: "object", properties: { answer: { type: "string" } } },
    })
    expect(tool.outputSchema).toEqual({
      type: "object",
      properties: { answer: { type: "string" } },
    })
  })

  test("Tool.define omits outputSchema when not provided", () => {
    const tool = Tool.define({
      name: "lookup",
      description: "Look up a value",
      inputSchema: { type: "object" },
    })
    expect(tool.outputSchema).toBeUndefined()
    expect("outputSchema" in tool).toBe(false)
  })

  test("invalid schema input fails through Effect Schema decoding", () => {
    const decoded = Schema.decodeUnknownEither(Tool)({
      name: 42,
      description: "bad",
      inputSchema: {},
    })
    expect(Either.isLeft(decoded)).toBe(true)
  })

  test("tool choice accepts auto, none, required, and a named tool", () => {
    for (const choice of [
      ToolChoice.auto,
      ToolChoice.none,
      ToolChoice.required,
      ToolChoice.tool("lookup"),
    ]) {
      expect(Either.isRight(Schema.decodeUnknownEither(ToolChoice)(choice))).toBe(true)
    }
  })
})

describe("event type guards", () => {
  test("LLMEvent.is discriminates events", () => {
    const delta = textLifecycle[1] as LLMEvent
    expect(LLMEvent.is.textDelta(delta)).toBe(true)
    expect(LLMEvent.is.finish(delta)).toBe(false)
    expect(LLMEvent.is.finish(finish)).toBe(true)
    expect(LLMEvent.is.toolCall(toolLifecycle[4] as LLMEvent)).toBe(true)
  })
})

describe("LLMTurnSummary.fromEvents", () => {
  test("derives summary from a successful turn", () => {
    const reasoningId = ContentId.make("reasoning-1")
    const events: ReadonlyArray<LLMEvent> = [
      ReasoningStart.make({ type: "reasoning-start", contentId: reasoningId }),
      ReasoningDelta.make({ type: "reasoning-delta", contentId: reasoningId, text: "thinking" }),
      ReasoningEnd.make({ type: "reasoning-end", contentId: reasoningId }),
      ...textLifecycle,
      ...toolLifecycle,
      finish,
    ]
    const summary = Effect.runSync(LLMTurnSummary.fromEvents(events))
    expect(summary.text).toBe("Hello world")
    expect(summary.reasoning).toBe("thinking")
    expect(summary.finish.reason).toBe("tool-call")
    expect(summary.usage).toEqual({ inputTokens: 10, outputTokens: 20 })
    expect(summary.toolCalls).toEqual([
      { type: "tool-call", toolCallId, name: "lookup", input: { query: "x" } },
    ])
    expect(summary.assistantContent).toEqual([
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "Hello world" },
      { type: "tool-call", toolCallId, name: "lookup", input: { query: "x" } },
    ])
    expect(summary.providerErrors).toEqual([])
  })

  test("rejects a missing finish event", () => {
    expectInvalidProviderOutput(textLifecycle)
  })

  test("rejects a non-final finish event", () => {
    expectInvalidProviderOutput([finish, ...textLifecycle])
  })

  test("rejects multiple finish events", () => {
    expectInvalidProviderOutput([...textLifecycle, finish, finish])
  })

  test("rejects text-delta before text-start", () => {
    expectInvalidProviderOutput([
      TextDelta.make({ type: "text-delta", contentId, text: "orphan" }),
      finish,
    ])
  })

  test("rejects reasoning-delta before reasoning-start", () => {
    expectInvalidProviderOutput([
      ReasoningDelta.make({ type: "reasoning-delta", contentId, text: "orphan" }),
      finish,
    ])
  })

  test("rejects tool-input-delta before tool-input-start", () => {
    expectInvalidProviderOutput([
      ToolInputDelta.make({ type: "tool-input-delta", toolCallId, text: "{" }),
      finish,
    ])
  })

  test("rejects tool-call before tool-input-end", () => {
    expectInvalidProviderOutput([
      ToolInputStart.make({ type: "tool-input-start", toolCallId, name: "lookup" }),
      ToolCall.make({ type: "tool-call", toolCallId, name: "lookup", input: {} }),
      finish,
    ])
  })
})
