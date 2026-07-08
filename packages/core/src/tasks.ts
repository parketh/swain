import * as NodePath from "node:path"
import { FileSystem } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { Context, Data, Effect, Layer, type ParseResult, Ref, Schema } from "effect"

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed"
export type AgentType = "Explore" | "Plan" | "GeneralPurpose"

/**
 * A single node in the session task graph. Tasks double as (1) the main loop's
 * own persisted to-do list and (2) the coordination record for a delegated
 * subagent run. Subagent fields (`owner`, `agentType`, `worktreePath`,
 * `worktreeBranch`, `parentNotifiedAt`) are unset for main-loop-only tasks.
 */
export interface Task {
  readonly id: string
  readonly subject: string
  readonly description: string
  readonly status: TaskStatus
  readonly owner?: string
  readonly blockedBy: ReadonlyArray<string>
  readonly agentType?: AgentType
  readonly result?: string
  readonly error?: string
  readonly worktreePath?: string
  readonly worktreeBranch?: string
  readonly parentNotifiedAt?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export type TaskErrorReason = "not-found" | "blocked" | "already-owned" | "bad-transition"

export class TaskError extends Data.TaggedError("TaskError")<{
  readonly reason: TaskErrorReason
  readonly message: string
  readonly taskId?: string
}> {}

export const TaskSchema = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  description: Schema.String,
  status: Schema.Literal("pending", "in_progress", "completed", "failed"),
  owner: Schema.optional(Schema.String),
  blockedBy: Schema.Array(Schema.String),
  agentType: Schema.optional(Schema.Literal("Explore", "Plan", "GeneralPurpose")),
  result: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  worktreePath: Schema.optional(Schema.String),
  worktreeBranch: Schema.optional(Schema.String),
  parentNotifiedAt: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
const TasksFile = Schema.Array(TaskSchema)

export interface TaskStoreService {
  readonly ref: Ref.Ref<ReadonlyMap<string, Task>>
  readonly dir: string
  /** Serializes `persist` so concurrent subagent completions never interleave a
   * stale snapshot's write over a newer one. */
  readonly persistLock: Effect.Semaphore
}

export class TaskStore extends Context.Tag("@swain/core/TaskStore")<
  TaskStore,
  TaskStoreService
>() {}

const tasksPath = (dir: string): string => NodePath.join(dir, "tasks.json")

const now = (): string => new Date().toISOString()

/** Strips undefined-valued keys so a partial patch never clobbers a set field. */
const definedOnly = <T extends object>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>

/**
 * Loads the session task graph from `<dir>/tasks.json` into an in-memory `Ref`.
 * A missing file starts empty; mutations write through to disk.
 */
export const loadTaskStore = (
  dir: string,
): Effect.Effect<TaskStoreService, PlatformError | ParseResult.ParseError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = tasksPath(dir)
    const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
    const tasks = exists
      ? yield* fs
          .readFileString(path)
          .pipe(Effect.flatMap(Schema.decode(Schema.parseJson(TasksFile))))
      : []
    const ref = yield* Ref.make<ReadonlyMap<string, Task>>(new Map(tasks.map((t) => [t.id, t])))
    const persistLock = yield* Effect.makeSemaphore(1)
    return { ref, dir, persistLock }
  })

export const taskStoreLayer = (
  dir: string,
): Layer.Layer<TaskStore, PlatformError | ParseResult.ParseError, FileSystem.FileSystem> =>
  Layer.effect(TaskStore, loadTaskStore(dir))

/**
 * Atomic-ish write: serialize to a temp sibling, then rename over `tasks.json`.
 * Held under `persistLock` so the snapshot and its write form one critical
 * section — the last serialized writer always reflects every prior `Ref.update`,
 * so concurrent completions can never drop a task with a stale snapshot.
 */
const persist = (
  store: TaskStoreService,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  store.persistLock.withPermits(1)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tasks = yield* Ref.get(store.ref)
      yield* fs.makeDirectory(store.dir, { recursive: true })
      const body = JSON.stringify(Array.from(tasks.values()), null, 2)
      const tmp = `${tasksPath(store.dir)}.${crypto.randomUUID()}.tmp`
      yield* fs.writeFileString(tmp, body)
      yield* fs.rename(tmp, tasksPath(store.dir))
    }),
  )

/** Deps that are not yet completed; a task is claimable only when this is empty. */
export const blockingDeps = (task: Task, tasks: ReadonlyMap<string, Task>): ReadonlyArray<string> =>
  task.blockedBy.filter((dep) => tasks.get(dep)?.status !== "completed")

export interface CreateTaskInput {
  readonly subject: string
  readonly description: string
  readonly blockedBy?: ReadonlyArray<string>
  readonly agentType?: AgentType
  readonly owner?: string
  readonly status?: TaskStatus
}

export const createTask = (
  input: CreateTaskInput,
): Effect.Effect<Task, PlatformError, TaskStore | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const store = yield* TaskStore
    const ts = now()
    const task: Task = {
      id: crypto.randomUUID(),
      subject: input.subject,
      description: input.description,
      status: input.status ?? "pending",
      blockedBy: input.blockedBy ?? [],
      ...(input.owner !== undefined && { owner: input.owner }),
      ...(input.agentType !== undefined && { agentType: input.agentType }),
      createdAt: ts,
      updatedAt: ts,
    }
    yield* Ref.update(store.ref, (m) => new Map(m).set(task.id, task))
    yield* persist(store)
    return task
  })

export const listTasks = (): Effect.Effect<ReadonlyArray<Task>, never, TaskStore> =>
  Effect.flatMap(TaskStore, (store) =>
    Ref.get(store.ref).pipe(Effect.map((tasks) => Array.from(tasks.values()))),
  )

export const getTask = (taskId: string): Effect.Effect<Task, TaskError, TaskStore> =>
  Effect.gen(function* () {
    const store = yield* TaskStore
    const tasks = yield* Ref.get(store.ref)
    const task = tasks.get(taskId)
    if (task === undefined) {
      return yield* new TaskError({
        reason: "not-found",
        message: `Task not found: ${taskId}`,
        taskId,
      })
    }
    return task
  })

export interface UpdateTaskInput {
  readonly subject?: string
  readonly description?: string
  readonly status?: TaskStatus
  readonly owner?: string
  readonly blockedBy?: ReadonlyArray<string>
  readonly agentType?: AgentType
  readonly result?: string
  readonly error?: string
}

export const updateTask = (
  taskId: string,
  patch: UpdateTaskInput,
): Effect.Effect<Task, TaskError | PlatformError, TaskStore | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const store = yield* TaskStore
    const tasks = yield* Ref.get(store.ref)
    const existing = tasks.get(taskId)
    if (existing === undefined) {
      return yield* new TaskError({
        reason: "not-found",
        message: `Task not found: ${taskId}`,
        taskId,
      })
    }
    const updated: Task = { ...existing, ...definedOnly(patch), updatedAt: now() }
    yield* Ref.update(store.ref, (m) => new Map(m).set(taskId, updated))
    yield* persist(store)
    return updated
  })

export interface ClaimTaskInput {
  readonly taskId?: string
  readonly owner: string
  readonly agentType: AgentType
  readonly subject?: string
  readonly description?: string
}

/**
 * Assigns a task to a subagent. With no `taskId`, creates and claims a fresh
 * task atomically. An existing task must be unowned and unblocked; the
 * `already-owned` failure structurally prevents double-delegation.
 */
export const claimTask = (
  input: ClaimTaskInput,
): Effect.Effect<Task, TaskError | PlatformError, TaskStore | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const store = yield* TaskStore
    if (input.taskId === undefined) {
      const ts = now()
      const task: Task = {
        id: crypto.randomUUID(),
        subject: input.subject ?? "(delegated task)",
        description: input.description ?? "",
        status: "in_progress",
        owner: input.owner,
        agentType: input.agentType,
        blockedBy: [],
        createdAt: ts,
        updatedAt: ts,
      }
      yield* Ref.update(store.ref, (m) => new Map(m).set(task.id, task))
      yield* persist(store)
      return task
    }
    const tasks = yield* Ref.get(store.ref)
    const existing = tasks.get(input.taskId)
    if (existing === undefined) {
      return yield* new TaskError({
        reason: "not-found",
        message: `Task not found: ${input.taskId}`,
        taskId: input.taskId,
      })
    }
    if (existing.owner !== undefined) {
      return yield* new TaskError({
        reason: "already-owned",
        message: `Task ${input.taskId} is already owned by ${existing.owner}.`,
        taskId: input.taskId,
      })
    }
    const blocking = blockingDeps(existing, tasks)
    if (blocking.length > 0) {
      return yield* new TaskError({
        reason: "blocked",
        message: `Task ${input.taskId} is blocked by: ${blocking.join(", ")}.`,
        taskId: input.taskId,
      })
    }
    const claimed: Task = {
      ...existing,
      status: "in_progress",
      owner: input.owner,
      agentType: input.agentType,
      updatedAt: now(),
    }
    yield* Ref.update(store.ref, (m) => new Map(m).set(claimed.id, claimed))
    yield* persist(store)
    return claimed
  })

export interface FinishTaskInput {
  readonly worktreePath?: string
  readonly worktreeBranch?: string
}

export const completeTask = (
  taskId: string,
  result: string,
  input: FinishTaskInput = {},
): Effect.Effect<Task, TaskError | PlatformError, TaskStore | FileSystem.FileSystem> =>
  finish(taskId, { status: "completed", result, ...definedOnly(input) })

export const failTask = (
  taskId: string,
  error: string,
  input: FinishTaskInput = {},
): Effect.Effect<Task, TaskError | PlatformError, TaskStore | FileSystem.FileSystem> =>
  finish(taskId, { status: "failed", error, ...definedOnly(input) })

const finish = (
  taskId: string,
  patch: Partial<Task> & { readonly status: TaskStatus },
): Effect.Effect<Task, TaskError | PlatformError, TaskStore | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const store = yield* TaskStore
    const tasks = yield* Ref.get(store.ref)
    const existing = tasks.get(taskId)
    if (existing === undefined) {
      return yield* new TaskError({
        reason: "not-found",
        message: `Task not found: ${taskId}`,
        taskId,
      })
    }
    const updated: Task = { ...existing, ...patch, updatedAt: now() }
    yield* Ref.update(store.ref, (m) => new Map(m).set(taskId, updated))
    yield* persist(store)
    return updated
  })

/**
 * Finished (completed/failed) delegated tasks whose result has not yet been
 * shown to the parent. Guarded by `parentNotifiedAt` so a crash between the
 * durable write and the wake-up signal never loses a result.
 */
export const pendingParentNotifications = (): Effect.Effect<
  ReadonlyArray<Task>,
  never,
  TaskStore
> =>
  Effect.flatMap(TaskStore, (store) =>
    Ref.get(store.ref).pipe(
      Effect.map((tasks) =>
        Array.from(tasks.values()).filter(
          (t) =>
            t.owner !== undefined &&
            (t.status === "completed" || t.status === "failed") &&
            (t.result !== undefined || t.error !== undefined) &&
            t.parentNotifiedAt === undefined,
        ),
      ),
    ),
  )

export const markParentNotified = (
  taskIds: ReadonlyArray<string>,
): Effect.Effect<void, PlatformError, TaskStore | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const store = yield* TaskStore
    const ts = now()
    yield* Ref.update(store.ref, (m) => {
      const next = new Map(m)
      for (const id of taskIds) {
        const task = next.get(id)
        if (task !== undefined) next.set(id, { ...task, parentNotifiedAt: ts })
      }
      return next
    })
    yield* persist(store)
  })

/**
 * Resets tasks left `in_progress` with an `owner` (subagents that died with the
 * process) to `pending` with `owner` cleared, keeping `agentType`/`description`
 * so a replacement can be re-delegated. Completed tasks are left untouched.
 * Returns the reset tasks.
 */
export const resetDanglingTasks = (): Effect.Effect<
  ReadonlyArray<Task>,
  PlatformError,
  TaskStore | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const store = yield* TaskStore
    const tasks = yield* Ref.get(store.ref)
    const dangling = Array.from(tasks.values()).filter(
      (t) => t.status === "in_progress" && t.owner !== undefined,
    )
    if (dangling.length === 0) return []
    const ts = now()
    const reset = dangling.map(({ owner: _owner, ...rest }) => ({
      ...rest,
      status: "pending" as const,
      updatedAt: ts,
    }))
    yield* Ref.update(store.ref, (m) => {
      const next = new Map(m)
      for (const t of reset) next.set(t.id, t)
      return next
    })
    yield* persist(store)
    return reset
  })
