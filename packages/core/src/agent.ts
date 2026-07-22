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
import { Clock, Context, Duration, Effect, Either, Option, Schedule, Schema, Stream } from "effect"
import {
  compactSession,
  defaultTokenCounter,
  deriveContext,
  REASONING_LOSS_COMPACTION_WARNING,
  type RequestShape,
  recordContextUsage,
  shouldAutoCompact,
  ToolResultStoreService,
  warnsOnReasoningLoss,
} from "./context"
import { AgentError } from "./errors"
import { type ModelResolver, ModelResolverService } from "./model-resolver"
import { assembleSystemPrompt, type RouterPromptTarget } from "./prompt"
import {
  assistantMessage,
  modelRefKey,
  recordModelTransition,
  type SessionModelRef,
  type SessionState,
  userMessage,
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

// Bounded retry for a single LLM request that fails with a retryable error
// (network stall, rate-limit, overload, 5xx). Intermittent provider drops
// usually succeed on the next attempt, so a few quick retries keep a turn alive.
const MAX_STREAM_RETRIES = 2
const STREAM_RETRY_DELAY = Duration.seconds(1)

export const submitPrompt = (session: SessionState, prompt: string, isMeta = false): void => {
  session.messages.push(userMessage(prompt, { isMeta }))
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
      userMessage(pendingCalls.map((call) => errorResult(call, INTERRUPT_MESSAGE_FOR_TOOL_USE))),
    )
    messages.push(assistantMessage([{ type: "text", text: INTERRUPT_MESSAGE }]))
    return
  }
  const trimmed = partialText?.trim()
  const text = trimmed ? `${trimmed}\n\n${INTERRUPT_MESSAGE}` : INTERRUPT_MESSAGE
  messages.push(assistantMessage([{ type: "text", text }]))
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
  | { readonly type: "compaction-warning"; readonly message: string }
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
  /**
   * Marks the run non-interactive (headless exec): the system prompt tells the
   * model no user is available and to proceed on reasonable assumptions.
   */
  readonly nonInteractive?: boolean
  readonly onEvent?: (event: AgentEvent) => Effect.Effect<void>
}

interface LoopContext {
  /** Reassembles the system prompt from live session state (model may change on a switch). */
  readonly buildSystem: () => string
  readonly llmTools: ReadonlyArray<LLMTool>
  readonly maxIterations: number
  readonly resolver: Option.Option<ModelResolver>
  readonly emit: (event: AgentEvent) => Effect.Effect<void>
  /** Tool names whose `callTool` latency is persisted as `durationMs`. */
  readonly timedTools: ReadonlySet<string>
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
    // The meta replaces the just-committed assistant response, so it inherits
    // that response's commit timestamp and provider-response duration rather than
    // fabricating a later, unrelated one.
    const replaced = session.messages[session.messages.length - 1]
    const meta = userMessage(
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
      {
        isMeta: true,
        ...(replaced?.createdAt !== undefined && { createdAt: replaced.createdAt }),
        ...(replaced?.responseDurationMs !== undefined && {
          responseDurationMs: replaced.responseDurationMs,
        }),
      },
    )
    return { kind: "switched", meta }
  })

/**
 * Executes tool calls, emitting lifecycle events, and returns their results.
 * Oversized result bodies are persisted to disk (replaced with a preview + path)
 * when a `ToolResultStoreService` is provided, so they never enter the transcript
 * as full model-visible text; without the service, results pass through.
 */
const executeTools = (
  session: SessionState,
  toolCalls: ReadonlyArray<ToolCall>,
  emit: (event: AgentEvent) => Effect.Effect<void>,
  timedTools: ReadonlySet<string>,
): Effect.Effect<Array<ToolResultContent>, never, ToolContext | ToolRegistry> =>
  Effect.gen(function* () {
    const store = yield* Effect.serviceOption(ToolResultStoreService)
    return yield* Effect.forEach(toolCalls, (toolCall) => {
      const executed = callTool(toolCall, (text) =>
        emit({
          type: "tool-execution-delta",
          name: toolCall.name,
          toolCallId: toolCall.toolCallId,
          text,
        }),
      )
      // Time only opted-in tools, and only the `callTool` lifecycle — not the
      // start/end observer work or later oversized-result offloading.
      const measured = timedTools.has(toolCall.name)
        ? Effect.timed(executed).pipe(
            Effect.map(([elapsed, result]) => ({
              ...result,
              durationMs: Duration.toMillis(elapsed),
            })),
          )
        : executed
      return emit({
        type: "tool-execution-start",
        name: toolCall.name,
        toolCallId: toolCall.toolCallId,
        input: toolCall.input,
      }).pipe(
        Effect.andThen(measured),
        Effect.tap((result) =>
          emit({
            type: "tool-execution-end",
            name: toolCall.name,
            toolCallId: toolCall.toolCallId,
            isError: result.isError === true,
          }),
        ),
        Effect.flatMap((result) =>
          Option.isSome(store) ? store.value.persist(session, result) : Effect.succeed(result),
        ),
      )
    })
  })

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
/**
 * Emits the reasoning-loss notice after compaction runs on a model that depends
 * on full reasoning history (Kimi K3) — once per compaction, not once per
 * session. Compaction itself is unchanged; this only surfaces Moonshot's
 * cross-turn-loss warning to the user.
 */
const warnCompactionReasoningLoss = (
  session: SessionState,
  emit: (event: AgentEvent) => Effect.Effect<void>,
): Effect.Effect<void> =>
  warnsOnReasoningLoss(session)
    ? emit({ type: "compaction-warning", message: REASONING_LOSS_COMPACTION_WARNING })
    : Effect.void

export const runTurn = (
  session: SessionState,
  options: RunTurnOptions = {},
): Effect.Effect<void, AgentError | LLMError, LLMClientService | ToolRegistry | ToolContext> =>
  Effect.gen(function* () {
    // Whole-turn timer starts at entry — before registry setup and preflight
    // compaction — so user-visible latency includes every part of the turn.
    const turnStart = yield* Clock.currentTimeNanos
    const registry = yield* ToolRegistryTag
    const routerActive = options.router !== undefined
    // SwitchModel is only offered to the model when routing is active; it stays
    // in the registry for runtime interception either way.
    const tools = Array.from(registry.values()).filter(
      (tool) => tool.name !== SWITCH_MODEL_NAME || routerActive,
    )
    const llmTools = tools.map(toLLMTool)
    const timedTools = new Set(tools.filter((tool) => tool.recordDuration).map((tool) => tool.name))
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
        ...(options.nonInteractive === true && { nonInteractive: true }),
      })
    const resolver = yield* Effect.serviceOption(ModelResolverService)
    const emit = (event: AgentEvent): Effect.Effect<void> => options.onEvent?.(event) ?? Effect.void
    const ctx: LoopContext = {
      buildSystem,
      llmTools,
      maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      resolver,
      emit,
      timedTools,
    }

    // Preflight: compact once before the turn if estimated pressure is high.
    // A failed auto compaction disables auto for the session (manual stays
    // available) and surfaces a recoverable error, but the turn proceeds.
    const shape: RequestShape = { system: buildSystem(), tools: llmTools }
    if (shouldAutoCompact(session, shape, defaultTokenCounter)) {
      yield* compactSession(session, { reason: "auto" }).pipe(
        Effect.tap(() => warnCompactionReasoningLoss(session, emit)),
        Effect.catchAll((error) =>
          Effect.sync(() => {
            Object.assign(session.compaction, {
              autoEnabled: false,
              failureReason: error.message,
            })
          }).pipe(
            Effect.andThen(
              emit({
                type: "agent-error",
                source: "agent",
                message: `Automatic compaction failed: ${error.message}`,
                recoverable: true,
              }),
            ),
          ),
        ),
      )
    }

    yield* runWithOverflowRetry(session, ctx)

    // Attach whole-turn latency to the final assistant response only. Guard that
    // the last message is actually an assistant message so a trailing meta user
    // message (a same-turn model switch or compaction) never receives it.
    const turnEnd = yield* Clock.currentTimeNanos
    const turnDurationMs = Duration.toMillis(Duration.nanos(turnEnd - turnStart))
    const lastIndex = session.messages.length - 1
    const last = session.messages[lastIndex]
    if (last?.role === "assistant") {
      session.messages[lastIndex] = { ...last, turnDurationMs }
    }
  })

const isContextOverflowError = (error: AgentError | LLMError): error is LLMError =>
  error._tag === "LLMError" && error.reason === "context-length-exceeded"

/**
 * Runs the loop, and on a provider context-overflow runs one full compaction
 * (reason `overflow`) and retries the turn once. A failed compaction re-surfaces
 * the original overflow; a second overflow after the retry propagates as the
 * typed error.
 */
const runWithOverflowRetry = (
  session: SessionState,
  ctx: LoopContext,
): Effect.Effect<void, AgentError | LLMError, LLMClientService | ToolContext | ToolRegistry> =>
  loop(session, ctx, 0, false).pipe(
    Effect.catchIf(isContextOverflowError, (overflow) =>
      compactSession(session, { reason: "overflow" }).pipe(
        Effect.tap(() => warnCompactionReasoningLoss(session, ctx.emit)),
        Effect.catchAll(() => Effect.fail(overflow)),
        Effect.andThen(loop(session, ctx, 0, false)),
      ),
    ),
  )

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
      messages: deriveContext(session.messages).messages,
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
    // collecting them for the turn summary. A fresh buffer per attempt so a
    // retried request never mixes partial output from a failed one.
    const streamOnce = Effect.suspend(() => {
      const events: Array<LLMEvent> = []
      return LLMClient.streamTurn(request).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => events.push(event)).pipe(
            Effect.andThen(ctx.emit({ type: "llm-event", event })),
          ),
        ),
        Effect.as(events),
      )
    })

    // Intermittent provider stalls (e.g. a Codex stream that never produces a
    // response) surface as retryable errors. Retry the request a bounded number
    // of times before giving up so a transient drop doesn't kill an otherwise
    // healthy turn; prior iterations' tool-use is already committed to
    // session.messages and untouched. Non-retryable errors (auth, invalid
    // request, context overflow) fail immediately.
    // Time the whole provider-response cycle: stream collection plus any
    // retryable failed attempts and their backoff. The monotonic clock stops
    // once the final event is collected; summary decoding is excluded.
    const [responseElapsed, collected] = yield* streamOnce.pipe(
      Effect.retry(
        Schedule.recurs(MAX_STREAM_RETRIES).pipe(
          Schedule.whileInput((error: LLMError) => error.retryable),
          Schedule.addDelay(() => STREAM_RETRY_DELAY),
        ),
      ),
      Effect.catchAll((error) =>
        ctx
          .emit({ type: "agent-error", source: "llm", message: error.message, recoverable: false })
          .pipe(Effect.andThen(Effect.fail(error))),
      ),
      Effect.timed,
    )
    const responseDurationMs = Duration.toMillis(responseElapsed)

    const summary = yield* LLMTurnSummary.fromEvents(collected).pipe(
      Effect.catchAll((error) =>
        ctx
          .emit({ type: "agent-error", source: "llm", message: error.message, recoverable: false })
          .pipe(Effect.andThen(Effect.fail(error))),
      ),
    )

    session.messages.push(
      assistantMessage(summary.assistantContent, {
        responseDurationMs,
        ...(summary.usage !== undefined && { usage: summary.usage }),
      }),
    )
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
        // Sanitize the switching assistant message: keep its reasoning/text so
        // the switch's rationale survives (K3 needs the reasoning history), but
        // drop every tool_use block (the switch call and any siblings) so no
        // orphan tool_result is owed. Siblings are reissued next turn. A
        // tool-only step leaves nothing to retain, so the marker stands alone.
        const lastIndex = session.messages.length - 1
        const switching = session.messages[lastIndex]
        const retained =
          switching?.role === "assistant"
            ? switching.content.filter((block) => block.type !== "tool-call")
            : []
        if (retained.length > 0) {
          session.messages[lastIndex] = Message.assistant(retained)
          session.messages.push(outcome.meta)
        } else {
          session.messages[lastIndex] = outcome.meta
        }
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
      const siblingResults = yield* executeTools(session, siblings, ctx.emit, ctx.timedTools)
      siblings.forEach((call, index) => resultById.set(call.toolCallId, siblingResults[index]!))
      // Preserve the assistant's original tool_call order in the results.
      const results = summary.toolCalls.map((call) => resultById.get(call.toolCallId)!)
      session.messages.push(userMessage(results))
      return yield* loop(session, ctx, iteration + 1, switched)
    }

    const results = yield* executeTools(session, summary.toolCalls, ctx.emit, ctx.timedTools)
    session.messages.push(userMessage(results))
    return yield* loop(session, ctx, iteration + 1, switched)
  })
