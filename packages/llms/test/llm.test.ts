import { describe, expect, test } from "bun:test"

import { LLM, Message, ModelId, ProviderId } from "@swain/llms"
import type { Model } from "@swain/llms"
import { Stream } from "effect"

const model: Model = {
  id: ModelId.make("test-model"),
  provider: ProviderId.make("test"),
  streamTurn: () => Stream.empty,
}

describe("LLM.request", () => {
  test("prompt becomes one trailing user message", () => {
    const request = LLM.request({ model, prompt: "Say hello." })

    expect(request.messages).toHaveLength(1)
    expect(request.messages[0]).toEqual({
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
