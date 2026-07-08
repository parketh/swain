import { Effect, Stream } from "effect"
import type {
  AssistantContent,
  FinishReason,
  GenerationOptions,
  LLMErrorReason,
  LLMEvent,
  Message,
  ProviderOptions,
  SystemContent,
  Tool,
  ToolChoice,
  ToolResultContent,
  UserMessage,
} from "../schema"
import { ContentId, LLMError, ToolCallId } from "../schema"
import type { ToolInputAssembler } from "./tool-input"
import { ToolInput } from "./tool-input"

export const ANTHROPIC_MESSAGES_PATH = "/messages"
export const ANTHROPIC_VERSION = "2023-06-01"

const DEFAULT_MAX_TOKENS = 4096

export interface AnthropicMessagesRequest {
  readonly modelId: string
  readonly system?: SystemContent
  readonly messages: ReadonlyArray<Message>
  readonly tools?: ReadonlyArray<Tool>
  readonly toolChoice?: ToolChoice
  readonly generation?: GenerationOptions
  readonly providerOptions?: ProviderOptions
}

export interface AnthropicMessagesConfig {
  /** Anthropic requires `max_tokens`; used when the request carries none. Defaults to 4096. */
  readonly defaultMaxTokens?: number
}

/**
 * Anthropic-specific request options read from `providerOptions.anthropic`.
 * Sampling support varies by model; current Claude models reject `temperature`
 * combined with `topP`.
 */
export interface AnthropicOptions {
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  /**
   * Enable prompt caching via `cache_control: { type: "ephemeral" }` breakpoints
   * on the tools, system prompt, and the final message. Defaults to `true`;
   * Anthropic ignores breakpoints below the minimum cacheable size, so this is
   * safe to leave on. Set `false` to opt out.
   */
  readonly caching?: boolean
}

const EPHEMERAL = { type: "ephemeral" } as const

const withCacheControl = (block: Record<string, unknown>): Record<string, unknown> => ({
  ...block,
  cache_control: EPHEMERAL,
})

/** Adds a cache breakpoint on the last content block of the last message. */
const markLastMessage = (
  messages: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> => {
  if (messages.length === 0) return [...messages]
  const last = messages[messages.length - 1]
  const content = last?.content
  if (last === undefined || !Array.isArray(content) || content.length === 0) return [...messages]
  const cachedContent = [
    ...content.slice(0, -1),
    withCacheControl(content[content.length - 1] as Record<string, unknown>),
  ]
  return [...messages.slice(0, -1), { ...last, content: cachedContent }]
}

export interface PreparedAnthropicRequest {
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown>
}

const invalidRequest = (message: string): LLMError =>
  new LLMError({ reason: "invalid-request", message, retryable: false })

const lowerToolChoice = (choice: ToolChoice): Record<string, unknown> => {
  switch (choice) {
    case "auto":
      return { type: "auto" }
    case "none":
      return { type: "none" }
    case "required":
      return { type: "any" }
    default:
      return { type: "tool", name: choice.name }
  }
}

const lowerToolResult = (block: ToolResultContent): Record<string, unknown> => ({
  type: "tool_result",
  tool_use_id: block.toolCallId,
  content: block.result.type === "text" ? block.result.value : JSON.stringify(block.result.value),
  ...(block.isError !== undefined ? { is_error: block.isError } : {}),
})

const lowerUserMessage = (message: UserMessage): Record<string, unknown> => {
  // Anthropic requires tool_result blocks before other content in a user message.
  const toolResults: Array<Record<string, unknown>> = []
  const texts: Array<Record<string, unknown>> = []
  for (const block of message.content) {
    if (block.type === "tool-result") {
      toolResults.push(lowerToolResult(block))
    } else {
      texts.push({ type: "text", text: block.text })
    }
  }
  return { role: "user", content: [...toolResults, ...texts] }
}

const lowerAssistantContent = (
  content: ReadonlyArray<AssistantContent>,
): Array<Record<string, unknown>> => {
  const blocks: Array<Record<string, unknown>> = []
  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text })
    } else if (block.type === "tool-call") {
      blocks.push({
        type: "tool_use",
        id: block.toolCallId,
        name: block.name,
        input: block.input,
      })
    }
    // Reasoning blocks have no replayable Anthropic wire form; they stay local.
  }
  return blocks
}

const lowerMessages = (
  messages: ReadonlyArray<Message>,
): Effect.Effect<Array<Record<string, unknown>>, LLMError> =>
  Effect.suspend(() => {
    if (messages.length === 0) {
      return Effect.fail(invalidRequest("Anthropic requires at least one message"))
    }
    if (messages[0]?.role !== "user") {
      return Effect.fail(
        invalidRequest("Anthropic requires the first message to be a user message"),
      )
    }
    const wire: Array<Record<string, unknown>> = []
    for (const message of messages) {
      if (message.content.length === 0) {
        return Effect.fail(invalidRequest("Anthropic rejects messages with empty content"))
      }
      if (message.role === "user") {
        wire.push(lowerUserMessage(message))
      } else {
        const content = lowerAssistantContent(message.content)
        if (content.length === 0) {
          return Effect.fail(
            invalidRequest(
              "Anthropic rejects assistant messages with no wire-representable content",
            ),
          )
        }
        wire.push({ role: "assistant", content })
      }
    }
    return Effect.succeed(wire)
  })

const lowerTool = (tool: Tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.inputSchema,
})

/**
 * Builds the Anthropic Messages request for one streamed turn. Sequencing
 * constraints Anthropic would reject are failed locally with reason
 * `invalid-request` instead of being sent.
 */
const prepare = (
  request: AnthropicMessagesRequest,
  config: AnthropicMessagesConfig = {},
): Effect.Effect<PreparedAnthropicRequest, LLMError> => {
  const options = (request.providerOptions?.anthropic ?? {}) as AnthropicOptions
  const caching = options.caching !== false
  return lowerMessages(request.messages).pipe(
    Effect.map((lowered) => {
      const messages = caching ? markLastMessage(lowered) : lowered
      const baseTools =
        request.tools !== undefined && request.tools.length > 0
          ? request.tools.map(lowerTool)
          : undefined
      // A breakpoint on the last tool caches the whole tool block; the system
      // block and final message add two more, staying within Anthropic's limit.
      const tools =
        caching && baseTools !== undefined
          ? [...baseTools.slice(0, -1), withCacheControl(baseTools[baseTools.length - 1]!)]
          : baseTools
      const system =
        request.system === undefined
          ? undefined
          : caching
            ? [withCacheControl({ type: "text", text: request.system.text })]
            : request.system.text
      return {
        path: ANTHROPIC_MESSAGES_PATH,
        headers: {
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: {
          model: request.modelId,
          messages,
          stream: true,
          max_tokens:
            request.generation?.maxTokens ?? config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
          ...(system !== undefined ? { system } : {}),
          ...(tools !== undefined ? { tools } : {}),
          ...(request.toolChoice !== undefined
            ? { tool_choice: lowerToolChoice(request.toolChoice) }
            : {}),
          ...(request.generation?.stop !== undefined
            ? { stop_sequences: [...request.generation.stop] }
            : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.topP !== undefined ? { top_p: options.topP } : {}),
          ...(options.topK !== undefined ? { top_k: options.topK } : {}),
        },
      }
    }),
  )
}

interface WireChunk {
  readonly type?: string
  readonly index?: number
  readonly message?: {
    readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number }
  }
  readonly content_block?: {
    readonly type?: string
    readonly id?: string
    readonly name?: string
  }
  readonly delta?: {
    readonly type?: string
    readonly text?: string
    readonly thinking?: string
    readonly partial_json?: string
    readonly stop_reason?: string | null
  }
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number }
  readonly error?: { readonly type?: string; readonly message?: string }
}

const lowerStopReason = (reason: string): FinishReason => {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop"
    case "max_tokens":
      return "length"
    case "tool_use":
      return "tool-call"
    case "refusal":
      return "refusal"
    default:
      return "unknown"
  }
}

const FATAL_ERROR_REASONS: Record<string, { reason: LLMErrorReason; retryable: boolean }> = {
  overloaded_error: { reason: "overloaded", retryable: true },
  rate_limit_error: { reason: "rate-limited", retryable: true },
  authentication_error: { reason: "auth-failed", retryable: false },
  permission_error: { reason: "auth-failed", retryable: false },
  invalid_request_error: { reason: "invalid-request", retryable: false },
  not_found_error: { reason: "invalid-request", retryable: false },
  api_error: { reason: "server-error", retryable: true },
}

type Block =
  | { readonly kind: "text"; readonly contentId: ContentId }
  | { readonly kind: "reasoning"; readonly contentId: ContentId }
  | { readonly kind: "tool"; readonly toolCallId: ToolCallId }

interface DecodeState {
  readonly assembler: ToolInputAssembler
  readonly blocks: Map<number, Block>
  textCount: number
  reasoningCount: number
  toolCount: number
  finishReason: FinishReason | undefined
  inputTokens: number | undefined
  outputTokens: number | undefined
}

const makeState = (): DecodeState => ({
  assembler: ToolInput.makeAssembler(),
  blocks: new Map(),
  textCount: 0,
  reasoningCount: 0,
  toolCount: 0,
  finishReason: undefined,
  inputTokens: undefined,
  outputTokens: undefined,
})

const startBlock = (state: DecodeState, chunk: WireChunk, events: Array<LLMEvent>): void => {
  const index = chunk.index ?? 0
  const blockType = chunk.content_block?.type
  if (blockType === "text") {
    state.textCount += 1
    const contentId = ContentId.make(`text-${state.textCount}`)
    state.blocks.set(index, { kind: "text", contentId })
    events.push({ type: "text-start", contentId })
  } else if (blockType === "thinking") {
    state.reasoningCount += 1
    const contentId = ContentId.make(`reasoning-${state.reasoningCount}`)
    state.blocks.set(index, { kind: "reasoning", contentId })
    events.push({ type: "reasoning-start", contentId })
  } else if (blockType === "tool_use") {
    state.toolCount += 1
    const toolCallId = ToolCallId.make(chunk.content_block?.id ?? `call-${state.toolCount}`)
    state.blocks.set(index, { kind: "tool", toolCallId })
    events.push(state.assembler.start(toolCallId, chunk.content_block?.name ?? ""))
  }
  // Other block types (e.g. redacted_thinking) have no provider-neutral form.
}

const deltaBlock = (state: DecodeState, chunk: WireChunk, events: Array<LLMEvent>): void => {
  const block = state.blocks.get(chunk.index ?? 0)
  if (block === undefined) {
    return
  }
  const delta = chunk.delta
  if (block.kind === "text" && delta?.type === "text_delta" && typeof delta.text === "string") {
    events.push({ type: "text-delta", contentId: block.contentId, text: delta.text })
  } else if (
    block.kind === "reasoning" &&
    delta?.type === "thinking_delta" &&
    typeof delta.thinking === "string"
  ) {
    events.push({ type: "reasoning-delta", contentId: block.contentId, text: delta.thinking })
  } else if (
    block.kind === "tool" &&
    delta?.type === "input_json_delta" &&
    typeof delta.partial_json === "string" &&
    delta.partial_json !== ""
  ) {
    events.push(state.assembler.append(block.toolCallId, delta.partial_json))
  }
  // signature_delta and unknown delta types stay local.
}

const stopBlock = (
  state: DecodeState,
  chunk: WireChunk,
): Effect.Effect<Array<LLMEvent>, LLMError> =>
  Effect.suspend(() => {
    const index = chunk.index ?? 0
    const block = state.blocks.get(index)
    state.blocks.delete(index)
    if (block === undefined) {
      return Effect.succeed<Array<LLMEvent>>([])
    }
    if (block.kind === "text") {
      return Effect.succeed<Array<LLMEvent>>([{ type: "text-end", contentId: block.contentId }])
    }
    if (block.kind === "reasoning") {
      return Effect.succeed<Array<LLMEvent>>([
        { type: "reasoning-end", contentId: block.contentId },
      ])
    }
    // Anthropic streams blocks sequentially, so exactly this tool call is open.
    return state.assembler.finishAll()
  })

const handleError = (chunk: WireChunk): Effect.Effect<Array<LLMEvent>, LLMError> => {
  const errorType = chunk.error?.type ?? "unknown_error"
  const message = chunk.error?.message ?? "provider stream error"
  const fatal = FATAL_ERROR_REASONS[errorType]
  if (fatal !== undefined) {
    return Effect.fail(new LLMError({ reason: fatal.reason, message, retryable: fatal.retryable }))
  }
  // Only errors known to be terminal fail the turn; unrecognized facts stay
  // in-band so a stream that still finishes can succeed.
  return Effect.succeed<Array<LLMEvent>>([
    { type: "provider-error", message, code: errorType, recoverable: true },
  ])
}

const handleChunk = (state: DecodeState, raw: unknown): Effect.Effect<Array<LLMEvent>, LLMError> =>
  Effect.suspend(() => {
    const chunk = raw as WireChunk
    switch (chunk.type) {
      case "message_start": {
        const usage = chunk.message?.usage
        if (usage?.input_tokens !== undefined) {
          state.inputTokens = usage.input_tokens
        }
        if (usage?.output_tokens !== undefined) {
          state.outputTokens = usage.output_tokens
        }
        return Effect.succeed<Array<LLMEvent>>([])
      }
      case "content_block_start": {
        const events: Array<LLMEvent> = []
        startBlock(state, chunk, events)
        return Effect.succeed(events)
      }
      case "content_block_delta": {
        const events: Array<LLMEvent> = []
        deltaBlock(state, chunk, events)
        return Effect.succeed(events)
      }
      case "content_block_stop":
        return stopBlock(state, chunk)
      case "message_delta": {
        if (chunk.delta?.stop_reason != null) {
          state.finishReason = lowerStopReason(chunk.delta.stop_reason)
        }
        if (chunk.usage?.output_tokens !== undefined) {
          state.outputTokens = chunk.usage.output_tokens
        }
        if (chunk.usage?.input_tokens !== undefined) {
          state.inputTokens = chunk.usage.input_tokens
        }
        return Effect.succeed<Array<LLMEvent>>([])
      }
      case "error":
        return handleError(chunk)
      default:
        // message_stop, ping, and unknown event types carry no event payload.
        return Effect.succeed<Array<LLMEvent>>([])
    }
  })

const flush = (state: DecodeState): Effect.Effect<Array<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const events: Array<LLMEvent> = []
    for (const block of state.blocks.values()) {
      if (block.kind === "text") {
        events.push({ type: "text-end", contentId: block.contentId })
      } else if (block.kind === "reasoning") {
        events.push({ type: "reasoning-end", contentId: block.contentId })
      }
    }
    state.blocks.clear()
    const toolEvents = yield* state.assembler.finishAll()
    events.push(...toolEvents)
    const usage =
      state.inputTokens !== undefined || state.outputTokens !== undefined
        ? { inputTokens: state.inputTokens ?? 0, outputTokens: state.outputTokens ?? 0 }
        : undefined
    events.push({
      type: "finish",
      reason: state.finishReason ?? "unknown",
      ...(usage !== undefined ? { usage } : {}),
    })
    return events
  })

/**
 * Decodes Anthropic Messages SSE payloads into provider-neutral events.
 * Emits exactly one final `finish`; a stream that ends without a usable stop
 * reason finishes with reason `unknown`.
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

export const AnthropicMessages = {
  path: ANTHROPIC_MESSAGES_PATH,
  version: ANTHROPIC_VERSION,
  prepare,
  decode,
}
