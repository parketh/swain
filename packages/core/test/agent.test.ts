import { describe, expect, test } from "bun:test"
import type { Model } from "@swain/llms"
import { ModelId, ProviderId } from "@swain/llms"
import { Stream } from "effect"
import { assembleSystemPrompt } from "../src/prompt"
import { createSessionState } from "../src/state"

const model: Model = {
  id: ModelId.make("test-model"),
  provider: ProviderId.make("test"),
  streamTurn: () => Stream.empty,
}

const baseInput = {
  workingDirectory: "/work",
  currentDate: "2026-07-04",
  model: "test-model",
  permissionMode: "ask" as const,
  tools: [
    { name: "Read", description: "read text file contents" },
    { name: "Write", description: "create a new text file" },
  ],
}

describe("assembleSystemPrompt", () => {
  test("includes identity, context, and tool names/descriptions", () => {
    const prompt = assembleSystemPrompt(baseInput)
    expect(prompt).toContain("You are Swain")
    expect(prompt).toContain("Working directory: /work")
    expect(prompt).toContain("Current date: 2026-07-04")
    expect(prompt).toContain("Model: test-model")
    expect(prompt).toContain("Permission mode: ask")
    expect(prompt).toContain("read text file contents")
    expect(prompt).toContain("Write")
  })

  test("is stable for identical input", () => {
    expect(assembleSystemPrompt(baseInput)).toBe(assembleSystemPrompt(baseInput))
  })

  test("changes when permission mode changes", () => {
    expect(assembleSystemPrompt(baseInput)).not.toBe(
      assembleSystemPrompt({ ...baseInput, permissionMode: "plan" }),
    )
  })

  test("changes when the tool set changes", () => {
    expect(assembleSystemPrompt(baseInput)).not.toBe(
      assembleSystemPrompt({ ...baseInput, tools: [baseInput.tools[0]!] }),
    )
  })
})

describe("createSessionState", () => {
  test("defaults permission mode to ask and starts with empty state", () => {
    const session = createSessionState({
      workingDirectory: "/work",
      model,
      currentDate: "2026-07-04",
    })
    expect(session.systemContext.permissionMode).toBe("ask")
    expect(session.messages).toEqual([])
    expect(session.fileState.size).toBe(0)
    expect(session.counters).toEqual({ turns: 0, inputTokens: 0, outputTokens: 0 })
    expect(session.sessionId).toBeString()
  })

  test("seeds messages and honors an explicit session id and mode", () => {
    const session = createSessionState({
      sessionId: "s-1",
      workingDirectory: "/work",
      model,
      permissionMode: "plan",
      currentDate: "2026-07-04",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    expect(session.sessionId).toBe("s-1")
    expect(session.systemContext.permissionMode).toBe("plan")
    expect(session.messages).toHaveLength(1)
  })
})
