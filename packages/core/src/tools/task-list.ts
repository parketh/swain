import { Effect, Schema } from "effect"
import { listTasks, TaskSchema } from "../tasks"
import { defineTool } from "../tool"

const NAME = "TaskList"

export const TaskListInput = Schema.Struct({})

export const TaskListResult = Schema.Struct({ tasks: Schema.Array(TaskSchema) })

export const TaskList = defineTool({
  name: NAME,
  description: "List all tasks on the session to-do list with their status and ownership.",
  inputSchema: TaskListInput,
  outputSchema: TaskListResult,
  readOnly: true,
  call: () => listTasks().pipe(Effect.map((tasks) => ({ tasks }))),
})
