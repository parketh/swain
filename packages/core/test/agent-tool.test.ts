import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunContext } from "@effect/platform-bun"
import type { Model, ToolCall } from "@swain/llms"
import { ModelId, ProviderId, ToolCallId } from "@swain/llms"
import { Effect, Layer, Queue, Stream } from "effect"
import { type ChildRunner, makeOrchestrator, OrchestratorService } from "../src/orchestrator"
import { makePermissions } from "../src/permission"
import { createSessionState } from "../src/state"
import { createTask, getTask, taskStoreLayer } from "../src/tasks"
import { builtinTools, callTool, ToolContext, toolRegistryLayer } from "../src/tools"
import { recordingApproval, scriptedLLMClient } from "./utils/harness"

const model: Model = {
  id: ModelId.make("test-model"),
  provider: ProviderId.make("test"),
  streamTurn: () => Stream.empty,
}

const toolCall = (input: unknown): ToolCall => ({
  type: "tool-call",
  toolCallId: ToolCallId.make("call-1"),
  name: "Agent",
  input,
})

// biome-ignore lint/suspicious/noExplicitAny: opaque tool-result JSON
const value = (result: { result: { value?: unknown } }): any => result.result.value

describe("Agent tool", () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "swain-agent-tool-"))
    execSync("git init -q", { cwd: repo })
    execSync("git config user.email t@t.com && git config user.name t", { cwd: repo })
    writeFileSync(join(repo, "seed.txt"), "seed\n")
    execSync("git add -A && git commit -q -m init", { cwd: repo })
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  const okRunner: ChildRunner = () => Effect.succeed("done")

  const drive = <A>(
    // biome-ignore lint/suspicious/noExplicitAny: store/spawn requirements are provided by the layers
    build: (deps: {
      readonly recorder: ReturnType<typeof recordingApproval>
    }) => Effect.Effect<A, unknown, any>,
  ): Promise<A> => {
    const recorder = recordingApproval()
    const layers = Layer.mergeAll(
      taskStoreLayer(repo).pipe(Layer.provideMerge(BunContext.layer)),
      scriptedLLMClient([]),
    )
    return Effect.runPromise(
      // biome-ignore lint/suspicious/noExplicitAny: all requirements provided by the layers
      build({ recorder }).pipe(Effect.provide(layers)) as Effect.Effect<A, unknown, never>,
    )
  }

  const context = (
    permissionMode: "ask" | "auto",
    approval: Parameters<typeof makePermissions>[1],
  ) =>
    Layer.succeed(ToolContext, {
      session: createSessionState({ workingDirectory: repo, model, currentDate: "2026-07-08" }),
      abortSignal: new AbortController().signal,
      permission: makePermissions(() => permissionMode, approval),
    })

  test("with no taskId, creates and claims a task and returns a spawned result", async () => {
    const result = await drive(({ recorder }) =>
      Effect.gen(function* () {
        const orch = yield* makeOrchestrator({ runChild: okRunner })
        const spawned = yield* callTool(toolCall({ description: "probe", prompt: "look" })).pipe(
          Effect.provideService(OrchestratorService, orch),
          Effect.provide(context("auto", recorder.approval)),
          Effect.provide(toolRegistryLayer(builtinTools)),
        )
        yield* Queue.take(orch.completions)
        const task = yield* getTask(value(spawned).taskId)
        return { spawned, task }
      }),
    )
    expect(value(result.spawned).status).toBe("spawned")
    expect(value(result.spawned).agentType).toBe("GeneralPurpose")
    expect(result.task.status).toBe("completed")
  })

  test("with a taskId, claims the existing task", async () => {
    const result = await drive(({ recorder }) =>
      Effect.gen(function* () {
        const existing = yield* createTask({ subject: "existing", description: "brief" })
        const orch = yield* makeOrchestrator({ runChild: okRunner })
        const spawned = yield* callTool(
          toolCall({
            description: "probe",
            prompt: "look",
            subagentType: "Explore",
            taskId: existing.id,
          }),
        ).pipe(
          Effect.provideService(OrchestratorService, orch),
          Effect.provide(context("auto", recorder.approval)),
          Effect.provide(toolRegistryLayer(builtinTools)),
        )
        yield* Queue.take(orch.completions)
        const task = yield* getTask(existing.id)
        return { existingId: existing.id, spawned, task }
      }),
    )
    expect(value(result.spawned).taskId).toBe(result.existingId)
    expect(result.task.agentType).toBe("Explore")
    expect(result.task.status).toBe("completed")
  })

  test("an ask-mode child surfaces its approval request through the parent approval path", async () => {
    const checkingRunner: ChildRunner = (ctx) =>
      ctx.context.permission
        .check({ toolName: "Bash", readOnly: false, summary: "rm -rf build" })
        .pipe(Effect.as("checked"))
    const seen = await drive(({ recorder }) =>
      Effect.gen(function* () {
        const orch = yield* makeOrchestrator({ runChild: checkingRunner })
        yield* callTool(
          toolCall({ description: "probe", prompt: "look", subagentType: "Explore" }),
        ).pipe(
          Effect.provideService(OrchestratorService, orch),
          Effect.provide(context("ask", recorder.approval)),
          Effect.provide(toolRegistryLayer(builtinTools)),
        )
        yield* Queue.take(orch.completions)
        return recorder.seen
      }),
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]?.toolName).toBe("Bash")
  })
})
