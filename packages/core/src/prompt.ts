import type { PermissionMode } from "./permission"

/** One enabled routable target, rendered as a row in the router prompt block. */
export interface RouterPromptTarget {
  readonly id: string
  readonly label: string
  /** Rough 0-100 capability tier; higher is better. */
  readonly capability?: number
  /** Weighted average cost per task in USD; lower is cheaper. */
  readonly avgCostPerTask?: number
}

/** Router context injected into the prompt only when routing is active. */
export interface RouterPromptContext {
  readonly targets: ReadonlyArray<RouterPromptTarget>
  /** Current target id, marked `[current]`; recomputed after a mid-turn switch. */
  readonly currentId: string
}

export interface SystemPromptInput {
  readonly workingDirectory: string
  readonly currentDate: string
  readonly model: string
  readonly permissionMode: PermissionMode
  readonly tools: ReadonlyArray<{ readonly name: string; readonly description: string }>
  readonly router?: RouterPromptContext
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

const AGENT_REMINDER = `Use Agent for independent exploration, planning, or isolated implementation work. Subagents are useful for parallel work and for keeping broad search or implementation noise out of the main context. Do not delegate work that can be handled with one or two direct tool calls. After launching a subagent, wait for its completion notification before using its result.

Agent creates and tracks a task for each subagent automatically, and the UI shows running subagents in a live monitor. Do NOT create separate tracking tasks for subagents you delegate — that duplicates them. Only use TaskCreate for your own (non-delegated) work.`

const ROUTER_GUIDANCE = `You can switch the model handling this conversation with the SwitchModel tool, choosing one of the routable targets above.

- Pick the right target at the START of the conversation, before substantive work; getting this right up front matters more than switching later.
- Later switches should be uncommon and are usually UPWARD escalation — move to a more capable target when the task turns more complex, riskier, or more correctness-sensitive. Avoid switching down late just to save cost.
- Compare targets primarily on capability and relative cost; higher capability and lower cost are better. Treat unknown/unmeasured fields as unknown — never assume a value.
- The target marked [current] is the one you are running on now; switching to it is unnecessary and is a no-op.
- At most ONE switch takes effect per user turn.
- To switch, emit SwitchModel as your ONLY tool call and then stop generating. Any sibling tool calls in the same message are dropped and must be reissued on the next turn after the switch.
- To delegate a subagent to a specific target, pass Agent's optional \`model\` field a routable target id. Omit it to inherit the current model.`

const renderTarget = (target: RouterPromptTarget, current: boolean): string => {
  const capability = target.capability !== undefined ? `${target.capability}` : "unknown"
  const cost = target.avgCostPerTask !== undefined ? `~$${target.avgCostPerTask}/task` : "unknown"
  return `- \`${target.id}\`${current ? " [current]" : ""} — ${target.label}
    capability ${capability}, avg cost ${cost}`
}

const renderRouterBlock = (router: RouterPromptContext): string => {
  const rows = router.targets
    .map((target) => renderTarget(target, target.id === router.currentId))
    .join("\n")
  return `Routable model targets:
${rows}

${ROUTER_GUIDANCE}`
}

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
  if (input.router !== undefined) sections.push(renderRouterBlock(input.router))
  return `${sections.join("\n\n")}\n`
}
