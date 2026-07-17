import type { CommandExecutor, FileSystem } from "@effect/platform"
import type { Model } from "@swain/llms"
import { LLMClient } from "@swain/llms"
import { Context, Effect, Fiber, Queue, Ref } from "effect"
import type { AgentEvent } from "./agent"
import { runTurn } from "./agent"
import { ToolError } from "./errors"
import type { Permissions } from "./permission"
import {
  createSessionState,
  type RequestOptions,
  type SessionModelRef,
  type SessionState,
  userMessage,
} from "./state"
import { getSubagentDefinition, type SubagentDefinition } from "./subagents/definitions"
import { makeChildToolRegistry } from "./subagents/tools"
import {
  type AgentWorktree,
  cleanupAgentWorktree,
  createAgentWorktree,
  removeTaskWorktrees,
} from "./subagents/worktree"
import {
  type AgentType,
  claimTask,
  completeTask,
  failTask,
  resetDanglingTasks,
  TaskStore,
} from "./tasks"
import { type AnyTool, ToolContext, type ToolContextValue, toolRegistryLayer } from "./tool"
import { toToolError } from "./tools/task-support"

type LLMClientService = Context.Tag.Identifier<typeof LLMClient.Service>

const DEFAULT_MAX_CONCURRENT = 4

/**
 * UI-only progress signals about detached child runs. These never touch the
 * parent `session.messages`; only the durable task result does.
 */
export type SubagentEvent =
  | {
      readonly type: "subagent-start"
      readonly agentId: string
      readonly taskId: string
      readonly agentType: AgentType
      readonly description: string
    }
  | {
      readonly type: "subagent-progress"
      readonly agentId: string
      readonly taskId: string
      readonly lastTool?: string
      readonly lastToolInput?: unknown
      readonly toolUseCount: number
    }
  | {
      readonly type: "subagent-complete"
      readonly agentId: string
      readonly taskId: string
      readonly result: string
      readonly worktreePath?: string
    }
  | {
      readonly type: "subagent-failed"
      readonly agentId: string
      readonly taskId: string
      readonly error: string
    }

export interface SpawnInput {
  readonly description: string
  readonly prompt: string
  readonly agentType: AgentType
  /** Optional model override for the child; omitted inherits the parent's current model. */
  readonly model?: Model
  readonly requestOptions?: RequestOptions
  readonly modelRef?: SessionModelRef
  readonly taskId?: string
}

export interface SpawnResult {
  readonly agentId: string
  readonly taskId: string
  readonly agentType: AgentType
}

/**
 * The live parent context a spawn reads at call time: the parent session, its
 * tool registry (filtered for the child), and the current permission gate so an
 * `ask`-mode child's approval requests bubble through the parent path.
 */
export interface ParentRunContext {
  readonly session: SessionState
  readonly tools: ReadonlyMap<string, AnyTool>
  readonly permission: Permissions
}

export interface ChildRunContext {
  readonly session: SessionState
  readonly registry: ReadonlyMap<string, AnyTool>
  readonly context: ToolContextValue
  readonly agentType: AgentType
  readonly emit: (event: AgentEvent) => Effect.Effect<void>
}

/** Runs a child session to its final assistant text. Injectable for tests. */
export type ChildRunner = (ctx: ChildRunContext) => Effect.Effect<string, unknown, LLMClientService>

export interface OrchestratorConfig {
  readonly maxConcurrentSubagents?: number
  readonly onEvent?: (event: SubagentEvent) => Effect.Effect<void>
  readonly runChild?: ChildRunner
}

/** Requirements a `spawn` inherits from the ambient parent runtime scope. */
type SpawnR = LLMClientService | TaskStore | FileSystem.FileSystem | CommandExecutor.CommandExecutor

export interface Orchestrator {
  readonly spawn: (
    input: SpawnInput,
    parent: ParentRunContext,
  ) => Effect.Effect<SpawnResult, ToolError, SpawnR>
  readonly activeCount: Effect.Effect<number>
  readonly completions: Queue.Dequeue<void>
  readonly interruptAll: Effect.Effect<void>
  readonly recoverDangling: (
    parent: ParentRunContext,
  ) => Effect.Effect<ReadonlyArray<SpawnResult>, ToolError, SpawnR>
}

export class OrchestratorService extends Context.Tag("@swain/core/Orchestrator")<
  OrchestratorService,
  Orchestrator
>() {}

const finalAssistantText = (session: SessionState): string => {
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const message = session.messages[i]
    if (message?.role === "assistant") {
      return message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("")
        .trim()
    }
  }
  return ""
}

const childBrief = (definition: SubagentDefinition, input: SpawnInput): string =>
  `${definition.systemPrompt}\n\n## Assignment: ${input.description}\n\n${input.prompt}`

const errorMessage = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error)

const defaultRunner: ChildRunner = (ctx) =>
  runTurn(ctx.session, { maxIterations: 20, onEvent: ctx.emit }).pipe(
    Effect.provide(toolRegistryLayer(Array.from(ctx.registry.values()))),
    Effect.provideService(ToolContext, ctx.context),
    Effect.map(() => finalAssistantText(ctx.session)),
  )

const removeKey = <V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> => {
  const next = new Map(map)
  next.delete(key)
  return next
}

export const makeOrchestrator = (config: OrchestratorConfig = {}): Effect.Effect<Orchestrator> =>
  Effect.gen(function* () {
    const max = config.maxConcurrentSubagents ?? DEFAULT_MAX_CONCURRENT
    const runChild = config.runChild ?? defaultRunner
    const active = yield* Ref.make<ReadonlyMap<string, Fiber.RuntimeFiber<void, never>>>(new Map())
    const completions = yield* Queue.unbounded<void>()
    const emitEvent = (event: SubagentEvent): Effect.Effect<void> =>
      config.onEvent?.(event) ?? Effect.void

    const spawn = (
      input: SpawnInput,
      parent: ParentRunContext,
    ): Effect.Effect<SpawnResult, ToolError, SpawnR> =>
      Effect.gen(function* () {
        const count = yield* Ref.get(active).pipe(Effect.map((m) => m.size))
        if (count >= max) {
          return yield* new ToolError({
            tool: "Agent",
            reason: "precondition-failed",
            message: `Too many active subagents (max ${max}). Wait for one to finish before spawning more.`,
          })
        }

        const agentId = crypto.randomUUID()
        const definition = getSubagentDefinition(input.agentType)
        // GeneralPurpose is the only write-capable type; it always isolates in v1.
        const worktree: AgentWorktree | undefined =
          input.agentType === "GeneralPurpose"
            ? yield* createAgentWorktree(parent.session.workingDirectory, agentId)
            : undefined

        const task = yield* claimTask({
          owner: agentId,
          agentType: input.agentType,
          subject: input.description,
          description: input.prompt,
          ...(worktree !== undefined && {
            worktreePath: worktree.path,
            worktreeBranch: worktree.branch,
          }),
          ...(input.taskId !== undefined && { taskId: input.taskId }),
        }).pipe(
          Effect.mapError((error) => toToolError("Agent", error)),
          Effect.tapError(() =>
            worktree !== undefined ? cleanupAgentWorktree(worktree) : Effect.void,
          ),
        )
        const taskId = task.id

        const registry = makeChildToolRegistry(input.agentType, parent.tools, {
          isolated: worktree !== undefined,
        })
        // Inherit the parent's current model/options unless the spawn overrides
        // them (Agent.model). The child reads request options from its own
        // session state each turn.
        const childSession = createSessionState({
          sessionId: `${parent.session.sessionId}:${agentId}`,
          workingDirectory: worktree?.path ?? parent.session.workingDirectory,
          model: input.model ?? parent.session.systemContext.model,
          modelRef: input.modelRef ?? parent.session.systemContext.modelRef,
          requestOptions: input.requestOptions ?? parent.session.systemContext.requestOptions,
          permissionMode: parent.session.systemContext.permissionMode,
          currentDate: parent.session.systemContext.currentDate,
          messages: [userMessage(childBrief(definition, input))],
        })
        const childContext: ToolContextValue = {
          session: childSession,
          // Fresh signal: cancelling the parent turn never kills detached children.
          abortSignal: new AbortController().signal,
          permission: parent.permission,
        }

        yield* emitEvent({
          type: "subagent-start",
          agentId,
          taskId,
          agentType: input.agentType,
          description: input.description,
        })

        let toolUseCount = 0
        const childEmit = (event: AgentEvent): Effect.Effect<void> => {
          if (event.type === "tool-execution-start") {
            toolUseCount += 1
            return emitEvent({
              type: "subagent-progress",
              agentId,
              taskId,
              lastTool: event.name,
              lastToolInput: event.input,
              toolUseCount,
            })
          }
          return Effect.void
        }

        const finalize = Effect.gen(function* () {
          const outcome = yield* runChild({
            session: childSession,
            registry,
            context: childContext,
            agentType: input.agentType,
            emit: childEmit,
          }).pipe(
            Effect.map((result) => ({ ok: true as const, result })),
            Effect.catchAll((error) =>
              Effect.succeed({ ok: false as const, error: errorMessage(error) }),
            ),
          )
          const cleanup =
            worktree !== undefined
              ? yield* cleanupAgentWorktree(worktree)
              : { retained: false as const }
          const worktreeFields =
            cleanup.retained === true
              ? {
                  ...(cleanup.path !== undefined && { worktreePath: cleanup.path }),
                  ...(cleanup.branch !== undefined && { worktreeBranch: cleanup.branch }),
                }
              : {}
          // Durable-before-visible: persist the result, then ring the doorbell.
          // A persist failure is logged, never swallowed — the in-memory result
          // is already committed (so the parent is still notified this session),
          // but the durable record may be stale and trigger re-delegation on the
          // next start, which is worth surfacing.
          const logPersistFailure = (error: unknown): Effect.Effect<void> =>
            Effect.logError(`Failed to persist result of task ${taskId}: ${errorMessage(error)}`)
          if (outcome.ok) {
            yield* completeTask(taskId, outcome.result, worktreeFields).pipe(
              Effect.catchAll(logPersistFailure),
            )
            yield* emitEvent({
              type: "subagent-complete",
              agentId,
              taskId,
              result: outcome.result,
              ...(cleanup.retained === true &&
                cleanup.path !== undefined && { worktreePath: cleanup.path }),
            })
          } else {
            yield* failTask(taskId, outcome.error, worktreeFields).pipe(
              Effect.catchAll(logPersistFailure),
            )
            yield* emitEvent({ type: "subagent-failed", agentId, taskId, error: outcome.error })
          }
          yield* Queue.offer(completions, undefined)
        }).pipe(Effect.ensuring(Ref.update(active, (m) => removeKey(m, agentId))))

        const fiber = yield* Effect.forkDaemon(finalize)
        yield* Ref.update(active, (m) => new Map(m).set(agentId, fiber))
        return { agentId, taskId, agentType: input.agentType }
      })

    const recoverDangling = (
      parent: ParentRunContext,
    ): Effect.Effect<ReadonlyArray<SpawnResult>, ToolError, SpawnR> =>
      Effect.gen(function* () {
        const reset = yield* resetDanglingTasks().pipe(
          Effect.mapError((error) => toToolError("Agent", error)),
        )
        // Discard the dead subagents' orphaned worktrees before re-delegating.
        yield* removeTaskWorktrees(parent.session.workingDirectory, reset)
        const results: Array<SpawnResult> = []
        for (const task of reset) {
          if (task.agentType === undefined) continue
          const result = yield* spawn(
            {
              description: task.subject,
              prompt: task.description,
              agentType: task.agentType,
              taskId: task.id,
            },
            parent,
          )
          results.push(result)
        }
        return results
      })

    return {
      spawn,
      activeCount: Ref.get(active).pipe(Effect.map((m) => m.size)),
      completions,
      interruptAll: Effect.gen(function* () {
        const fibers = yield* Ref.get(active)
        yield* Effect.forEach(fibers.values(), (fiber) => Fiber.interrupt(fiber), { discard: true })
        yield* Ref.set(active, new Map())
      }),
      recoverDangling,
    }
  })
