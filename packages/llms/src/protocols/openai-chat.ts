import { Effect, Stream } from "effect"
import type {
  FinishReason,
  GenerationOptions,
  LLMEvent,
  Message,
  ProviderOptions,
  SystemContent,
  Tool,
  ToolChoice,
  ToolResultValue,
  Usage,
} from "../schema"
import { ContentId, LLMError, renderCompaction, renderModelSwitch, ToolCallId } from "../schema"
import type { ToolInputAssembler } from "./tool-input"
import { ToolInput } from "./tool-input"

export const OPENAI_CHAT_PATH = "/chat/completions"

/**
 * Reasoning effort for OpenAI-compatible deployments. The superset across
 * deployments: OpenAI accepts `none`–`xhigh`; DeepSeek/Z.AI only `high`/`max`.
 * Each provider's own options type narrows this to what it actually supports.
 */
export type OpenAIChatReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max"

/** Sampling knobs shared by OpenAI-compatible Chat Completions deployments. */
export interface OpenAIChatOptions {
  readonly temperature?: number
  readonly topP?: number
  readonly seed?: number
  /**
   * Enable reasoning via a top-level `thinking: { type: "enabled" }` flag.
   * DeepSeek V4 and Z.AI GLM-5.2 gate reasoning behind this flag; pair it with
   * `reasoningEffort` to grade the depth.
   */
  readonly thinking?: boolean
  /** Reasoning depth sent as `reasoning_effort`; only `high` and `max` are distinct. */
  readonly reasoningEffort?: OpenAIChatReasoningEffort
  /**
   * Explicit prompt-cache routing key sent as `prompt_cache_key`. OpenAI-style
   * prompt caching is unconditionally automatic (there is no enable flag); this
   * only pins requests that share a prefix to the same cache for higher hit
   * rates. Opt-in: only sent when set, since some compatible backends
   * (DeepSeek, Z.AI) reject unknown parameters.
   */
  readonly promptCacheKey?: string
}

export interface OpenAIChatRequest {
  readonly modelId: string
  readonly system?: SystemContent
  readonly messages: ReadonlyArray<Message>
  readonly tools?: ReadonlyArray<Tool>
  readonly toolChoice?: ToolChoice
  readonly generation?: GenerationOptions
  readonly providerOptions?: ProviderOptions
}

export interface OpenAIChatProfile {
  /** `ProviderOptions` key this protocol reads sampling options from. Defaults to `"openai"`. */
  readonly optionsKey?: string
  /** Set false for deployments that reject `stream_options`. */
  readonly includeUsage?: boolean
}

const lowerToolResult = (result: ToolResultValue): string =>
  result.type === "text" ? result.value : JSON.stringify(result.value)

const lowerTool = (tool: Tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  },
})

const lowerToolChoice = (choice: ToolChoice) =>
  typeof choice === "string" ? choice : { type: "function", function: { name: choice.name } }

const lowerMessages = (
  system: SystemContent | undefined,
  messages: ReadonlyArray<Message>,
): Array<Record<string, unknown>> => {
  const wire: Array<Record<string, unknown>> = []
  if (system !== undefined) {
    wire.push({ role: "system", content: system.text })
  }
  for (const message of messages) {
    if (message.role === "user") {
      const texts: Array<string> = []
      for (const block of message.content) {
        if (block.type === "tool-result") {
          wire.push({
            role: "tool",
            tool_call_id: block.toolCallId,
            content: lowerToolResult(block.result),
          })
        } else if (block.type === "model-switch") {
          texts.push(renderModelSwitch(block))
        } else if (block.type === "compaction") {
          texts.push(renderCompaction(block))
        } else {
          texts.push(block.text)
        }
      }
      if (texts.length > 0) {
        wire.push({ role: "user", content: texts.join("\n\n") })
      }
    } else {
      const texts: Array<string> = []
      const toolCalls: Array<Record<string, unknown>> = []
      for (const block of message.content) {
        if (block.type === "text") {
          texts.push(block.text)
        } else if (block.type === "tool-call") {
          toolCalls.push({
            id: block.toolCallId,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          })
        }
        // Reasoning blocks have no OpenAI Chat wire form; they stay local.
      }
      wire.push({
        role: "assistant",
        content: texts.length > 0 ? texts.join("\n\n") : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
    }
  }
  return wire
}

/**
 * Builds the OpenAI Chat Completions request body for one streamed turn.
 * The protocol always streams; `stream: true` is not configurable.
 */
const prepare = (
  request: OpenAIChatRequest,
  profile: OpenAIChatProfile = {},
): { path: string; body: Record<string, unknown> } => {
  const options = (request.providerOptions?.[profile.optionsKey ?? "openai"] ??
    {}) as OpenAIChatOptions
  const body: Record<string, unknown> = {
    model: request.modelId,
    messages: lowerMessages(request.system, request.messages),
    stream: true,
    ...(profile.includeUsage === false ? {} : { stream_options: { include_usage: true } }),
    ...(request.tools !== undefined && request.tools.length > 0
      ? { tools: request.tools.map(lowerTool) }
      : {}),
    ...(request.toolChoice !== undefined
      ? { tool_choice: lowerToolChoice(request.toolChoice) }
      : {}),
    ...(request.generation?.maxTokens !== undefined
      ? { max_tokens: request.generation.maxTokens }
      : {}),
    ...(request.generation?.stop !== undefined ? { stop: [...request.generation.stop] } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.topP !== undefined ? { top_p: options.topP } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.thinking === true ? { thinking: { type: "enabled" } } : {}),
    ...(options.reasoningEffort !== undefined ? { reasoning_effort: options.reasoningEffort } : {}),
    ...(options.promptCacheKey !== undefined ? { prompt_cache_key: options.promptCacheKey } : {}),
  }
  return { path: OPENAI_CHAT_PATH, body }
}

interface WireToolCallFragment {
  readonly index?: number
  readonly id?: string
  readonly function?: { readonly name?: string; readonly arguments?: string }
}

interface WireDelta {
  readonly content?: string | null
  readonly reasoning_content?: string | null
  readonly reasoning?: string | null
  readonly tool_calls?: ReadonlyArray<WireToolCallFragment>
}

interface WireChunk {
  readonly choices?: ReadonlyArray<{
    readonly delta?: WireDelta
    readonly finish_reason?: string | null
  }>
  readonly usage?: {
    readonly prompt_tokens?: number
    readonly completion_tokens?: number
  } | null
  readonly error?: { readonly message?: string; readonly code?: string | number | null } | null
}

const lowerFinishReason = (reason: string): FinishReason => {
  switch (reason) {
    case "stop":
      return "stop"
    case "length":
      return "length"
    case "tool_calls":
      return "tool-call"
    case "content_filter":
      return "content-filter"
    default:
      return "unknown"
  }
}

interface DecodeState {
  readonly assembler: ToolInputAssembler
  readonly toolIdsByIndex: Map<number, ToolCallId>
  textId: ContentId | undefined
  reasoningId: ContentId | undefined
  textCount: number
  reasoningCount: number
  finishReason: FinishReason | undefined
  usage: Usage | undefined
}

const makeState = (): DecodeState => ({
  assembler: ToolInput.makeAssembler(),
  toolIdsByIndex: new Map(),
  textId: undefined,
  reasoningId: undefined,
  textCount: 0,
  reasoningCount: 0,
  finishReason: undefined,
  usage: undefined,
})

const closeText = (state: DecodeState, events: Array<LLMEvent>): void => {
  if (state.textId !== undefined) {
    events.push({ type: "text-end", contentId: state.textId })
    state.textId = undefined
  }
}

const closeReasoning = (state: DecodeState, events: Array<LLMEvent>): void => {
  if (state.reasoningId !== undefined) {
    events.push({ type: "reasoning-end", contentId: state.reasoningId })
    state.reasoningId = undefined
  }
}

const handleChunk = (state: DecodeState, raw: unknown): Effect.Effect<Array<LLMEvent>, LLMError> =>
  Effect.suspend(() => {
    const chunk = raw as WireChunk
    if (chunk.error != null) {
      return Effect.fail(
        new LLMError({
          reason: "server-error",
          message: chunk.error.message ?? "provider stream error",
          retryable: false,
        }),
      )
    }
    const events: Array<LLMEvent> = []
    if (chunk.usage != null) {
      state.usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
      }
    }
    const choice = chunk.choices?.[0]
    const delta = choice?.delta
    if (delta !== undefined) {
      const reasoningText = delta.reasoning_content ?? delta.reasoning
      if (typeof reasoningText === "string" && reasoningText !== "") {
        closeText(state, events)
        if (state.reasoningId === undefined) {
          state.reasoningCount += 1
          state.reasoningId = ContentId.make(`reasoning-${state.reasoningCount}`)
          events.push({ type: "reasoning-start", contentId: state.reasoningId })
        }
        events.push({ type: "reasoning-delta", contentId: state.reasoningId, text: reasoningText })
      }
      if (typeof delta.content === "string" && delta.content !== "") {
        closeReasoning(state, events)
        if (state.textId === undefined) {
          state.textCount += 1
          state.textId = ContentId.make(`text-${state.textCount}`)
          events.push({ type: "text-start", contentId: state.textId })
        }
        events.push({ type: "text-delta", contentId: state.textId, text: delta.content })
      }
      if (delta.tool_calls !== undefined) {
        closeText(state, events)
        closeReasoning(state, events)
        for (const fragment of delta.tool_calls) {
          const index = fragment.index ?? 0
          let toolCallId = state.toolIdsByIndex.get(index)
          if (toolCallId === undefined) {
            toolCallId = ToolCallId.make(fragment.id ?? `call-${index}`)
            state.toolIdsByIndex.set(index, toolCallId)
            events.push(state.assembler.start(toolCallId, fragment.function?.name ?? ""))
          }
          const args = fragment.function?.arguments
          if (typeof args === "string" && args !== "") {
            events.push(state.assembler.append(toolCallId, args))
          }
        }
      }
    }
    if (choice?.finish_reason != null) {
      state.finishReason = lowerFinishReason(choice.finish_reason)
    }
    return Effect.succeed(events)
  })

const flush = (state: DecodeState): Effect.Effect<Array<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const events: Array<LLMEvent> = []
    closeText(state, events)
    closeReasoning(state, events)
    const toolEvents = yield* state.assembler.finishAll()
    events.push(...toolEvents)
    events.push({
      type: "finish",
      reason: state.finishReason ?? "unknown",
      ...(state.usage !== undefined ? { usage: state.usage } : {}),
    })
    return events
  })

/**
 * Decodes streamed `ChatCompletionChunk` JSON values into provider-neutral
 * events. Emits exactly one final `finish`; a stream that ends without a
 * usable finish reason finishes with reason `unknown`.
 */
const decode = <R>(
  chunks: Stream.Stream<unknown, LLMError, R>,
): Stream.Stream<LLMEvent, LLMError, R> =>
  Stream.suspend(() => {
    const state = makeState()
    return chunks.pipe(
      Stream.mapEffect((chunk) => handleChunk(state, chunk)),
      Stream.flattenIterables,
      Stream.concat(
        Stream.unwrap(Effect.suspend(() => flush(state)).pipe(Effect.map(Stream.fromIterable))),
      ),
    )
  })

export const OpenAIChat = {
  path: OPENAI_CHAT_PATH,
  prepare,
  decode,
}
