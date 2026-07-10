import type { Model } from "@swain/llms"
import { Effect, Option, Schema } from "effect"
import { ToolError } from "../errors"
import { ModelResolverService } from "../model-resolver"
import { OrchestratorService, type ParentRunContext } from "../orchestrator"
import { modelRefKey, type RequestOptions, type SessionModelRef, type SessionState } from "../state"
import { defineTool, ToolContext, ToolRegistry } from "../tool"
import { toToolError } from "./task-support"

const NAME = "Agent"

export const AgentInput = Schema.Struct({
  description: Schema.String,
  prompt: Schema.String,
  subagentType: Schema.optional(Schema.Literal("Explore", "Plan", "GeneralPurpose")),
  /** Optional routable target id; omitted inherits the parent's current model. */
  model: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
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
- Multiple agents need to carry out mutating work in parallel; use GeneralPurpose subagents, which isolate their changes in a per-agent worktree so they do not race in the same working copy.
- The intermediate search output is not worth keeping in the parent context.

Do not use Agent when:
- You already know the exact file to read.
- The question can be answered by one or two direct tool calls.
- You need immediate user input inside the delegated work.

Choosing a type:
- Default to GeneralPurpose when no specialized type fits.
- Use Explore for search and code reading; use Plan for implementation strategy.

Model selection:
- By default a subagent inherits your current model and request options.
- When routing is active you may pass an optional \`model\` field — a routable target id (\`provider:modelId[:variant]\`) from the routable-targets list — to run the subagent on a specific target (e.g. a cheaper model for broad search, a stronger one for tricky implementation). Omit it to inherit.
- If routing is inactive, only the current model is accepted; any other target is rejected.

Prompting rules:
- Set description to a short 3-5 word summary of what the agent will do.
- Provide a complete brief in the prompt. Fresh subagents do not know what the parent has tried unless you include it.
- Include relevant file paths, constraints, and expected output shape.
- Provide the child everything it needs in the prompt; it does not inherit the parent conversation.
- GeneralPurpose subagents are write-capable and always run in an isolated worktree; Explore and Plan are read-only.
- If launching multiple independent agents, issue the Agent tool calls in the same model step where possible.
- Do not predict or fabricate subagent results. Wait for the task notification.
- When a notification arrives, summarize the result to the user or act on it in the next parent turn.`

interface SpawnModelOverride {
  readonly model: Model
  readonly requestOptions: RequestOptions
  readonly modelRef: SessionModelRef
}

/**
 * Resolves an optional `Agent.model` target into a spawn override. Returns an
 * empty object to inherit the parent's model when `model` is omitted or names
 * the current target. A supplied target is resolved through `ModelResolver`;
 * unknown/disabled/unavailable targets fail with a recoverable `Agent` error.
 */
const resolveOverride = (
  model: string | undefined,
  session: SessionState,
): Effect.Effect<Partial<SpawnModelOverride>, ToolError> =>
  Effect.gen(function* () {
    if (model === undefined || model === modelRefKey(session.systemContext.modelRef)) {
      return {}
    }
    const resolver = yield* Effect.serviceOption(ModelResolverService)
    if (Option.isNone(resolver)) {
      return yield* new ToolError({
        tool: NAME,
        reason: "precondition-failed",
        message: "Model routing is unavailable; omit `model` to inherit the current model.",
      })
    }
    const resolved = yield* resolver.value
      .resolve(model)
      .pipe(Effect.mapError((error) => toToolError(NAME, error)))
    return {
      model: resolved.model,
      requestOptions: resolved.requestOptions,
      modelRef: resolved.modelRef,
    }
  })

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

      // Resolve an explicit target through the router. Omitting `model`, or
      // naming the current model, inherits the parent's model and options —
      // which is also the only accepted target when routing is inactive, since
      // the resolver rejects any non-current target as not-enabled.
      const override = yield* resolveOverride(input.model, session)

      const result = yield* orchestrator.spawn(
        {
          description: input.description,
          prompt: input.prompt,
          agentType,
          ...override,
          ...(input.taskId !== undefined && { taskId: input.taskId }),
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
