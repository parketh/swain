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

describe("message constructors", () => {
  test("Message.user normalizes strings into TextContent", () => {
    expect(Message.user("hi")).toEqual({
      role: "user",
      content: [{ type: "text", text: "hi" }],
    })
  })

  test("Message.assistant normalizes strings into TextContent", () => {
    expect(Message.assistant("hello")).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    })
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
