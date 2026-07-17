import { describe, expect, test } from "bun:test"
import type { LLMEvent } from "@swain/llms"

import * as root from "@swain/llms"
import { LLM, LLMTurnSummary, Message, Tool, ToolChoice } from "@swain/llms"
import * as protocols from "@swain/llms/protocols"
import * as providers from "@swain/llms/providers"
import {
  Anthropic,
  DeepSeek,
  Kimi,
  OpenAI,
  OpenAICodex,
  OpenAICompatible,
  ZAI,
} from "@swain/llms/providers"
import * as schema from "@swain/llms/schema"
import * as transport from "@swain/llms/transport"
import { Effect } from "effect"

describe("public export paths", () => {
  test("all export paths resolve", () => {
    expect(root).toBeDefined()
    expect(schema).toBeDefined()
    expect(providers).toBeDefined()
    expect(protocols).toBeDefined()
    expect(transport).toBeDefined()
  })

  test("root exposes the public surface", () => {
    for (const name of [
      "LLM",
      "Message",
      "TextContent",
      "ReasoningContent",
      "ToolCallContent",
      "ToolResultContent",
      "Tool",
      "ToolChoice",
      "LLMEvent",
      "LLMTurnSummary",
      "LLMError",
    ]) {
      expect(root).toHaveProperty(name)
    }
  })

  test("providers path exposes every facade", () => {
    expect(OpenAI).toBeDefined()
    expect(OpenAICodex).toBeDefined()
    expect(Anthropic).toBeDefined()
    expect(OpenAICompatible).toBeDefined()
    expect(DeepSeek).toBeDefined()
    expect(ZAI).toBeDefined()
    expect(Kimi).toBeDefined()
  })

  test("root does not re-export lower-level protocol/transport/provider modules", () => {
    for (const name of [
      "OpenAIChat",
      "AnthropicMessages",
      "OpenAICodexResponses",
      "ToolInput",
      "Http",
      "SSE",
      "Auth",
      "OpenAI",
      "Anthropic",
    ]) {
      expect(root).not.toHaveProperty(name)
    }
  })
})

describe("public call sites", () => {
  test("constructs a request from only public exports", () => {
    const model = OpenAI.configure({ apiKey: "sk-test" }).chat("gpt-4.1-mini")
    const request = LLM.request({
      model,
      system: "You are a helpful coding assistant.",
      messages: [Message.user("Say hello and call a tool if needed.")],
      tools: [
        Tool.define({
          name: "lookup",
          description: "Look up a value",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        }),
      ],
      toolChoice: ToolChoice.auto,
    })
    expect(request.model).toBe(model)
    expect(request.system?.text).toBe("You are a helpful coding assistant.")
    expect(request.messages).toHaveLength(1)
    expect(request.tools?.[0]?.name).toBe("lookup")
  })

  test("constructs a user message containing a ToolResultContent", () => {
    const message = Message.user([
      {
        type: "tool-result",
        toolCallId: schema.ToolCallId.make("call_1"),
        name: "lookup",
        result: { type: "json", value: { answer: 42 } },
      },
    ])
    expect(message.role).toBe("user")
    expect(message.content[0]?.type).toBe("tool-result")
  })

  test("derives an LLMTurnSummary from a synthetic successful event list", () => {
    const contentId = schema.ContentId.make("content_1")
    const events: ReadonlyArray<LLMEvent> = [
      { type: "text-start", contentId },
      { type: "text-delta", contentId, text: "Hello" },
      { type: "text-delta", contentId, text: ", world" },
      { type: "text-end", contentId },
      { type: "finish", reason: "stop", usage: { inputTokens: 3, outputTokens: 2 } },
    ]
    const summary = Effect.runSync(LLMTurnSummary.fromEvents(events))
    expect(summary.text).toBe("Hello, world")
    expect(summary.finish.reason).toBe("stop")
    expect(summary.usage).toEqual({ inputTokens: 3, outputTokens: 2 })
  })
})
