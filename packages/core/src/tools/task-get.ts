import { Effect, Schema } from "effect"
import { getTask, TaskSchema } from "../tasks"
import { defineTool } from "../tool"
import { toToolError } from "./task-support"

const NAME = "TaskGet"

export const TaskGetInput = Schema.Struct({ taskId: Schema.String })

export const TaskGetResult = Schema.Struct({ task: TaskSchema })

export const TaskGet = defineTool({
  name: NAME,
  description: "Fetch a single task by id, including its status, owner, result, and error.",
  inputSchema: TaskGetInput,
  outputSchema: TaskGetResult,
  readOnly: true,
  call: (input) =>
    getTask(input.taskId).pipe(
      Effect.map((task) => ({ task })),
      Effect.mapError((error) => toToolError(NAME, error)),
    ),
})
