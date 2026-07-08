import { Effect, Schema } from "effect"
import { OrchestratorService, type ParentRunContext } from "../orchestrator"
import { defineTool, ToolContext, ToolRegistry } from "../tool"
import { toToolError } from "./task-support"

const NAME = "Agent"

export const AgentInput = Schema.Struct({
  description: Schema.String,
  prompt: Schema.String,
  subagentType: Schema.optional(Schema.Literal("Explore", "Plan", "GeneralPurpose")),
  taskId: Schema.optional(Schema.String),
  isolation: Schema.optional(Schema.Literal("worktree")),
})

export const AgentResult = Schema.Struct({
  agentId: Schema.String,
  taskId: Schema.String,
  agentType: Schema.Literal("Explore", "Plan", "GeneralPurpose"),
  status: Schema.Literal("spawned"),
})

export const AGENT_DESCRIPTION = `Launch a new subagent to handle complex, multi-step tasks autonomously. Use this tool to carry out independent work that can run in its own context.

Available subagent types:
- Explore: fast repository search and code reading. (Tools: Read, Glob, Grep)
- Plan: read-only implementation planning and architecture analysis. (Tools: Read, Glob, Grep)
- GeneralPurpose: general-purpose investigation or implementation work, optionally in an isolated worktree. (Tools: all built-in tools except Agent, Ask, and Task* tools)

Use Agent when:
- The task is independent enough to run in parallel.
- The work would require broad search or reading many files, so would benefit from running in its own context to avoid cluttering the main context window.
- Multiple agents need to carry out mutating work in parallel; use isolated worktrees so their changes do not race in the same working copy.
- The intermediate search output is not worth keeping in the parent context.

Do not use Agent when:
- You already know the exact file to read.
- The question can be answered by one or two direct tool calls.
- You need immediate user input inside the delegated work.

Prompting rules:
- Set description to a short 3-5 word summary of what the agent will do.
- Provide a complete brief in the prompt. Fresh subagents do not know what the parent has tried unless you include it.
- Include relevant file paths, constraints, and expected output shape.
- Provide the child everything it needs in the prompt; it does not inherit the parent conversation.
- Use isolation: "worktree" for write-capable GeneralPurpose work; this is also the default for GeneralPurpose.
- If launching multiple independent agents, issue the Agent tool calls in the same model step where possible.
- Do not predict or fabricate subagent results. Wait for the task notification.
- When a notification arrives, summarize the result to the user or act on it in the next parent turn.`

export const Agent = defineTool({
  name: NAME,
  description: AGENT_DESCRIPTION,
  inputSchema: AgentInput,
  outputSchema: AgentResult,
  readOnly: true,
  call: (input) =>
    Effect.gen(function* () {
      const { session, permission } = yield* ToolContext
      const tools = yield* ToolRegistry
      const orchestrator = yield* OrchestratorService
      const agentType = input.subagentType ?? "GeneralPurpose"
      const parent: ParentRunContext = { session, tools, permission }
      const result = yield* orchestrator.spawn(
        {
          description: input.description,
          prompt: input.prompt,
          agentType,
          ...(input.taskId !== undefined && { taskId: input.taskId }),
          ...(input.isolation !== undefined && { isolation: input.isolation }),
        },
        parent,
      )
      return {
        agentId: result.agentId,
        taskId: result.taskId,
        agentType: result.agentType,
        status: "spawned" as const,
      }
    }).pipe(Effect.mapError((error) => toToolError(NAME, error))),
})
