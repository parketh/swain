import { Effect, Schema } from "effect"
import { getTask, TaskSchema, type UpdateTaskInput as UpdateInput, updateTask } from "../tasks"
import { defineTool } from "../tool"
import { toToolError } from "./task-support"

const NAME = "TaskUpdate"

export const TaskUpdateInput = Schema.Struct({
  taskId: Schema.String,
  subject: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literal("pending", "in_progress", "completed", "failed")),
  owner: Schema.optional(Schema.String),
  addBlockedBy: Schema.optional(Schema.Array(Schema.String)),
  removeBlockedBy: Schema.optional(Schema.Array(Schema.String)),
  result: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})

export const TaskUpdateResult = Schema.Struct({ task: TaskSchema })

export const TaskUpdate = defineTool({
  name: NAME,
  description:
    "Update a task on the session to-do list: change its subject/description, " +
    "move its status (pending, in_progress, completed, failed), record a " +
    "result or error, or edit its blocked-by dependencies.",
  inputSchema: TaskUpdateInput,
  outputSchema: TaskUpdateResult,
  readOnly: true,
  call: (input) =>
    Effect.gen(function* () {
      let blockedBy: ReadonlyArray<string> | undefined
      if (input.addBlockedBy !== undefined || input.removeBlockedBy !== undefined) {
        const current = yield* getTask(input.taskId)
        const deps = new Set(current.blockedBy)
        for (const add of input.addBlockedBy ?? []) deps.add(add)
        for (const remove of input.removeBlockedBy ?? []) deps.delete(remove)
        blockedBy = Array.from(deps)
      }
      const patch: UpdateInput = {
        ...(input.subject !== undefined && { subject: input.subject }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.owner !== undefined && { owner: input.owner }),
        ...(input.result !== undefined && { result: input.result }),
        ...(input.error !== undefined && { error: input.error }),
        ...(blockedBy !== undefined && { blockedBy }),
      }
      const task = yield* updateTask(input.taskId, patch)
      return { task }
    }).pipe(Effect.mapError((error) => toToolError(NAME, error))),
})
