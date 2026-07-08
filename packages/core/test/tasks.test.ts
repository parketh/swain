import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileSystem } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import {
  claimTask,
  completeTask,
  createTask,
  getTask,
  listTasks,
  markParentNotified,
  pendingParentNotifications,
  resetDanglingTasks,
  TaskError,
  TaskStore,
  taskStoreLayer,
  updateTask,
} from "../src/tasks"

const provide = (dir: string) => taskStoreLayer(dir).pipe(Layer.provideMerge(BunContext.layer))

const runIn = <A, E>(
  dir: string,
  eff: Effect.Effect<A, E, TaskStore | FileSystem.FileSystem>,
): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(provide(dir))))

describe("TaskStore", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swain-tasks-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("empty store loads as []", async () => {
    expect(await runIn(dir, listTasks())).toEqual([])
  })

  test("createTask persists to tasks.json", async () => {
    const task = await runIn(dir, createTask({ subject: "s", description: "d" }))
    expect(task.status).toBe("pending")
    const raw = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"))
    expect(raw).toHaveLength(1)
    expect(raw[0]).toMatchObject({ id: task.id, subject: "s", description: "d", status: "pending" })
  })

  test("updateTask on an unknown task is a typed not-found error", async () => {
    const error = await runIn(dir, updateTask("nope", { subject: "x" }).pipe(Effect.flip))
    expect(error).toBeInstanceOf(TaskError)
    expect((error as TaskError).reason).toBe("not-found")
  })

  test("blocked tasks are reported as blocked until dependencies complete", async () => {
    const result = await runIn(
      dir,
      Effect.gen(function* () {
        const a = yield* createTask({ subject: "a", description: "" })
        const b = yield* createTask({ subject: "b", description: "", blockedBy: [a.id] })
        const blocked = yield* claimTask({
          taskId: b.id,
          owner: "agent-1",
          agentType: "Explore",
        }).pipe(Effect.flip)
        yield* completeTask(a.id, "done")
        const claimed = yield* claimTask({ taskId: b.id, owner: "agent-1", agentType: "Explore" })
        return { blocked, claimed }
      }),
    )
    expect(result.blocked).toBeInstanceOf(TaskError)
    expect((result.blocked as TaskError).reason).toBe("blocked")
    expect(result.claimed.status).toBe("in_progress")
  })

  test("completed delegated task with no parentNotifiedAt is pending notification", async () => {
    const result = await runIn(
      dir,
      Effect.gen(function* () {
        const claimed = yield* claimTask({
          owner: "agent-1",
          agentType: "Explore",
          subject: "x",
          description: "y",
        })
        yield* completeTask(claimed.id, "the answer")
        const before = yield* pendingParentNotifications()
        yield* markParentNotified([claimed.id])
        const after = yield* pendingParentNotifications()
        return { before, after }
      }),
    )
    expect(result.before).toHaveLength(1)
    expect(result.before[0]?.result).toBe("the answer")
    expect(result.after).toHaveLength(0)
  })

  test("resetDanglingTasks reopens dangling in_progress tasks and leaves completed ones", async () => {
    const result = await runIn(
      dir,
      Effect.gen(function* () {
        const dangling = yield* claimTask({
          owner: "agent-1",
          agentType: "Explore",
          subject: "x",
          description: "y",
        })
        const done = yield* claimTask({
          owner: "agent-2",
          agentType: "Plan",
          subject: "z",
          description: "w",
        })
        yield* completeTask(done.id, "finished")
        const reset = yield* resetDanglingTasks()
        const reopened = yield* getTask(dangling.id)
        const untouched = yield* getTask(done.id)
        return { reset, reopened, untouched }
      }),
    )
    expect(result.reset).toHaveLength(1)
    expect(result.reopened.status).toBe("pending")
    expect(result.reopened.owner).toBeUndefined()
    expect(result.reopened.agentType).toBe("Explore")
    expect(result.untouched.status).toBe("completed")
  })

  test("state persists across store reloads", async () => {
    const created = await runIn(dir, createTask({ subject: "keep", description: "me" }))
    const reloaded = await runIn(dir, getTask(created.id))
    expect(reloaded.subject).toBe("keep")
  })

  test("claim records worktree info; reset clears it but returns it for cleanup", async () => {
    const result = await runIn(
      dir,
      Effect.gen(function* () {
        const claimed = yield* claimTask({
          owner: "agent-1",
          agentType: "GeneralPurpose",
          subject: "s",
          description: "d",
          worktreePath: "/tmp/wt/agent-1",
          worktreeBranch: "swain-agent-1",
        })
        const reset = yield* resetDanglingTasks()
        const stored = yield* getTask(claimed.id)
        return { claimed, reset, stored }
      }),
    )
    expect(result.claimed.worktreePath).toBe("/tmp/wt/agent-1")
    // The returned dangling task still carries the worktree for the caller to remove.
    expect(result.reset).toHaveLength(1)
    expect(result.reset[0]?.worktreePath).toBe("/tmp/wt/agent-1")
    expect(result.reset[0]?.worktreeBranch).toBe("swain-agent-1")
    // The stored task is cleaned for re-delegation.
    expect(result.stored.status).toBe("pending")
    expect(result.stored.owner).toBeUndefined()
    expect(result.stored.worktreePath).toBeUndefined()
    expect(result.stored.worktreeBranch).toBeUndefined()
  })

  test("concurrent completions all reach disk (no lost update)", async () => {
    await runIn(
      dir,
      Effect.gen(function* () {
        const tasks = yield* Effect.all(
          Array.from({ length: 8 }, (_, i) =>
            claimTask({
              owner: `agent-${i}`,
              agentType: "GeneralPurpose",
              subject: `s${i}`,
              description: "d",
            }),
          ),
        )
        yield* Effect.all(
          tasks.map((t) => completeTask(t.id, `done-${t.id}`)),
          { concurrency: "unbounded" },
        )
      }),
    )
    const onDisk = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8")) as Array<{
      status: string
    }>
    expect(onDisk).toHaveLength(8)
    expect(onDisk.every((t) => t.status === "completed")).toBe(true)
  })
})
