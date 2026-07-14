import { describe, expect, test } from "bun:test"
import {
  LLMError,
  LLMEvent,
  LLMTurnSummary,
  Message,
  SystemContent,
  Tool,
  ToolCallId,
} from "@swain/llms"
import { OpenAICodexResponses } from "@swain/llms/protocols"
import { Effect, Stream } from "effect"
import {
  doneOnlyArgumentsChunks,
  failedResponseChunks,
  functionCallTurnChunks,
  incompleteTurnChunks,
  invalidToolJsonChunks,
  parallelFunctionCallTurnChunks,
  quotaErrorChunks,
  textReasoningTurnChunks,
} from "./fixtures/openai-codex-events"

const config = { accessToken: "tok_123", accountId: "acct_456" }

const decodeAll = (chunks: Array<unknown>) =>
  Effect.runPromise(
    OpenAICodexResponses.decode(Stream.fromIterable(chunks)).pipe(Stream.runCollect),
  ).then((events) => Array.from(events))

const decodeFailure = (chunks: Array<unknown>) =>
  Effect.runPromise(
    OpenAICodexResponses.decode(Stream.fromIterable(chunks)).pipe(Stream.runCollect, Effect.flip),
  )

describe("OpenAICodexResponses.prepare", () => {
  test("builds the expected body for system, messages, and tools", () => {
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
    const { path, body } = OpenAICodexResponses.prepare(
      {
        modelId: "gpt-5.1-codex",
        system: SystemContent.text("You are helpful."),
        messages: [
          Message.user("What is bun?"),
          Message.assistant([
            { type: "text", text: "Let me check." },
            {
              type: "tool-call",
              toolCallId: ToolCallId.make("call_1|fc_1"),
              name: "lookup",
              input: { query: "bun" },
            },
          ]),
          Message.user([
            {
              type: "tool-result",
              toolCallId: ToolCallId.make("call_1|fc_1"),
              name: "lookup",
              result: { type: "json", value: { answer: "a fast js runtime" } },
            },
            { type: "text", text: "Summarize that." },
          ]),
        ],
        tools: [lookup],
        toolChoice: "auto",
        generation: { maxTokens: 256 },
        providerOptions: { openaiCodex: { reasoning: { effort: "high", summary: "auto" } } },
      },
      config,
    )

    expect(path).toBe("/codex/responses")
    expect(body).toEqual({
      model: "gpt-5.1-codex",
      store: false,
      stream: true,
      instructions: "You are helpful.",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "What is bun?" }] },
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Let me check." }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          id: "fc_1",
          name: "lookup",
          arguments: '{"query":"bun"}',
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: '{"answer":"a fast js runtime"}',
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Summarize that." }],
        },
      ],
      text: { verbosity: "low" },
      include: ["reasoning.encrypted_content"],
      parallel_tool_calls: true,
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Look up a value",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: "auto",
      // `generation.maxTokens` is intentionally dropped: the ChatGPT-account
      // Codex backend rejects `max_output_tokens` as an unsupported parameter.
      reasoning: { effort: "high", summary: "auto" },
    })
  })

  test("prepared headers include bearer token, account id, beta and SSE accept headers", () => {
    const { headers } = OpenAICodexResponses.prepare(
      { modelId: "gpt-5.1-codex", messages: [Message.user("hi")] },
      { ...config, originator: "swain" },
    )
    expect(headers).toEqual({
      authorization: "Bearer tok_123",
      "chatgpt-account-id": "acct_456",
      originator: "swain",
      "openai-beta": "responses=experimental",
      accept: "text/event-stream",
      "content-type": "application/json",
    })
  })

  test("originator defaults and named tool choice lowers to function reference", () => {
    const { headers, body } = OpenAICodexResponses.prepare(
      {
        modelId: "gpt-5.1-codex",
        messages: [Message.user("hi")],
        toolChoice: { type: "tool", name: "lookup" },
      },
      config,
    )
    expect(headers.originator).toBe("codex")
    expect(body.tool_choice).toEqual({ type: "function", name: "lookup" })
  })
})

describe("OpenAICodexResponses.decode", () => {
  test("streaming text and reasoning chunks produce lifecycle events", async () => {
    const events = await decodeAll(textReasoningTurnChunks)
    expect(events as Array<unknown>).toEqual([
      { type: "reasoning-start", contentId: "reasoning-1" },
      { type: "reasoning-delta", contentId: "reasoning-1", text: "Consider" },
      { type: "reasoning-delta", contentId: "reasoning-1", text: " carefully." },
      { type: "reasoning-end", contentId: "reasoning-1" },
      { type: "text-start", contentId: "text-1" },
      { type: "text-delta", contentId: "text-1", text: "Hello" },
      { type: "text-delta", contentId: "text-1", text: " world" },
      { type: "text-end", contentId: "text-1" },
      {
        type: "finish",
        reason: "stop",
        usage: { inputTokens: 12, outputTokens: 7, activeContextTokens: 19 },
      },
    ])
    const summary = await Effect.runPromise(LLMTurnSummary.fromEvents(events))
    expect(summary.text).toBe("Hello world")
    expect(summary.reasoning).toBe("Consider carefully.")
  })

  test("streaming function-call arguments produce raw deltas and final parsed tool-call", async () => {
    const events = await decodeAll(functionCallTurnChunks)
    expect(events as Array<unknown>).toEqual([
      { type: "tool-input-start", toolCallId: "call_1|fc_1", name: "lookup" },
      { type: "tool-input-delta", toolCallId: "call_1|fc_1", text: '{"query":' },
      { type: "tool-input-delta", toolCallId: "call_1|fc_1", text: '"bun"}' },
      { type: "tool-input-end", toolCallId: "call_1|fc_1", name: "lookup" },
      { type: "tool-call", toolCallId: "call_1|fc_1", name: "lookup", input: { query: "bun" } },
      {
        type: "finish",
        reason: "tool-call",
        usage: { inputTokens: 25, outputTokens: 11, activeContextTokens: 36 },
      },
    ])
  })

  test("arguments arriving only on the done event still produce a parsed tool-call", async () => {
    const events = await decodeAll(doneOnlyArgumentsChunks)
    const toolCalls = events.filter(LLMEvent.is.toolCall)
    expect(toolCalls as Array<unknown>).toEqual([
      { type: "tool-call", toolCallId: "call_2|fc_2", name: "lookup", input: { query: "deno" } },
    ])
    const deltas = events.filter(LLMEvent.is.toolInputDelta)
    expect(deltas).toHaveLength(0)
  })

  test("parallel function calls finish independently", async () => {
    const events = await decodeAll(parallelFunctionCallTurnChunks)
    expect(events as Array<unknown>).toEqual([
      { type: "tool-input-start", toolCallId: "call_1|fc_1", name: "lookup" },
      { type: "tool-input-start", toolCallId: "call_2|fc_2", name: "lookup" },
      { type: "tool-input-delta", toolCallId: "call_1|fc_1", text: '{"query":"bun"}' },
      { type: "tool-input-delta", toolCallId: "call_2|fc_2", text: '{"query":' },
      { type: "tool-input-end", toolCallId: "call_1|fc_1", name: "lookup" },
      { type: "tool-call", toolCallId: "call_1|fc_1", name: "lookup", input: { query: "bun" } },
      { type: "tool-input-delta", toolCallId: "call_2|fc_2", text: '"deno"}' },
      { type: "tool-input-end", toolCallId: "call_2|fc_2", name: "lookup" },
      { type: "tool-call", toolCallId: "call_2|fc_2", name: "lookup", input: { query: "deno" } },
      {
        type: "finish",
        reason: "tool-call",
        usage: { inputTokens: 28, outputTokens: 13, activeContextTokens: 41 },
      },
    ])
  })

  test("invalid function-call JSON fails with invalid-provider-output", async () => {
    const error = await decodeFailure(invalidToolJsonChunks)
    expect(error).toBeInstanceOf(LLMError)
    expect(error.reason).toBe("invalid-provider-output")
  })

  test("incomplete responses lower max_output_tokens to length", async () => {
    const events = await decodeAll(incompleteTurnChunks)
    expect(events.at(-1)).toEqual({
      type: "finish",
      reason: "length",
      usage: { inputTokens: 9, outputTokens: 3, activeContextTokens: 12 },
    })
  })

  test("response failure events fail with LLMError", async () => {
    const error = await decodeFailure(failedResponseChunks)
    expect(error).toBeInstanceOf(LLMError)
    expect(error.reason).toBe("server-error")
    expect(error.message).toBe("internal failure")
  })

  test("quota errors map to non-retryable rate-limited", async () => {
    const error = await decodeFailure(quotaErrorChunks)
    expect(error).toBeInstanceOf(LLMError)
    expect(error.reason).toBe("rate-limited")
    expect(error.retryable).toBe(false)
  })

  test("successful fixture streams end with exactly one final finish", async () => {
    for (const fixture of [
      textReasoningTurnChunks,
      functionCallTurnChunks,
      doneOnlyArgumentsChunks,
      incompleteTurnChunks,
    ]) {
      const events = await decodeAll(fixture)
      const finishes = events.filter(LLMEvent.is.finish)
      expect(finishes).toHaveLength(1)
      expect(events.at(-1)?.type).toBe("finish")
      await Effect.runPromise(LLMTurnSummary.fromEvents(events))
    }
  })

  test("tool call id encoding is reversible", () => {
    const encoded = OpenAICodexResponses.encodeToolCallId("call_9", "fc_9")
    expect(String(encoded)).toBe("call_9|fc_9")
    expect(OpenAICodexResponses.splitToolCallId(encoded)).toEqual({
      callId: "call_9",
      itemId: "fc_9",
    })
    const bare = OpenAICodexResponses.encodeToolCallId("call_9", undefined)
    expect(OpenAICodexResponses.splitToolCallId(bare)).toEqual({ callId: "call_9" })
  })
})
