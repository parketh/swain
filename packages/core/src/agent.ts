import type {
  FinishReason,
  LLMError,
  LLMEvent,
  Tool as LLMTool,
  ToolCall,
  ToolCallId,
  ToolResultContent,
  Usage,
} from "@swain/llms"
import { LLMClient, LLMTurnSummary, Message } from "@swain/llms"
import { Context, Effect, Either, Option, Schema, Stream } from "effect"
import { recordContextUsage } from "./context"
import { AgentError } from "./errors"
import { type ModelResolver, ModelResolverService } from "./model-resolver"
import { assembleSystemPrompt, type RouterPromptTarget } from "./prompt"
import {
  modelRefKey,
  recordModelTransition,
  type SessionModelRef,
  type SessionState,
} from "./state"
import type { AgentType, Task } from "./tasks"
import type { ToolContext, ToolRegistry } from "./tools"
import {
  callTool,
  errorResult,
  SWITCH_MODEL_NAME,
  SwitchModelInput,
  successResult,
  ToolRegistry as ToolRegistryTag,
  toLLMTool,
} from "./tools"

type LLMClientService = Context.Tag.Identifier<typeof LLMClient.Service>

const DEFAULT_MAX_ITERATIONS = 20

export const submitPrompt = (session: SessionState, prompt: string, isMeta = false): void => {
  session.messages.push(Message.user(prompt, isMeta))
}

export const INTERRUPT_MESSAGE = "[Request interrupted by user]"
export const INTERRUPT_MESSAGE_FOR_TOOL_USE = "[Request interrupted by user for tool use]"

/**
 * Records a user interruption without retracting the turn, mirroring Claude
 * Code: the interrupted turn and any tasks it created are preserved. It repairs
 * the trailing state so provider role-alternation stays valid — orphan
 * `tool_use` blocks (assistant emitted tool calls that never ran) are answered
 * with interrupted tool results — then commits any partial assistant text and
 * appends an interrupt marker as the final assistant message.
 */
export const recordInterruption = (session: SessionState, partialText?: string): void => {
  const messages = session.messages
  const last = messages[messages.length - 1]
  const pendingCalls =
    last?.role === "assistant"
      ? last.content.filter((block): block is ToolCall => block.type === "tool-call")
      : []
  if (pendingCalls.length > 0) {
    messages.push(
      Message.user(pendingCalls.map((call) => errorResult(call, INTERRUPT_MESSAGE_FOR_TOOL_USE))),
    )
    messages.push(Message.assistant([{ type: "text", text: INTERRUPT_MESSAGE }]))
    return
  }
  const trimmed = partialText?.trim()
  const text = trimmed ? `${trimmed}\n\n${INTERRUPT_MESSAGE}` : INTERRUPT_MESSAGE
  messages.push(Message.assistant([{ type: "text", text }]))
}

/**
 * Observable facts about a running turn. Emitted through `RunTurnOptions.onEvent`
 * for UI consumers; they never change the loop's final session mutation.
 */
export type AgentEvent =
  | { readonly type: "llm-event"; readonly event: LLMEvent }
  | { readonly type: "step-start"; readonly iteration: number }
  | {
      readonly type: "step-end"
      readonly iteration: number
      readonly reason: FinishReason
      readonly usage?: Usage
    }
  | {
      readonly type: "tool-execution-start"
      readonly name: string
      readonly toolCallId: ToolCallId
      readonly input: unknown
    }
  | {
      readonly type: "tool-execution-delta"
      readonly name: string
      readonly toolCallId: ToolCallId
      readonly text: string
    }
  | {
      readonly type: "tool-execution-end"
      readonly name: string
      readonly toolCallId: ToolCallId
      readonly isError: boolean
    }
  | {
      readonly type: "agent-error"
      readonly source: "llm" | "agent" | "tool"
      readonly message: string
      readonly recoverable?: boolean
    }
  | { readonly type: "task-updated"; readonly tasks: ReadonlyArray<Task> }
  | { readonly type: "model-switch"; readonly to: SessionModelRef }
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

export interface RunTurnOptions {
  readonly maxIterations?: number
  /**
   * Present only when routing is active (global router status `on`). Its
   * presence exposes `SwitchModel` and injects the router prompt block; the
   * `[current]` marker is recomputed each iteration from live session state.
   * Router status is global config, so this is fixed per user turn.
   */
  readonly router?: { readonly targets: ReadonlyArray<RouterPromptTarget> }
  readonly onEvent?: (event: AgentEvent) => Effect.Effect<void>
}

interface LoopContext {
  /** Reassembles the system prompt from live session state (model may change on a switch). */
  readonly buildSystem: () => string
  readonly llmTools: ReadonlyArray<LLMTool>
  readonly maxIterations: number
  readonly resolver: Option.Option<ModelResolver>
  readonly emit: (event: AgentEvent) => Effect.Effect<void>
}

type SwitchOutcome =
  | { readonly kind: "switched"; readonly meta: Message }
  | { readonly kind: "noop"; readonly model: string }
  | { readonly kind: "error"; readonly message: string }

/**
 * Resolves a `SwitchModel` tool call into a control-flow outcome. A same-target
 * request is a no-op; a second switch in the same turn, a malformed input, an
 * absent resolver, or an unresolvable target all yield a recoverable error. A
 * valid cross-target switch updates the session's current model/options and
 * returns the typed meta message that replaces the switching assistant message.
 */
const resolveSwitch = (
  session: SessionState,
  call: ToolCall,
  alreadySwitched: boolean,
  resolver: Option.Option<ModelResolver>,
): Effect.Effect<SwitchOutcome> =>
  Effect.gen(function* () {
    if (alreadySwitched) {
      return {
        kind: "error",
        message: "A model switch already happened this turn; only one is allowed per user turn.",
      }
    }
    const decoded = yield* Schema.decodeUnknown(SwitchModelInput)(call.input).pipe(Effect.option)
    if (Option.isNone(decoded)) {
      return { kind: "error", message: "SwitchModel requires a target `model` id and a `reason`." }
    }
    const input = decoded.value
    const from = session.systemContext.modelRef
    if (input.model === modelRefKey(from)) {
      return { kind: "noop", model: input.model }
    }
    if (Option.isNone(resolver)) {
      return { kind: "error", message: "Model routing is unavailable in this session." }
    }
    const resolved = yield* resolver.value.resolve(input.model).pipe(Effect.either)
    if (Either.isLeft(resolved)) {
      return { kind: "error", message: resolved.left.message }
    }
    const target = resolved.right
    const previous =
      recordModelTransition(session, {
        model: target.model,
        modelRef: target.modelRef,
        requestOptions: target.requestOptions,
      }) ?? from
    const meta = Message.user(
      [
        {
          type: "model-switch" as const,
          from: {
            provider: previous.provider,
            modelId: previous.modelId,
            ...(previous.variant !== undefined && { variant: previous.variant }),
          },
          to: {
            provider: target.modelRef.provider,
            modelId: target.modelRef.modelId,
            ...(target.modelRef.variant !== undefined && { variant: target.modelRef.variant }),
          },
          reason: input.reason,
          requestedBy: "router" as const,
        },
      ],
      true,
    )
    return { kind: "switched", meta }
  })

/** Executes tool calls, emitting lifecycle events, and returns their results. */
const executeTools = (
  toolCalls: ReadonlyArray<ToolCall>,
  emit: (event: AgentEvent) => Effect.Effect<void>,
): Effect.Effect<Array<ToolResultContent>, never, ToolContext | ToolRegistry> =>
  Effect.forEach(toolCalls, (toolCall) =>
    emit({
      type: "tool-execution-start",
      name: toolCall.name,
      toolCallId: toolCall.toolCallId,
      input: toolCall.input,
    }).pipe(
      Effect.andThen(
        callTool(toolCall, (text) =>
          emit({
            type: "tool-execution-delta",
            name: toolCall.name,
            toolCallId: toolCall.toolCallId,
            text,
          }),
        ),
      ),
      Effect.tap((result) =>
        emit({
          type: "tool-execution-end",
          name: toolCall.name,
          toolCallId: toolCall.toolCallId,
          isError: result.isError === true,
        }),
      ),
    ),
  )

/**
 * Runs the agent loop over the session: assemble the system prompt, stream an
 * LLM turn, append the assistant content, and while the model keeps calling
 * tools, execute them and feed the results back. Stops when the finish reason
 * is not `tool-call`, or fails once the iteration guard is exceeded.
 *
 * When `options.onEvent` is supplied, provider deltas, step boundaries, tool
 * lifecycle, and fatal errors are forwarded as they occur; the returned
 * `Effect<void>` and its session mutations are unchanged for callers that omit
 * it.
 */
export const runTurn = (
  session: SessionState,
  options: RunTurnOptions = {},
): Effect.Effect<void, AgentError | LLMError, LLMClientService | ToolRegistry | ToolContext> =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistryTag
    const routerActive = options.router !== undefined
    // SwitchModel is only offered to the model when routing is active; it stays
    // in the registry for runtime interception either way.
    const tools = Array.from(registry.values()).filter(
      (tool) => tool.name !== SWITCH_MODEL_NAME || routerActive,
    )
    const llmTools = tools.map(toLLMTool)
    const toolDescriptors = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    }))
    const routerTargets = options.router?.targets
    // Reassembled from live session state each iteration so a mid-turn switch is
    // reflected: the new model id, and the router block's [current] marker.
    const buildSystem = (): string =>
      assembleSystemPrompt({
        workingDirectory: session.workingDirectory,
        currentDate: session.systemContext.currentDate,
        model: session.systemContext.model.id,
        permissionMode: session.systemContext.permissionMode,
        tools: toolDescriptors,
        ...(routerTargets !== undefined && {
          router: {
            targets: routerTargets,
            currentId: modelRefKey(session.systemContext.modelRef),
          },
        }),
      })
    const resolver = yield* Effect.serviceOption(ModelResolverService)
    const emit = (event: AgentEvent): Effect.Effect<void> => options.onEvent?.(event) ?? Effect.void
    yield* loop(
      session,
      {
        buildSystem,
        llmTools,
        maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        resolver,
        emit,
      },
      0,
      false,
    )
  })

const loop = (
  session: SessionState,
  ctx: LoopContext,
  iteration: number,
  switched: boolean,
): Effect.Effect<void, AgentError | LLMError, LLMClientService | ToolContext | ToolRegistry> =>
  Effect.gen(function* () {
    if (iteration >= ctx.maxIterations) {
      const message = `Exceeded ${ctx.maxIterations} tool iterations without completing the turn.`
      yield* ctx.emit({ type: "agent-error", source: "agent", message, recoverable: false })
      return yield* new AgentError({ reason: "max-iterations", message })
    }

    // On the final permitted iteration, withhold tools so the model must
    // produce a final answer instead of calling another tool and overrunning
    // the budget — a graceful conclusion beats a hard max-iterations failure.
    const toolsAllowed = iteration < ctx.maxIterations - 1
    const requestOptions = session.systemContext.requestOptions
    const request = LLMClient.request({
      model: session.systemContext.model,
      system: ctx.buildSystem(),
      messages: session.messages,
      ...(toolsAllowed &&
        ctx.llmTools.length > 0 && { tools: ctx.llmTools, toolChoice: "auto" as const }),
      ...(requestOptions.generation !== undefined && { generation: requestOptions.generation }),
      ...(requestOptions.providerOptions !== undefined && {
        providerOptions: requestOptions.providerOptions,
      }),
    })

    yield* ctx.emit({ type: "step-start", iteration })

    // Stream events as they arrive: forward each as `llm-event` (including
    // provider-error, which is never re-emitted as `agent-error`) while still
    // collecting them for the turn summary.
    const collected: Array<LLMEvent> = []
    yield* LLMClient.streamTurn(request).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => collected.push(event)).pipe(
          Effect.andThen(ctx.emit({ type: "llm-event", event })),
        ),
      ),
      Effect.catchAll((error) =>
        ctx
          .emit({ type: "agent-error", source: "llm", message: error.message, recoverable: false })
          .pipe(Effect.andThen(Effect.fail(error))),
      ),
    )

    const summary = yield* LLMTurnSummary.fromEvents(collected).pipe(
      Effect.catchAll((error) =>
        ctx
          .emit({ type: "agent-error", source: "llm", message: error.message, recoverable: false })
          .pipe(Effect.andThen(Effect.fail(error))),
      ),
    )

    session.messages.push(Message.assistant(summary.assistantContent))
    session.counters.turns += 1
    if (summary.usage !== undefined) {
      session.counters.inputTokens += summary.usage.inputTokens
      session.counters.outputTokens += summary.usage.outputTokens
      recordContextUsage(session, summary.usage)
    }

    yield* ctx.emit({
      type: "step-end",
      iteration,
      reason: summary.finish.reason,
      ...(summary.usage !== undefined && { usage: summary.usage }),
    })

    // Use the concrete tool-call blocks as the continuation signal, not
    // `finish.reason` alone: providers can report `tool-call` with no calls (or
    // vice versa), and the emitted blocks are what we actually execute.
    if (summary.toolCalls.length === 0) return

    // Intercept SwitchModel as control flow before ordinary tool continuation.
    const switchCalls = summary.toolCalls.filter((call) => call.name === SWITCH_MODEL_NAME)
    const firstSwitch = switchCalls[0]
    if (firstSwitch !== undefined) {
      const outcome = yield* resolveSwitch(session, firstSwitch, switched, ctx.resolver)
      if (outcome.kind === "switched") {
        // Replace the whole switching assistant message with the meta switch
        // message: no orphan tool_use (switch or sibling) survives, so no
        // tool_result is owed. Any siblings are dropped and reissued next turn.
        session.messages[session.messages.length - 1] = outcome.meta
        // Signal the switch so the UI can reflect the new current model mid-turn
        // (the turn continues on the target); session state is already updated.
        yield* ctx.emit({ type: "model-switch", to: session.systemContext.modelRef })
        return yield* loop(session, ctx, iteration + 1, true)
      }
      // No-op or error: reply to each switch call and run the siblings normally.
      const resultById = new Map<ToolCallId, ToolResultContent>(
        switchCalls.map((call, index) => [
          call.toolCallId,
          index > 0
            ? errorResult(call, "Only one model switch is allowed per user turn.")
            : outcome.kind === "noop"
              ? successResult(call, { status: "noop", model: outcome.model })
              : errorResult(call, outcome.message),
        ]),
      )
      const siblings = summary.toolCalls.filter((call) => call.name !== SWITCH_MODEL_NAME)
      const siblingResults = yield* executeTools(siblings, ctx.emit)
      siblings.forEach((call, index) => resultById.set(call.toolCallId, siblingResults[index]!))
      // Preserve the assistant's original tool_call order in the results.
      const results = summary.toolCalls.map((call) => resultById.get(call.toolCallId)!)
      session.messages.push(Message.user(results))
      return yield* loop(session, ctx, iteration + 1, switched)
    }

    const results = yield* executeTools(summary.toolCalls, ctx.emit)
    session.messages.push(Message.user(results))
    return yield* loop(session, ctx, iteration + 1, switched)
  })
