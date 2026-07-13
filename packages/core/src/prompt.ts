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

const ROUTER_GUIDANCE = `You can switch the model handling this conversation with the SwitchModel tool, choosing one of the routable targets above. Pick the model best suited to the task by classifying the user's request into one of the tiers below, then picking the routable target above that best fits it by judging capability and cost together from the data shown. Don't pay for capability the task will not use.

Task tiers:
- Simple: the cheapest capable target: quick lookups, one-line fixes, typos, renames, formatting, boilerplate, docs.
- Routine: a mid-tier target: single-file edits, straightforward Q&A, applying well-known patterns, standard tests, debugging an issue with an obvious cause.
- Complex [DEFAULT]: a near-top target, one tier below the strongest: multi-file refactors, ambiguous debugging, implementing a spec or non-trivial feature. This is the DEFAULT tier when a task does not clearly fit another.
- Critical: security audits, penetration testing, architecture reviews, and other mission-critical work.

Rules:
- Decide at the START of the conversation; getting this right up front matters more than switching later.
- The target marked [current] is the one you are running on now; do NOT switch to it.
- To switch, emit SwitchModel as your ONLY tool call and then stop generating.

You can also use Agent to delegate tasks to a specific target model. When using Agent, classify its task the same way and pass Agent's \`model\` field the matching routable target id; omit a target to inherit the current one.`

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
