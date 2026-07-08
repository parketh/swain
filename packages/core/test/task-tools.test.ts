import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunContext } from "@effect/platform-bun"
import type { Model, ToolCall } from "@swain/llms"
import { ModelId, ProviderId, ToolCallId } from "@swain/llms"
import { Effect, Layer, Stream } from "effect"
import { createSessionState } from "../src/state"
import { taskStoreLayer } from "../src/tasks"
import {
  callTool,
  TaskCreate,
  TaskGet,
  TaskList,
  TaskUpdate,
  ToolContext,
  toolRegistryLayer,
} from "../src/tools"

const model: Model = {
  id: ModelId.make("test-model"),
  provider: ProviderId.make("test"),
  streamTurn: () => Stream.empty,
}

const tools = [TaskCreate, TaskList, TaskGet, TaskUpdate]

const toolCall = (name: string, input: unknown): ToolCall => ({
  type: "tool-call",
  toolCallId: ToolCallId.make("call-1"),
  name,
  input,
})

// biome-ignore lint/suspicious/noExplicitAny: tool-result payloads are opaque JSON here
const value = (result: { result: { value?: unknown } }): any => result.result.value

describe("task tools", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swain-task-tools-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const contextLayer = Layer.succeed(ToolContext, {
    session: createSessionState({ workingDirectory: "/work", model, currentDate: "2026-07-04" }),
    abortSignal: new AbortController().signal,
    permission: { check: () => Effect.succeed({ type: "allow" as const }) },
  })

  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous callTool requirements
  const run = <A>(eff: Effect.Effect<A, any, any>): Promise<A> =>
    Effect.runPromise(
      eff.pipe(
        Effect.provide(contextLayer),
        Effect.provide(toolRegistryLayer(tools)),
        Effect.provide(taskStoreLayer(dir).pipe(Layer.provideMerge(BunContext.layer))),
        // biome-ignore lint/suspicious/noExplicitAny: all requirements are provided above
      ) as Effect.Effect<A, any, never>,
    )

  test("TaskCreate then TaskList reflects the new task", async () => {
    const result = await run(
      Effect.gen(function* () {
        const created = yield* callTool(
          toolCall("TaskCreate", { subject: "investigate", description: "look into the bug" }),
        )
        const listed = yield* callTool(toolCall("TaskList", {}))
        return { created, listed }
      }),
    )
    expect(value(result.created).task).toMatchObject({ subject: "investigate", status: "pending" })
    expect(value(result.listed).tasks).toHaveLength(1)
  })

  test("TaskGet fetches by id and errors on unknown id", async () => {
    const result = await run(
      Effect.gen(function* () {
        const created = yield* callTool(toolCall("TaskCreate", { subject: "s", description: "d" }))
        const id = value(created).task.id
        const got = yield* callTool(toolCall("TaskGet", { taskId: id }))
        const missing = yield* callTool(toolCall("TaskGet", { taskId: "nope" }))
        return { got, missing }
      }),
    )
    expect(value(result.got).task.subject).toBe("s")
    expect(result.missing.isError).toBe(true)
  })

  test("TaskUpdate changes status and edits dependencies", async () => {
    const result = await run(
      Effect.gen(function* () {
        const created = yield* callTool(toolCall("TaskCreate", { subject: "s", description: "d" }))
        const id = value(created).task.id
        const updated = yield* callTool(
          toolCall("TaskUpdate", { taskId: id, status: "in_progress", addBlockedBy: ["x", "y"] }),
        )
        const removed = yield* callTool(
          toolCall("TaskUpdate", { taskId: id, removeBlockedBy: ["x"] }),
        )
        return { updated, removed }
      }),
    )
    expect(value(result.updated).task.status).toBe("in_progress")
    expect(value(result.updated).task.blockedBy).toEqual(["x", "y"])
    expect(value(result.removed).task.blockedBy).toEqual(["y"])
  })
})
