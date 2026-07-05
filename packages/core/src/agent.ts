import type {
  FinishReason,
  GenerationOptions,
  LLMError,
  LLMEvent,
  Tool as LLMTool,
  ProviderOptions,
  ToolCallId,
  Usage,
} from "@swain/llms"
import { LLMClient, LLMTurnSummary, Message } from "@swain/llms"
import { Context, Effect, Stream } from "effect"
import { AgentError } from "./errors"
import { assembleSystemPrompt } from "./prompt"
import type { SessionState } from "./state"
import type { ToolContext, ToolRegistry } from "./tools"
import { callTool, ToolRegistry as ToolRegistryTag, toLLMTool } from "./tools"

type LLMClientService = Context.Tag.Identifier<typeof LLMClient.Service>

const DEFAULT_MAX_ITERATIONS = 20

export const submitPrompt = (session: SessionState, prompt: string): void => {
  session.messages.push(Message.user(prompt))
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

export interface RunTurnOptions {
  readonly maxIterations?: number
  readonly generation?: GenerationOptions
  readonly providerOptions?: ProviderOptions
  readonly onEvent?: (event: AgentEvent) => Effect.Effect<void>
}

interface LoopContext {
  readonly system: string
  readonly llmTools: ReadonlyArray<LLMTool>
  readonly maxIterations: number
  readonly generation?: GenerationOptions
  readonly providerOptions?: ProviderOptions
  readonly emit: (event: AgentEvent) => Effect.Effect<void>
}

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
    const tools = Array.from(registry.values())
    const llmTools = tools.map(toLLMTool)
    // TODO: assembled once per turn, outside the loop. Move inside `loop` once
    // the prompt depends on per-iteration state (memory, skills, MCP servers).
    const system = assembleSystemPrompt({
      workingDirectory: session.workingDirectory,
      currentDate: session.systemContext.currentDate,
      model: session.systemContext.model.id,
      permissionMode: session.systemContext.permissionMode,
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
    })
    const emit = (event: AgentEvent): Effect.Effect<void> => options.onEvent?.(event) ?? Effect.void
    yield* loop(
      session,
      {
        system,
        llmTools,
        maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        ...(options.generation !== undefined && { generation: options.generation }),
        ...(options.providerOptions !== undefined && { providerOptions: options.providerOptions }),
        emit,
      },
      0,
    )
  })

const loop = (
  session: SessionState,
  ctx: LoopContext,
  iteration: number,
): Effect.Effect<void, AgentError | LLMError, LLMClientService | ToolContext | ToolRegistry> =>
  Effect.gen(function* () {
    if (iteration >= ctx.maxIterations) {
      const message = `Exceeded ${ctx.maxIterations} tool iterations without completing the turn.`
      yield* ctx.emit({ type: "agent-error", source: "agent", message, recoverable: false })
      return yield* new AgentError({ reason: "max-iterations", message })
    }

    const request = LLMClient.request({
      model: session.systemContext.model,
      system: ctx.system,
      messages: session.messages,
      ...(ctx.llmTools.length > 0 && { tools: ctx.llmTools, toolChoice: "auto" as const }),
      ...(ctx.generation !== undefined && { generation: ctx.generation }),
      ...(ctx.providerOptions !== undefined && { providerOptions: ctx.providerOptions }),
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

    const results = yield* Effect.forEach(summary.toolCalls, (toolCall) =>
      ctx
        .emit({
          type: "tool-execution-start",
          name: toolCall.name,
          toolCallId: toolCall.toolCallId,
          input: toolCall.input,
        })
        .pipe(
          Effect.andThen(callTool(toolCall)),
          Effect.tap((result) =>
            ctx.emit({
              type: "tool-execution-end",
              name: toolCall.name,
              toolCallId: toolCall.toolCallId,
              isError: result.isError === true,
            }),
          ),
        ),
    )
    session.messages.push(Message.user(results))
    return yield* loop(session, ctx, iteration + 1)
  })
