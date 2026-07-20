import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunContext } from "@effect/platform-bun"
import type { LLMEvent, Model, ToolCall } from "@swain/llms"
import {
  ContentId,
  LLMClient,
  LLMError,
  LLMTurnSummary,
  Message,
  ModelId,
  ProviderId,
  ToolCallId,
} from "@swain/llms"
import { Effect, Layer, Schema, Stream } from "effect"
import { type AgentEvent, runTurn, submitPrompt } from "../src/agent"
import { AgentError, ToolError } from "../src/errors"
import type { Permissions } from "../src/permission"
import { assembleSystemPrompt } from "../src/prompt"
import { createSessionState, loadSession, type SessionState, saveSession } from "../src/state"
import {
  AGENT_DESCRIPTION,
  Ask,
  AskService,
  callTool,
  defineTool,
  ToolContext,
  toLLMTool,
  toolRegistryLayer,
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
  tools: ReadonlyArray<Parameters<typeof toolRegistryLayer>[0][number]>,
) =>
  Effect.runPromise(
    callTool(call).pipe(
      Effect.provide(toolContextLayer(session())),
      Effect.provide(toolRegistryLayer(tools)),
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

  test("includes task to-do guidance and the Agent reminder only when those tools are present", () => {
    const withTaskAndAgent = assembleSystemPrompt({
      ...baseInput,
      tools: [
        { name: "TaskCreate", description: "add a task" },
        { name: "Agent", description: "spawn a subagent" },
      ],
    })
    expect(withTaskAndAgent).toContain("task list")
    expect(withTaskAndAgent).toContain("to-do list")
    expect(withTaskAndAgent).toContain("Use Agent for independent exploration")

    // A child registry (no Agent, no Task* tools) must not carry that guidance.
    const childPrompt = assembleSystemPrompt({
      ...baseInput,
      tools: [
        { name: "Read", description: "read a file" },
        { name: "Grep", description: "search" },
      ],
    })
    expect(childPrompt).not.toContain("Use Agent for independent exploration")
    expect(childPrompt).not.toContain("to-do list")
  })

  test("Agent tool description carries the detailed subagent usage guidance", () => {
    expect(AGENT_DESCRIPTION).toContain("Available subagent types")
    expect(AGENT_DESCRIPTION).toContain("Explore")
    expect(AGENT_DESCRIPTION).toContain("GeneralPurpose")
    expect(AGENT_DESCRIPTION).toContain("isolated worktree")
    expect(AGENT_DESCRIPTION).toContain("does not inherit the parent conversation")
    expect(AGENT_DESCRIPTION).toContain("Wait for the task notification")
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
      messages: [Message.user("hi")],
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

  test("toLLMTool gives a zero-arg tool a valid object parameters schema", () => {
    // Schema.Struct({}) alone compiles to a typeless anyOf, which strict
    // function-calling APIs (OpenAI Responses/Codex) reject.
    const noArg = defineTool({
      name: "NoArg",
      description: "takes nothing",
      inputSchema: Schema.Struct({}),
      outputSchema: Schema.Struct({ ok: Schema.Boolean }),
      readOnly: true,
      call: () => Effect.succeed({ ok: true }),
    })
    const llmTool = toLLMTool(noArg)
    expect(llmTool.inputSchema.type).toBe("object")
    expect(llmTool.inputSchema).not.toHaveProperty("anyOf")
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
        Effect.provide(toolRegistryLayer([echo])),
      ),
    )

    expect(first.finish.reason).toBe("tool-call")
    expect(toolResult.result).toEqual({ type: "json", value: { echoed: "hi" } })
    expect(second.text).toBe("done")
  })
})

describe("runTurn", () => {
  const echo = defineTool({
    name: "Echo",
    description: "echoes a message",
    inputSchema: Schema.Struct({ msg: Schema.String }),
    outputSchema: Schema.Struct({ echoed: Schema.String }),
    readOnly: true,
    call: (input) => Effect.succeed({ echoed: input.msg }),
  })

  const timedEcho = defineTool({
    name: "TimedEcho",
    description: "echoes with timing",
    inputSchema: Schema.Struct({ msg: Schema.String }),
    outputSchema: Schema.Struct({ echoed: Schema.String }),
    readOnly: true,
    recordDuration: true,
    call: (input) => Effect.succeed({ echoed: input.msg }),
  })

  const timedBoom = defineTool({
    name: "TimedBoom",
    description: "fails with timing",
    inputSchema: Schema.Struct({}),
    outputSchema: Schema.Struct({ ok: Schema.Boolean }),
    readOnly: true,
    recordDuration: true,
    call: () =>
      Effect.fail(
        new ToolError({ tool: "TimedBoom", reason: "execution-failed", message: "boom" }),
      ),
  })

  const drive = (
    turns: Parameters<typeof scriptedLLMClient>[0],
    tools: ReadonlyArray<Parameters<typeof toolRegistryLayer>[0][number]>,
    options?: { maxIterations?: number },
  ) => {
    const state = session()
    submitPrompt(state, "hi")
    return {
      state,
      run: Effect.runPromise(
        runTurn(state, options).pipe(
          Effect.provide(scriptedLLMClient(turns)),
          Effect.provide(toolContextLayer(state)),
          Effect.provide(toolRegistryLayer(tools)),
        ),
      ),
    }
  }

  test("a text-only turn appends the assistant message", async () => {
    const { state, run } = drive([textTurn("hello there")], [])
    await run
    expect(state.messages).toHaveLength(2)
    expect(state.messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "hello there" }],
    })
    expect(state.counters.turns).toBe(1)
    expect(state.counters.outputTokens).toBe(1)
    // Provider usage is recorded as the context snapshot, anchored at the end.
    expect(state.contextUsage).toEqual({ activeContextTokens: 2, measuredAtMessageIndex: 2 })
    // The lone assistant response carries both provider-response and turn latency.
    const final = state.messages[1]
    expect(final?.responseDurationMs).toBeTypeOf("number")
    expect(final?.responseDurationMs).toBeGreaterThanOrEqual(0)
    expect(final?.turnDurationMs).toBeGreaterThanOrEqual(0)
  })

  test("executes a tool call and submits the result to the next turn", async () => {
    const { state, run } = drive([toolCallTurn("Echo", { msg: "hi" }), textTurn("done")], [echo])
    await run
    // user, assistant(tool-call), user(tool-result), assistant("done")
    expect(state.messages).toHaveLength(4)
    const toolResult = state.messages[2]
    expect(toolResult?.role).toBe("user")
    expect(toolResult?.content[0]).toMatchObject({
      type: "tool-result",
      result: { type: "json", value: { echoed: "hi" } },
    })
    expect(state.messages[3]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    })
    // Every provider response is timed; only the final assistant gets turn latency.
    expect(state.messages[1]?.responseDurationMs).toBeTypeOf("number")
    expect(state.messages[1]?.turnDurationMs).toBeUndefined()
    expect(state.messages[3]?.responseDurationMs).toBeTypeOf("number")
    expect(state.messages[3]?.turnDurationMs).toBeGreaterThanOrEqual(0)
  })

  const durationOf = (state: SessionState, index: number): number | undefined => {
    const block = state.messages[index]?.content[0]
    return block?.type === "tool-result" ? block.durationMs : undefined
  }

  test("an opted-in tool result carries durationMs on success", async () => {
    const { state, run } = drive(
      [toolCallTurn("TimedEcho", { msg: "hi" }), textTurn("done")],
      [timedEcho],
    )
    await run
    expect(durationOf(state, 2)).toBeTypeOf("number")
    expect(durationOf(state, 2)).toBeGreaterThanOrEqual(0)
  })

  test("an opted-in tool result carries durationMs even when the tool errors", async () => {
    const { state, run } = drive([toolCallTurn("TimedBoom", {}), textTurn("done")], [timedBoom])
    await run
    expect(state.messages[2]?.content[0]).toMatchObject({ type: "tool-result", isError: true })
    expect(durationOf(state, 2)).toBeTypeOf("number")
  })

  test("an unflagged tool result has no durationMs", async () => {
    const { state, run } = drive([toolCallTurn("Echo", { msg: "hi" }), textTurn("done")], [echo])
    await run
    expect(state.messages[2]?.content[0]).toMatchObject({ type: "tool-result" })
    expect(durationOf(state, 2)).toBeUndefined()
  })

  test("every core-committed message carries a valid createdAt", async () => {
    const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    const { state, run } = drive([toolCallTurn("Echo", { msg: "hi" }), textTurn("done")], [echo])
    await run
    // user prompt, assistant(tool-call), user(tool-result), assistant(done)
    expect(state.messages).toHaveLength(4)
    for (const message of state.messages) {
      expect(message.createdAt).toMatch(isoRe)
    }
  })

  // LLM client whose stream fails `failures` times (with a retryable or
  // non-retryable error) before replaying `success`, counting attempts.
  const flakyLLM = (failures: number, retryable: boolean, success: ReadonlyArray<LLMEvent>) => {
    let calls = 0
    return {
      calls: () => calls,
      layer: Layer.succeed(LLMClient.Service, {
        request: LLMClient.request,
        streamTurn: () => {
          calls += 1
          return calls <= failures
            ? Stream.fail(
                new LLMError({
                  reason: retryable ? "network-error" : "invalid-request",
                  message: "provider stalled",
                  retryable,
                }),
              )
            : Stream.fromIterable(success)
        },
        generateTurn: () => Effect.succeed({ events: [] }),
      }),
    }
  }

  const runFlaky = (flaky: ReturnType<typeof flakyLLM>, state: SessionState) =>
    runTurn(state).pipe(
      Effect.provide(flaky.layer),
      Effect.provide(toolContextLayer(state)),
      Effect.provide(toolRegistryLayer([])),
    )

  test("retries a retryable stream stall and recovers the turn", async () => {
    const flaky = flakyLLM(1, true, textTurn("recovered"))
    const state = session()
    submitPrompt(state, "hi")
    await Effect.runPromise(runFlaky(flaky, state))
    expect(flaky.calls()).toBe(2) // one stall + one success
    expect(state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "recovered" }],
    })
    // Response duration spans the failed attempt and the retry backoff (~1s).
    expect(state.messages.at(-1)?.responseDurationMs).toBeGreaterThan(900)
  })

  test("gives up after the retry budget and fails the turn", async () => {
    const flaky = flakyLLM(5, true, textTurn("never"))
    const state = session()
    submitPrompt(state, "hi")
    const exit = await Effect.runPromiseExit(runFlaky(flaky, state))
    expect(exit._tag).toBe("Failure")
    expect(flaky.calls()).toBe(3) // initial + 2 retries (MAX_STREAM_RETRIES)
    // A failed turn commits no response and fabricates no turn duration.
    expect(state.messages.every((m) => m.turnDurationMs === undefined)).toBe(true)
    expect(state.messages.every((m) => m.responseDurationMs === undefined)).toBe(true)
  })

  test("does not retry a non-retryable error", async () => {
    const flaky = flakyLLM(1, false, textTurn("x"))
    const state = session()
    submitPrompt(state, "hi")
    const exit = await Effect.runPromiseExit(runFlaky(flaky, state))
    expect(exit._tag).toBe("Failure")
    expect(flaky.calls()).toBe(1) // failed once, no retry
  })

  test("forwards llm events, step boundaries, and tool lifecycle to onEvent", async () => {
    const contentId = ContentId.make("c-1")
    const twoDeltaTurn: ReadonlyArray<LLMEvent> = [
      { type: "text-start", contentId },
      { type: "text-delta", contentId, text: "he" },
      { type: "text-delta", contentId, text: "llo" },
      { type: "text-end", contentId },
      { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 2 } },
    ]
    const state = session()
    submitPrompt(state, "hi")
    const events: Array<AgentEvent> = []
    await Effect.runPromise(
      runTurn(state, {
        onEvent: (event) => Effect.sync(() => events.push(event)),
      }).pipe(
        Effect.provide(scriptedLLMClient([twoDeltaTurn])),
        Effect.provide(toolContextLayer(state)),
        Effect.provide(toolRegistryLayer([])),
      ),
    )

    const deltas = events
      .filter((e) => e.type === "llm-event" && e.event.type === "text-delta")
      .map((e) => (e.type === "llm-event" && e.event.type === "text-delta" ? e.event.text : ""))
    expect(deltas).toEqual(["he", "llo"])

    const stepStart = events.findIndex((e) => e.type === "step-start")
    const firstDelta = events.findIndex(
      (e) => e.type === "llm-event" && e.event.type === "text-delta",
    )
    const stepEnd = events.findIndex((e) => e.type === "step-end")
    expect(stepStart).toBeGreaterThanOrEqual(0)
    expect(stepStart).toBeLessThan(firstDelta)
    expect(firstDelta).toBeLessThan(stepEnd)
    const end = events.find((e) => e.type === "step-end")
    expect(end).toMatchObject({ reason: "stop", usage: { inputTokens: 1, outputTokens: 2 } })
  })

  test("emits tool-execution-start before and tool-execution-end after callTool", async () => {
    const state = session()
    submitPrompt(state, "hi")
    const events: Array<AgentEvent> = []
    await Effect.runPromise(
      runTurn(state, {
        onEvent: (event) => Effect.sync(() => events.push(event)),
      }).pipe(
        Effect.provide(scriptedLLMClient([toolCallTurn("Echo", { msg: "hi" }), textTurn("done")])),
        Effect.provide(toolContextLayer(state)),
        Effect.provide(toolRegistryLayer([echo])),
      ),
    )
    const start = events.findIndex((e) => e.type === "tool-execution-start")
    const finish = events.findIndex((e) => e.type === "tool-execution-end")
    expect(start).toBeGreaterThanOrEqual(0)
    expect(start).toBeLessThan(finish)
    expect(events[start]).toMatchObject({ name: "Echo", input: { msg: "hi" } })
    expect(events[finish]).toMatchObject({ name: "Echo", isError: false })
  })

  test("emits one non-recoverable llm agent-error before failing on a fatal LLMError", async () => {
    const failingLLM = Layer.succeed(LLMClient.Service, {
      request: LLMClient.request,
      streamTurn: () =>
        Stream.fail(new LLMError({ reason: "server-error", message: "boom", retryable: false })),
      generateTurn: () =>
        Effect.fail(new LLMError({ reason: "server-error", message: "boom", retryable: false })),
    })
    const state = session()
    submitPrompt(state, "hi")
    const events: Array<AgentEvent> = []
    const error = await Effect.runPromise(
      runTurn(state, {
        onEvent: (event) => Effect.sync(() => events.push(event)),
      }).pipe(
        Effect.flip,
        Effect.provide(failingLLM),
        Effect.provide(toolContextLayer(state)),
        Effect.provide(toolRegistryLayer([])),
      ),
    )
    expect(error).toBeInstanceOf(LLMError)
    const agentErrors = events.filter((e) => e.type === "agent-error")
    expect(agentErrors).toHaveLength(1)
    expect(agentErrors[0]).toMatchObject({ source: "llm", recoverable: false })
    // No assistant message is appended when the turn fails.
    expect(state.messages).toHaveLength(1)
  })

  test("appends the assistant message only after the turn completes", async () => {
    const { state, run } = drive([textTurn("final")], [])
    expect(state.messages).toHaveLength(1)
    await run
    expect(state.messages).toHaveLength(2)
    expect(state.messages[1]).toMatchObject({ role: "assistant" })
  })

  test("withholds tools on the final iteration so the model concludes gracefully", async () => {
    // A tool-aware client: it keeps calling a tool whenever tools are offered,
    // and produces final text when they are withheld (the last iteration).
    const toolAwareLLM = Layer.succeed(LLMClient.Service, {
      request: LLMClient.request,
      streamTurn: (request: Parameters<typeof LLMClient.streamTurn>[0]) =>
        Stream.fromIterable(
          request.tools !== undefined && request.tools.length > 0
            ? toolCallTurn("Echo", { msg: "again" })
            : textTurn("final answer"),
        ),
      generateTurn: () => Effect.succeed({ events: [] }),
    })
    const state = session()
    submitPrompt(state, "hi")
    await Effect.runPromise(
      runTurn(state, { maxIterations: 3 }).pipe(
        Effect.provide(toolAwareLLM),
        Effect.provide(toolContextLayer(state)),
        Effect.provide(toolRegistryLayer([echo])),
      ),
    )
    // No max-iterations failure: the turn ends with the model's final text.
    expect(state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "final answer" }],
    })
  })

  test("fails with a typed error when the tool loop never terminates", async () => {
    const state = session()
    submitPrompt(state, "hi")
    const error = await Effect.runPromise(
      runTurn(state, { maxIterations: 3 }).pipe(
        Effect.flip,
        Effect.provide(scriptedLLMClient([toolCallTurn("Echo", { msg: "hi" })])),
        Effect.provide(toolContextLayer(state)),
        Effect.provide(toolRegistryLayer([echo])),
      ),
    )
    expect(error).toBeInstanceOf(AgentError)
    expect((error as AgentError).reason).toBe("max-iterations")
  })
})

describe("Ask tool", () => {
  test("produces the injected answers as a tool result", async () => {
    const askLayer = Layer.succeed(AskService, {
      ask: (input) =>
        Effect.succeed({
          answers: input.questions.map((question) => ({
            question: question.question,
            selected: [question.options[0]?.label ?? ""],
          })),
        }),
    })

    const result = await Effect.runPromise(
      callTool(
        toolCall("Ask", {
          questions: [
            {
              question: "Framework?",
              options: [
                { label: "Bun", description: "Fast all-in-one runtime" },
                { label: "Node", description: "Mature, widely supported" },
              ],
            },
          ],
        }),
      ).pipe(
        Effect.provide(toolContextLayer(session())),
        Effect.provide(toolRegistryLayer([Ask])),
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

describe("session persistence", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swain-store-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("saved transcript reloads with restored counters and an empty file cache", async () => {
    const original = createSessionState({
      sessionId: "s-persist",
      workingDirectory: dir,
      model,
      permissionMode: "auto",
      currentDate: "2026-07-04",
    })
    submitPrompt(original, "remember this")
    original.messages.push(Message.assistant([{ type: "text", text: "noted" }]))
    original.counters.turns = 2
    original.counters.inputTokens = 11
    original.counters.outputTokens = 7
    original.fileState.set("/tmp/whatever", {
      path: "/tmp/whatever",
      kind: "text",
      lastModifiedMs: 1,
      digest: "d",
      content: "c",
    })

    const reloaded = await Effect.runPromise(
      saveSession(original, dir)
        .pipe(Effect.andThen(loadSession({ sessionId: "s-persist", model, sessionsDir: dir })))
        .pipe(Effect.provide(BunContext.layer)),
    )

    expect(reloaded.sessionId).toBe("s-persist")
    expect(reloaded.systemContext.permissionMode).toBe("auto")
    expect(reloaded.messages).toEqual(original.messages)
    expect(reloaded.counters).toEqual({ turns: 2, inputTokens: 11, outputTokens: 7 })
    expect(reloaded.fileState.size).toBe(0)
  })
})

describe("runTurn compaction", () => {
  const limitedModel: Model = {
    id: ModelId.make("limited"),
    provider: ProviderId.make("test"),
    limits: { contextWindow: 10_000, maxOutputTokens: 1_000 },
    streamTurn: () => Stream.empty,
  }

  const summaryText = "## Goal\ncompacted"
  const summaryTurn: ReadonlyArray<LLMEvent> = [
    { type: "text-start", contentId: ContentId.make("sum") },
    { type: "text-delta", contentId: ContentId.make("sum"), text: summaryText },
    { type: "text-end", contentId: ContentId.make("sum") },
    { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
  ]

  const conversation = (): Array<Message> => [
    Message.user("first"),
    Message.assistant([{ type: "text", text: "one" }]),
    Message.user("second"),
    Message.assistant([{ type: "text", text: "two" }]),
  ]

  const limitedSession = (): SessionState =>
    createSessionState({
      workingDirectory: "/work",
      model: limitedModel,
      currentDate: "2026-07-04",
      messages: conversation(),
    })

  const overflow = new LLMError({
    reason: "context-length-exceeded",
    message: "prompt is too long",
    retryable: false,
  })

  const compactionBlocks = (state: SessionState) =>
    state.messages.flatMap((m) => m.content.filter((b) => b.type === "compaction"))

  test("auto-compacts before the turn when pressure exceeds 90% of the window", async () => {
    const state = limitedSession()
    // Effective window = 9_000; 90% = 8_100. Snapshot pushes us over.
    state.contextUsage = { activeContextTokens: 8_500, measuredAtMessageIndex: 4 }
    submitPrompt(state, "third")
    await Effect.runPromise(
      runTurn(state).pipe(
        Effect.provide(scriptedLLMClient([summaryTurn, textTurn("answer")])),
        Effect.provide(toolContextLayer(state)),
        Effect.provide(toolRegistryLayer([])),
      ),
    )
    expect(state.compaction.summary).toBe(summaryText)
    expect(compactionBlocks(state)).toHaveLength(1)
  })

  test("disables auto compaction after one auto failure but still runs the turn", async () => {
    const state = limitedSession()
    state.contextUsage = { activeContextTokens: 8_500, measuredAtMessageIndex: 4 }
    submitPrompt(state, "third")
    // The summary call returns no text -> empty-summary compaction failure.
    const emptyTurn: ReadonlyArray<LLMEvent> = [{ type: "finish", reason: "stop" }]
    await Effect.runPromise(
      runTurn(state).pipe(
        Effect.provide(scriptedLLMClient([emptyTurn, textTurn("answer")])),
        Effect.provide(toolContextLayer(state)),
        Effect.provide(toolRegistryLayer([])),
      ),
    )
    expect(state.compaction.autoEnabled).toBe(false)
    expect(state.compaction.failureReason).toBeDefined()
    // The turn still completed on the original transcript.
    expect(state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
    })
  })

  test("a context overflow triggers one compaction and retries the turn", async () => {
    const state = limitedSession()
    submitPrompt(state, "third")
    let streamCount = 0
    const layer = Layer.succeed(LLMClient.Service, {
      request: LLMClient.request,
      streamTurn: () => {
        streamCount += 1
        return streamCount === 1
          ? Stream.fail(overflow)
          : Stream.fromIterable(textTurn("recovered"))
      },
      generateTurn: () => Effect.succeed({ events: [...summaryTurn] }),
    })
    await Effect.runPromise(
      runTurn(state).pipe(
        Effect.provide(layer),
        Effect.provide(toolContextLayer(state)),
        Effect.provide(toolRegistryLayer([])),
      ),
    )
    expect(state.compaction.summary).toBe(summaryText)
    expect(state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "recovered" }],
    })
  })

  test("a second overflow after retry surfaces the typed error", async () => {
    const state = limitedSession()
    submitPrompt(state, "third")
    const layer = Layer.succeed(LLMClient.Service, {
      request: LLMClient.request,
      streamTurn: () => Stream.fail(overflow),
      generateTurn: () => Effect.succeed({ events: [...summaryTurn] }),
    })
    const error = await Effect.runPromise(
      runTurn(state).pipe(
        Effect.provide(layer),
        Effect.provide(toolContextLayer(state)),
        Effect.provide(toolRegistryLayer([])),
        Effect.flip,
      ),
    )
    expect(error).toBeInstanceOf(LLMError)
    if (error instanceof LLMError) expect(error.reason).toBe("context-length-exceeded")
  })
})
