import { describe, expect, test } from "bun:test"
import type { Model, ToolCall } from "@swain/llms"
import { LLMClient, LLMTurnSummary, ModelId, ProviderId, ToolCallId } from "@swain/llms"
import { Effect, Layer, Schema, Stream } from "effect"
import type { Permissions } from "../src/permission"
import { assembleSystemPrompt } from "../src/prompt"
import { createSessionState, type SessionState } from "../src/state"
import {
  Ask,
  AskService,
  callTool,
  defineTool,
  registryLayer,
  ToolContext,
  toLLMTool,
} from "../src/tools"
import { textTurn, toolCallTurn } from "./utils/fixtures"
import { scriptedLLMClient } from "./utils/harness"

const model: Model = {
  id: ModelId.make("test-model"),
  provider: ProviderId.make("test"),
  streamTurn: () => Stream.empty,
}

const allowPermissions: Permissions = { check: () => Effect.succeed({ type: "allow" }) }

const session = (): SessionState =>
  createSessionState({ workingDirectory: "/work", model, currentDate: "2026-07-04" })

const toolContextLayer = (state: SessionState) =>
  Layer.succeed(ToolContext, {
    session: state,
    abortSignal: new AbortController().signal,
    permission: allowPermissions,
  })

const toolCall = (name: string, input: unknown): ToolCall => ({
  type: "tool-call",
  toolCallId: ToolCallId.make("call-1"),
  name,
  input,
})

const runCall = (
  call: ToolCall,
  tools: ReadonlyArray<Parameters<typeof registryLayer>[0][number]>,
) =>
  Effect.runPromise(
    callTool(call).pipe(
      Effect.provide(toolContextLayer(session())),
      Effect.provide(registryLayer(tools)),
    ),
  )

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
    const state = createSessionState({
      sessionId: "s-1",
      workingDirectory: "/work",
      model,
      permissionMode: "plan",
      currentDate: "2026-07-04",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    expect(state.sessionId).toBe("s-1")
    expect(state.systemContext.permissionMode).toBe("plan")
    expect(state.messages).toHaveLength(1)
  })
})

describe("tool registry and caller", () => {
  const doubler = defineTool({
    name: "Doubler",
    description: "doubles a number",
    inputSchema: Schema.Struct({ value: Schema.Number }),
    outputSchema: Schema.Struct({ doubled: Schema.Number }),
    readOnly: true,
    call: (input) => Effect.succeed({ doubled: input.value * 2 }),
  })

  test("toLLMTool derives a model-facing definition with JSON schemas", () => {
    const llmTool = toLLMTool(doubler)
    expect(llmTool.name).toBe("Doubler")
    expect(llmTool.inputSchema.type).toBe("object")
    expect(llmTool.outputSchema?.type).toBe("object")
  })

  test("valid call returns output as a ToolResultContent", async () => {
    const result = await runCall(toolCall("Doubler", { value: 21 }), [doubler])
    expect(result.type).toBe("tool-result")
    expect(result.isError).toBeUndefined()
    expect(result.result).toEqual({ type: "json", value: { doubled: 42 } })
  })

  test("unknown tool returns an error result", async () => {
    const result = await runCall(toolCall("Missing", {}), [doubler])
    expect(result.isError).toBe(true)
    expect(result.result.type).toBe("text")
  })

  test("invalid input never reaches call", async () => {
    let called = false
    const guarded = defineTool({
      name: "Guarded",
      description: "records invocation",
      inputSchema: Schema.Struct({ value: Schema.Number }),
      outputSchema: Schema.Struct({ ok: Schema.Boolean }),
      readOnly: true,
      call: () => {
        called = true
        return Effect.succeed({ ok: true })
      },
    })
    const result = await runCall(toolCall("Guarded", { value: "not-a-number" }), [guarded])
    expect(called).toBe(false)
    expect(result.isError).toBe(true)
  })

  test("invalid output fails before returning to the model", async () => {
    const badOutput = defineTool({
      name: "BadOutput",
      description: "returns the wrong shape",
      inputSchema: Schema.Struct({ value: Schema.Number }),
      outputSchema: Schema.Struct({ doubled: Schema.Number }),
      readOnly: true,
      call: () => Effect.succeed({ wrong: true } as unknown as { doubled: number }),
    })
    const result = await runCall(toolCall("BadOutput", { value: 1 }), [badOutput])
    expect(result.isError).toBe(true)
  })
})

describe("harness", () => {
  const echo = defineTool({
    name: "Echo",
    description: "echoes a message",
    inputSchema: Schema.Struct({ msg: Schema.String }),
    outputSchema: Schema.Struct({ echoed: Schema.String }),
    readOnly: true,
    call: (input) => Effect.succeed({ echoed: input.msg }),
  })

  test("drives a prompt through LLM -> tool -> LLM without network", async () => {
    const llm = scriptedLLMClient([toolCallTurn("Echo", { msg: "hi" }), textTurn("done")])
    const collect = (request: Parameters<typeof LLMClient.streamTurn>[0]) =>
      LLMClient.streamTurn(request).pipe(
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      )

    const program = Effect.gen(function* () {
      const request = LLMClient.request({ model, prompt: "hi" })
      const first = yield* LLMTurnSummary.fromEvents(yield* collect(request))
      const toolResult = yield* callTool(first.toolCalls[0]!)
      const second = yield* LLMTurnSummary.fromEvents(yield* collect(request))
      return { first, toolResult, second }
    })

    const { first, toolResult, second } = await Effect.runPromise(
      program.pipe(
        Effect.provide(llm),
        Effect.provide(toolContextLayer(session())),
        Effect.provide(registryLayer([echo])),
      ),
    )

    expect(first.finish.reason).toBe("tool-call")
    expect(toolResult.result).toEqual({ type: "json", value: { echoed: "hi" } })
    expect(second.text).toBe("done")
  })
})

describe("Ask tool", () => {
  test("produces the injected answers as a tool result", async () => {
    const askLayer = Layer.succeed(AskService, {
      ask: (input) =>
        Effect.succeed({
          answers: input.questions.map((question) => ({
            question: question.question,
            selected: [question.options[0] ?? ""],
          })),
        }),
    })

    const result = await Effect.runPromise(
      callTool(
        toolCall("Ask", {
          questions: [{ question: "Framework?", options: ["Bun", "Node"] }],
        }),
      ).pipe(
        Effect.provide(toolContextLayer(session())),
        Effect.provide(registryLayer([Ask])),
        Effect.provide(askLayer),
      ),
    )
    expect(result.isError).toBeUndefined()
    expect(result.result).toEqual({
      type: "json",
      value: { answers: [{ question: "Framework?", selected: ["Bun"] }] },
    })
  })
})
