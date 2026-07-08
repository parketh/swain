import { Effect, Schema } from "effect"
import { createTask, TaskSchema } from "../tasks"
import { defineTool } from "../tool"
import { toToolError } from "./task-support"

const NAME = "TaskCreate"

export const TaskCreateInput = Schema.Struct({
  subject: Schema.String,
  description: Schema.String,
  blockedBy: Schema.optional(Schema.Array(Schema.String)),
})

export const TaskCreateResult = Schema.Struct({ task: TaskSchema })

export const TaskCreate = defineTool({
  name: NAME,
  description:
    "Add a task to the session to-do list. Use to plan and track your own " +
    "multi-step work; a task needs no subagent. `subject` is a short label; " +
    "`description` is the full brief. `blockedBy` lists task ids that must " +
    "complete first.",
  inputSchema: TaskCreateInput,
  outputSchema: TaskCreateResult,
  readOnly: true,
  call: (input) =>
    createTask({
      subject: input.subject,
      description: input.description,
      ...(input.blockedBy !== undefined && { blockedBy: input.blockedBy }),
    }).pipe(
      Effect.map((task) => ({ task })),
      Effect.mapError((error) => toToolError(NAME, error)),
    ),
})
