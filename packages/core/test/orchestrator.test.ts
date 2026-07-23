import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunContext } from "@effect/platform-bun"
import type { Model } from "@swain/llms"
import { ModelId, ProviderId } from "@swain/llms"
import { Duration, Effect, Layer, Queue, Stream } from "effect"
import {
  type ChildRunContext,
  type ChildRunner,
  makeOrchestrator,
  type ParentRunContext,
  type SubagentEvent,
} from "../src/orchestrator"
import type { Permissions } from "../src/permission"
import { createSessionState } from "../src/state"
import { claimTask, getTask, taskStoreLayer } from "../src/tasks"
import { builtinTools, makeToolRegistry } from "../src/tools"
import { scriptedLLMClient } from "./utils/harness"

const model: Model = {
  id: ModelId.make("test-model"),
  provider: ProviderId.make("test"),
  streamTurn: () => Stream.empty,
}

const allow: Permissions = { check: () => Effect.succeed({ type: "allow" }) }

describe("orchestrator", () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "swain-orch-"))
    execSync("git init -q", { cwd: repo })
    execSync("git config user.email t@t.com && git config user.name t", { cwd: repo })
    writeFileSync(join(repo, "seed.txt"), "seed\n")
    execSync("git add -A && git commit -q -m init", { cwd: repo })
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  const parent = (): ParentRunContext => ({
    session: createSessionState({ workingDirectory: repo, model, currentDate: "2026-07-08" }),
    tools: makeToolRegistry(builtinTools),
    permission: allow,
  })

  // biome-ignore lint/suspicious/noExplicitAny: spawn's requirements are provided by the layers
  const runProgram = <A>(eff: (dir: string) => Effect.Effect<A, unknown, any>): Promise<A> => {
    const layers = Layer.mergeAll(
      taskStoreLayer(repo).pipe(Layer.provideMerge(BunContext.layer)),
      scriptedLLMClient([]),
    )
    return Effect.runPromise(
      // biome-ignore lint/suspicious/noExplicitAny: heterogeneous spawn requirements are all provided
      eff(repo).pipe(Effect.provide(layers)) as Effect.Effect<A, unknown, never>,
    )
  }

  test("child completion writes status and result to the task", async () => {
    const result = await runProgram(() =>
      Effect.gen(function* () {
        const orch = yield* makeOrchestrator({ runChild: () => Effect.succeed("the findings") })
        const spawned = yield* orch.spawn(
          { description: "probe", prompt: "look", agentType: "Explore" },
          parent(),
        )
        yield* Queue.take(orch.completions)
        return yield* getTask(spawned.taskId)
      }),
    )
    expect(result.status).toBe("completed")
    expect(result.result).toBe("the findings")
    expect(result.durationMs).toBeTypeOf("number")
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  test("child failure writes failed status and error", async () => {
    const result = await runProgram(() =>
      Effect.gen(function* () {
        const orch = yield* makeOrchestrator({
          runChild: () => Effect.fail(new Error("child blew up")),
        })
        const spawned = yield* orch.spawn(
          { description: "probe", prompt: "look", agentType: "Explore" },
          parent(),
        )
        yield* Queue.take(orch.completions)
        return yield* getTask(spawned.taskId)
      }),
    )
    expect(result.status).toBe("failed")
    expect(result.error).toContain("child blew up")
    expect(result.durationMs).toBeTypeOf("number")
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  test("onChildTrace receives a successful child snapshot with identity before cleanup", async () => {
    const traces: Array<import("../src/orchestrator").ChildTraceEvent> = []
    const result = await runProgram(() =>
      Effect.gen(function* () {
        const orch = yield* makeOrchestrator({
          runChild: (ctx) =>
            Effect.sync(() => {
              // biome-ignore lint/suspicious/noExplicitAny: minimal committed assistant message
              ctx.session.messages.push({
                role: "assistant",
                content: [{ type: "text", text: "child answer" }],
                createdAt: "2026-07-08T00:00:00.000Z",
                // biome-ignore lint/suspicious/noExplicitAny: shape matches AssistantMessage
              } as any)
              return "child answer"
            }) as ReturnType<ChildRunner>,
          onChildTrace: (event) => Effect.sync(() => void traces.push(event)),
        })
        const spawned = yield* orch.spawn(
          { description: "probe", prompt: "look", agentType: "Explore" },
          parent(),
        )
        yield* Queue.take(orch.completions)
        return spawned
      }),
    )
    expect(traces).toHaveLength(1)
    const trace = traces[0]!
    expect(trace.agentId).toBe(result.agentId)
    expect(trace.taskId).toBe(result.taskId)
    expect(trace.agentType).toBe("Explore")
    expect(trace.outcome).toEqual({ ok: true })
    // The live child session (with its committed transcript) is handed over.
    expect(trace.session.messages.some((m) => m.role === "assistant")).toBe(true)
    expect(trace.tools.length).toBeGreaterThan(0)
    // Child tool registries never expose Agent (no recursive spawning).
    expect(trace.tools.some((t) => t.name === "Agent")).toBe(false)
  })

  test("onChildTrace receives a failed child snapshot with the error", async () => {
    const traces: Array<import("../src/orchestrator").ChildTraceEvent> = []
    await runProgram(() =>
      Effect.gen(function* () {
        const orch = yield* makeOrchestrator({
          runChild: () => Effect.fail(new Error("child blew up")),
          onChildTrace: (event) => Effect.sync(() => void traces.push(event)),
        })
        yield* orch.spawn({ description: "probe", prompt: "look", agentType: "Explore" }, parent())
        yield* Queue.take(orch.completions)
      }),
    )
    expect(traces).toHaveLength(1)
    expect(traces[0]!.outcome).toEqual({ ok: false, error: "child blew up" })
  })

  test("a failing onChildTrace sink still persists the task and rings the doorbell", async () => {
    const result = await runProgram(() =>
      Effect.gen(function* () {
        const orch = yield* makeOrchestrator({
          runChild: () => Effect.succeed("the findings"),
          onChildTrace: () => Effect.fail(new Error("sink boom")),
        })
        const spawned = yield* orch.spawn(
          { description: "probe", prompt: "look", agentType: "Explore" },
          parent(),
        )
        // Doorbell must still ring; if the sink failure escaped, this would hang.
        yield* Queue.take(orch.completions)
        return yield* getTask(spawned.taskId)
      }),
    )
    expect(result.status).toBe("completed")
    expect(result.result).toBe("the findings")
  })

  test("durationMs measures the child run, not orchestration overhead", async () => {
    const runner: ChildRunner = () =>
      Effect.sleep(Duration.millis(50)).pipe(Effect.as("slept")) as ReturnType<ChildRunner>
    const result = await runProgram(() =>
      Effect.gen(function* () {
        const orch = yield* makeOrchestrator({ runChild: runner })
        const spawned = yield* orch.spawn(
          { description: "probe", prompt: "look", agentType: "Explore" },
          parent(),
        )
        yield* Queue.take(orch.completions)
        return yield* getTask(spawned.taskId)
      }),
    )
    // The timer wraps the sleeping child run, so it spans at least that delay.
    expect(result.durationMs).toBeGreaterThanOrEqual(40)
  })

  test("child sessions never include the Agent tool", async () => {
    const captured: Array<ChildRunContext> = []
    const runner: ChildRunner = (ctx) => {
      captured.push(ctx)
      return Effect.succeed("ok")
    }
    await runProgram(() =>
      Effect.gen(function* () {
        const orch = yield* makeOrchestrator({ runChild: runner })
        const spawned = yield* orch.spawn(
          { description: "probe", prompt: "look", agentType: "Explore" },
          parent(),
        )
        yield* Queue.take(orch.completions)
        return spawned
      }),
    )
    expect(captured).toHaveLength(1)
    expect(captured[0]?.registry.has("Agent")).toBe(false)
    expect(captured[0]?.registry.has("Ask")).toBe(false)
  })

  test("GeneralPurpose runs in an isolated worktree with mutating tools", async () => {
    const captured: Array<ChildRunContext> = []
    const runner: ChildRunner = (ctx) => {
      captured.push(ctx)
      return Effect.succeed("ok")
    }
    await runProgram(() =>
      Effect.gen(function* () {
        const orch = yield* makeOrchestrator({ runChild: runner })
        const spawned = yield* orch.spawn(
          { description: "build", prompt: "implement", agentType: "GeneralPurpose" },
          parent(),
        )
        yield* Queue.take(orch.completions)
        return spawned
      }),
    )
    const ctx = captured[0]
    expect(ctx?.session.workingDirectory).toContain(join(".swain", "worktrees"))
    expect(ctx?.session.workingDirectory).not.toBe(repo)
    expect(ctx?.registry.has("Write")).toBe(true)
    expect(ctx?.registry.has("Edit")).toBe(true)
  })

  test("retains and reports the worktree when the child leaves changes", async () => {
    const events: Array<SubagentEvent> = []
    const runner: ChildRunner = (ctx) =>
      Effect.sync(() => {
        writeFileSync(join(ctx.session.workingDirectory, "change.txt"), "dirty\n")
      }).pipe(Effect.as("done")) as ReturnType<ChildRunner>
    const task = await runProgram(() =>
      Effect.gen(function* () {
        const orch = yield* makeOrchestrator({
          runChild: runner,
          onEvent: (event) => Effect.sync(() => events.push(event)),
        })
        const spawned = yield* orch.spawn(
          { description: "build", prompt: "implement", agentType: "GeneralPurpose" },
          parent(),
        )
        yield* Queue.take(orch.completions)
        return yield* getTask(spawned.taskId)
      }),
    )
    expect(task.worktreePath).toBeDefined()
    expect(task.worktreeBranch).toBeDefined()
    expect(existsSync(task.worktreePath!)).toBe(true)
    expect(events.some((e) => e.type === "subagent-complete")).toBe(true)
  })

  test("removes a clean worktree and leaves no retained metadata", async () => {
    const task = await runProgram(() =>
      Effect.gen(function* () {
        const orch = yield* makeOrchestrator({ runChild: () => Effect.succeed("nothing changed") })
        const spawned = yield* orch.spawn(
          { description: "build", prompt: "implement", agentType: "GeneralPurpose" },
          parent(),
        )
        yield* Queue.take(orch.completions)
        return yield* getTask(spawned.taskId)
      }),
    )
    expect(task.status).toBe("completed")
    expect(task.worktreePath).toBeUndefined()
  })

  test("caps active subagents and rejects the overflow spawn", async () => {
    const error = await runProgram(() =>
      Effect.gen(function* () {
        const orch = yield* makeOrchestrator({
          maxConcurrentSubagents: 2,
          runChild: () => Effect.never,
        })
        yield* orch.spawn({ description: "a", prompt: "a", agentType: "Explore" }, parent())
        yield* orch.spawn({ description: "b", prompt: "b", agentType: "Explore" }, parent())
        const overflow = yield* orch
          .spawn({ description: "c", prompt: "c", agentType: "Explore" }, parent())
          .pipe(Effect.flip)
        yield* orch.interruptAll
        return overflow
      }),
    )
    expect((error as { reason: string }).reason).toBe("precondition-failed")
  })

  test("recoverDangling resets a dead task and re-spawns its agent type", async () => {
    const result = await runProgram(() =>
      Effect.gen(function* () {
        // A subagent that died mid-run: in_progress with an owner.
        const dead = yield* claimTask({
          owner: "dead-agent",
          agentType: "Explore",
          subject: "resume me",
          description: "the original brief",
        })
        const orch = yield* makeOrchestrator({ runChild: () => Effect.succeed("recovered") })
        const respawned = yield* orch.recoverDangling(parent())
        yield* Queue.take(orch.completions)
        const task = yield* getTask(dead.id)
        return { respawned, task }
      }),
    )
    expect(result.respawned).toHaveLength(1)
    expect(result.respawned[0]?.agentType).toBe("Explore")
    expect(result.task.status).toBe("completed")
    expect(result.task.result).toBe("recovered")
  })
})
