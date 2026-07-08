import type { PermissionMode } from "./permission"

export interface SystemPromptInput {
  readonly workingDirectory: string
  readonly currentDate: string
  readonly model: string
  readonly permissionMode: PermissionMode
  readonly tools: ReadonlyArray<{ readonly name: string; readonly description: string }>
}

/**
 * Pure assembly of the system prompt from session context and the registered
 * built-in tools. Full tool schemas travel through the `@swain/llms` `tools`
 * request field via `toLLMTool`; only names/descriptions appear here.
 */
const TASK_GUIDANCE = `You have a task list (TaskCreate, TaskList, TaskGet, TaskUpdate). Use it as a to-do list to plan and track your own multi-step work; a task with no owner is simply your own work, and delegating one to a subagent with Agent is optional.

Keep the list moving in real time — this is how the user sees progress:
- Set a task to in_progress with TaskUpdate BEFORE you start working on it.
- Keep exactly ONE task in_progress at a time.
- Mark a task completed with TaskUpdate the moment you finish it — do not batch completions, and do not wait until the end of your turn.
- Only mark a task completed when it is fully done. If you hit a blocker, leave it in_progress and add a new task describing what is needed.
- After finishing one task, immediately move to the next pending task in the same turn until the list is done.`

const AGENT_REMINDER = `Use Agent for independent exploration, planning, or isolated implementation work. Subagents are useful for parallel work and for keeping broad search or implementation noise out of the main context. Do not delegate work that can be handled with one or two direct tool calls. After launching a subagent, wait for its completion notification before using its result.`

export const assembleSystemPrompt = (input: SystemPromptInput): string => {
  const toolList = input.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
  }))
  const hasTaskTools = input.tools.some((tool) => tool.name === "TaskCreate")
  const hasAgentTool = input.tools.some((tool) => tool.name === "Agent")

  const sections = [
    `You are Swain, an agentic coding assistant. You and the user share the same working directory.

Use the context and available tools to assist the user. Ask clarifying questions if needed. Respect the active permission mode.

<context>
Working directory: ${input.workingDirectory}
Current date: ${input.currentDate}
Model: ${input.model}
Permission mode: ${input.permissionMode}
</context>

Available tools:
${JSON.stringify(toolList, null, 2)}`,
  ]
  if (hasTaskTools) sections.push(TASK_GUIDANCE)
  if (hasAgentTool) sections.push(AGENT_REMINDER)
  return `${sections.join("\n\n")}\n`
}
