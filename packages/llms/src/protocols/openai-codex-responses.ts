import { Effect, Stream } from "effect"
import type {
  AssistantContent,
  FinishReason,
  GenerationOptions,
  LLMEvent,
  Message,
  ProviderOptions,
  SystemContent,
  Tool,
  ToolChoice,
  ToolResultContent,
  Usage,
  UserMessage,
} from "../schema"
import { ContentId, LLMError, ToolCallId } from "../schema"
import type { ToolInputAssembler } from "./tool-input"
import { ToolInput } from "./tool-input"

export const OPENAI_CODEX_RESPONSES_PATH = "/codex/responses"
export const OPENAI_CODEX_BETA_HEADER = "responses=experimental"

const DEFAULT_ORIGINATOR = "codex"

/** Responses-specific request options read from `providerOptions.openaiCodex`. */
export interface OpenAICodexOptions {
  readonly reasoning?: {
    readonly effort?: "minimal" | "low" | "medium" | "high"
    readonly summary?: "auto" | "concise" | "detailed"
  }
}

export interface OpenAICodexRequest {
  readonly modelId: string
  readonly system?: SystemContent
  readonly messages: ReadonlyArray<Message>
  readonly tools?: ReadonlyArray<Tool>
  readonly toolChoice?: ToolChoice
  readonly generation?: GenerationOptions
  readonly providerOptions?: ProviderOptions
}

export interface OpenAICodexConfig {
  readonly accessToken: string
  readonly accountId: string
  readonly originator?: string
}

export interface PreparedCodexRequest {
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown>
}

/**
 * Tool call IDs preserve both the provider `call_id` and the response item id
 * with a reversible `<call_id>|<item_id>` encoding; the public field stays
 * `toolCallId`.
 */
const encodeToolCallId = (callId: string, itemId: string | undefined): ToolCallId =>
  ToolCallId.make(itemId === undefined || itemId === "" ? callId : `${callId}|${itemId}`)

const splitToolCallId = (toolCallId: string): { callId: string; itemId?: string } => {
  const separator = toolCallId.indexOf("|")
  if (separator === -1) {
    return { callId: toolCallId }
  }
  return { callId: toolCallId.slice(0, separator), itemId: toolCallId.slice(separator + 1) }
}

const lowerToolResult = (block: ToolResultContent): Record<string, unknown> => ({
  type: "function_call_output",
  call_id: splitToolCallId(block.toolCallId).callId,
  output: block.result.type === "text" ? block.result.value : JSON.stringify(block.result.value),
})

const lowerUserMessage = (message: UserMessage): Array<Record<string, unknown>> => {
  const items: Array<Record<string, unknown>> = []
  const texts: Array<Record<string, unknown>> = []
  for (const block of message.content) {
    if (block.type === "tool-result") {
      items.push(lowerToolResult(block))
    } else {
      texts.push({ type: "input_text", text: block.text })
    }
  }
  if (texts.length > 0) {
    items.push({ type: "message", role: "user", content: texts })
  }
  return items
}

const lowerAssistantMessage = (
  content: ReadonlyArray<AssistantContent>,
): Array<Record<string, unknown>> => {
  const items: Array<Record<string, unknown>> = []
  const texts: Array<Record<string, unknown>> = []
  for (const block of content) {
    if (block.type === "text") {
      texts.push({ type: "output_text", text: block.text })
    } else if (block.type === "tool-call") {
      const { callId, itemId } = splitToolCallId(block.toolCallId)
      items.push({
        type: "function_call",
        call_id: callId,
        ...(itemId !== undefined ? { id: itemId } : {}),
        name: block.name,
        arguments: JSON.stringify(block.input),
      })
    }
    // Reasoning blocks have no replayable Codex wire form; they stay local.
  }
  if (texts.length > 0) {
    items.unshift({ type: "message", role: "assistant", status: "completed", content: texts })
  }
  return items
}

const lowerMessages = (messages: ReadonlyArray<Message>): Array<Record<string, unknown>> =>
  messages.flatMap((message) =>
    message.role === "user" ? lowerUserMessage(message) : lowerAssistantMessage(message.content),
  )

const lowerTool = (tool: Tool) => ({
  type: "function",
  name: tool.name,
  description: tool.description,
  parameters: tool.inputSchema,
})

const lowerToolChoice = (choice: ToolChoice) =>
  typeof choice === "string" ? choice : { type: "function", name: choice.name }

/**
 * Builds the ChatGPT/Codex subscription Responses request for one streamed
 * turn. The protocol always streams; `stream: true` is not configurable.
 */
const prepare = (request: OpenAICodexRequest, config: OpenAICodexConfig): PreparedCodexRequest => {
  const options = (request.providerOptions?.openaiCodex ?? {}) as OpenAICodexOptions
  return {
    path: OPENAI_CODEX_RESPONSES_PATH,
    headers: {
      authorization: `Bearer ${config.accessToken}`,
      "chatgpt-account-id": config.accountId,
      originator: config.originator ?? DEFAULT_ORIGINATOR,
      "openai-beta": OPENAI_CODEX_BETA_HEADER,
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: {
      model: request.modelId,
      store: false,
      stream: true,
      input: lowerMessages(request.messages),
      text: { verbosity: "low" },
      include: ["reasoning.encrypted_content"],
      parallel_tool_calls: true,
      ...(request.system !== undefined ? { instructions: request.system.text } : {}),
      ...(request.tools !== undefined && request.tools.length > 0
        ? { tools: request.tools.map(lowerTool) }
        : {}),
      ...(request.toolChoice !== undefined
        ? { tool_choice: lowerToolChoice(request.toolChoice) }
        : {}),
      ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
    },
  }
}

interface WireItem {
  readonly type?: string
  readonly id?: string
  readonly call_id?: string
  readonly name?: string
}

interface WireError {
  readonly code?: string | number | null
  readonly message?: string
}

interface WireChunk {
  readonly type?: string
  readonly item_id?: string
  readonly delta?: string
  readonly arguments?: string
  readonly item?: WireItem
  readonly code?: string | number | null
  readonly message?: string
  readonly error?: WireError
  readonly response?: {
    readonly output?: ReadonlyArray<WireItem>
    readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number }
    readonly incomplete_details?: { readonly reason?: string }
    readonly error?: WireError
  }
}

const REASONING_DELTA_TYPES = new Set([
  "response.reasoning.delta",
  "response.reasoning_summary_text.delta",
  "response.reasoning_text.delta",
])

const REASONING_DONE_TYPES = new Set([
  "response.reasoning.done",
  "response.reasoning_summary_text.done",
  "response.reasoning_text.done",
])

/**
 * Terminal billing/quota errors map to non-retryable `rate-limited` and auth
 * errors to `auth-failed` where identifiable; everything else is a fatal
 * `server-error`.
 */
const fatalError = (error: WireError | undefined): LLMError => {
  const message = error?.message ?? "provider stream error"
  const text = `${String(error?.code ?? "")} ${message}`.toLowerCase()
  if (text.includes("quota") || text.includes("billing") || text.includes("usage limit")) {
    return new LLMError({ reason: "rate-limited", message, retryable: false })
  }
  if (text.includes("auth") || text.includes("token") || text.includes("unauthorized")) {
    return new LLMError({ reason: "auth-failed", message, retryable: false })
  }
  return new LLMError({ reason: "server-error", message, retryable: false })
}

interface ToolEntry {
  readonly toolCallId: ToolCallId
  sawDelta: boolean
  finished: boolean
}

interface DecodeState {
  readonly assembler: ToolInputAssembler
  readonly texts: Map<string, ContentId>
  readonly reasonings: Map<string, ContentId>
  readonly tools: Map<string, ToolEntry>
  textCount: number
  reasoningCount: number
  toolCount: number
  finishReason: FinishReason | undefined
  usage: Usage | undefined
}

const makeState = (): DecodeState => ({
  assembler: ToolInput.makeAssembler(),
  texts: new Map(),
  reasonings: new Map(),
  tools: new Map(),
  textCount: 0,
  reasoningCount: 0,
  toolCount: 0,
  finishReason: undefined,
  usage: undefined,
})

const textDelta = (state: DecodeState, chunk: WireChunk, events: Array<LLMEvent>): void => {
  if (typeof chunk.delta !== "string" || chunk.delta === "") {
    return
  }
  const itemId = chunk.item_id ?? "output_text"
  let contentId = state.texts.get(itemId)
  if (contentId === undefined) {
    state.textCount += 1
    contentId = ContentId.make(`text-${state.textCount}`)
    state.texts.set(itemId, contentId)
    events.push({ type: "text-start", contentId })
  }
  events.push({ type: "text-delta", contentId, text: chunk.delta })
}

const reasoningDelta = (state: DecodeState, chunk: WireChunk, events: Array<LLMEvent>): void => {
  if (typeof chunk.delta !== "string" || chunk.delta === "") {
    return
  }
  const itemId = chunk.item_id ?? "reasoning"
  let contentId = state.reasonings.get(itemId)
  if (contentId === undefined) {
    state.reasoningCount += 1
    contentId = ContentId.make(`reasoning-${state.reasoningCount}`)
    state.reasonings.set(itemId, contentId)
    events.push({ type: "reasoning-start", contentId })
  }
  events.push({ type: "reasoning-delta", contentId, text: chunk.delta })
}

const closeText = (state: DecodeState, itemId: string, events: Array<LLMEvent>): void => {
  const contentId = state.texts.get(itemId)
  if (contentId !== undefined) {
    state.texts.delete(itemId)
    events.push({ type: "text-end", contentId })
  }
}

const closeReasoning = (state: DecodeState, itemId: string, events: Array<LLMEvent>): void => {
  const contentId = state.reasonings.get(itemId)
  if (contentId !== undefined) {
    state.reasonings.delete(itemId)
    events.push({ type: "reasoning-end", contentId })
  }
}

const trackFunctionCall = (state: DecodeState, item: WireItem, events: Array<LLMEvent>): void => {
  state.toolCount += 1
  const toolCallId = encodeToolCallId(item.call_id ?? `call-${state.toolCount}`, item.id)
  const key = item.id ?? item.call_id ?? `item-${state.toolCount}`
  state.tools.set(key, { toolCallId, sawDelta: false, finished: false })
  events.push(state.assembler.start(toolCallId, item.name ?? ""))
}

const finishFunctionCall = (
  state: DecodeState,
  entry: ToolEntry,
  finalArguments: string | undefined,
): Effect.Effect<Array<LLMEvent>, LLMError> =>
  Effect.suspend(() => {
    if (entry.finished) {
      return Effect.succeed<Array<LLMEvent>>([])
    }
    entry.finished = true
    if (!entry.sawDelta && typeof finalArguments === "string" && finalArguments !== "") {
      // Arguments arrived only on the done event; record them without
      // emitting a delta the provider never streamed.
      state.assembler.append(entry.toolCallId, finalArguments)
    }
    return state.assembler.finish(entry.toolCallId)
  })

const itemDone = (state: DecodeState, chunk: WireChunk): Effect.Effect<Array<LLMEvent>, LLMError> =>
  Effect.suspend(() => {
    const item = chunk.item
    const itemId = item?.id ?? chunk.item_id ?? ""
    if (item?.type === "function_call") {
      const entry = state.tools.get(itemId)
      if (entry !== undefined) {
        return finishFunctionCall(state, entry, undefined)
      }
      return Effect.succeed<Array<LLMEvent>>([])
    }
    const events: Array<LLMEvent> = []
    closeText(state, itemId, events)
    closeReasoning(state, itemId, events)
    return Effect.succeed(events)
  })

const recordCompletion = (state: DecodeState, chunk: WireChunk, reason: FinishReason): void => {
  state.finishReason = reason
  const usage = chunk.response?.usage
  if (usage !== undefined) {
    state.usage = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    }
  }
}

const completedReason = (chunk: WireChunk): FinishReason =>
  (chunk.response?.output ?? []).some((item) => item.type === "function_call")
    ? "tool-call"
    : "stop"

const incompleteReason = (chunk: WireChunk): FinishReason => {
  switch (chunk.response?.incomplete_details?.reason) {
    case "max_output_tokens":
      return "length"
    case "content_filter":
      return "content-filter"
    default:
      return "unknown"
  }
}

const handleChunk = (state: DecodeState, raw: unknown): Effect.Effect<Array<LLMEvent>, LLMError> =>
  Effect.suspend(() => {
    const chunk = raw as WireChunk
    const type = chunk.type ?? ""
    if (REASONING_DELTA_TYPES.has(type)) {
      const events: Array<LLMEvent> = []
      reasoningDelta(state, chunk, events)
      return Effect.succeed(events)
    }
    if (REASONING_DONE_TYPES.has(type)) {
      const events: Array<LLMEvent> = []
      closeReasoning(state, chunk.item_id ?? "reasoning", events)
      return Effect.succeed(events)
    }
    switch (type) {
      case "response.output_text.delta": {
        const events: Array<LLMEvent> = []
        textDelta(state, chunk, events)
        return Effect.succeed(events)
      }
      case "response.output_text.done": {
        const events: Array<LLMEvent> = []
        closeText(state, chunk.item_id ?? "output_text", events)
        return Effect.succeed(events)
      }
      case "response.output_item.added": {
        const events: Array<LLMEvent> = []
        if (chunk.item?.type === "function_call") {
          trackFunctionCall(state, chunk.item, events)
        }
        return Effect.succeed(events)
      }
      case "response.function_call_arguments.delta": {
        const entry = state.tools.get(chunk.item_id ?? "")
        if (entry === undefined || entry.finished) {
          return Effect.succeed<Array<LLMEvent>>([])
        }
        if (typeof chunk.delta !== "string" || chunk.delta === "") {
          return Effect.succeed<Array<LLMEvent>>([])
        }
        entry.sawDelta = true
        return Effect.succeed<Array<LLMEvent>>([
          state.assembler.append(entry.toolCallId, chunk.delta),
        ])
      }
      case "response.function_call_arguments.done": {
        const entry = state.tools.get(chunk.item_id ?? "")
        if (entry === undefined) {
          return Effect.succeed<Array<LLMEvent>>([])
        }
        return finishFunctionCall(state, entry, chunk.arguments)
      }
      case "response.output_item.done":
        return itemDone(state, chunk)
      case "response.completed":
      case "response.done":
        recordCompletion(state, chunk, completedReason(chunk))
        return Effect.succeed<Array<LLMEvent>>([])
      case "response.incomplete":
        recordCompletion(state, chunk, incompleteReason(chunk))
        return Effect.succeed<Array<LLMEvent>>([])
      case "response.failed":
        return Effect.fail(fatalError(chunk.response?.error ?? chunk.error))
      case "error":
        return Effect.fail(fatalError(chunk.error ?? { code: chunk.code, message: chunk.message }))
      default:
        // response.created, in_progress, content_part events, and unknown
        // types carry no provider-neutral payload.
        return Effect.succeed<Array<LLMEvent>>([])
    }
  })

const flush = (state: DecodeState): Effect.Effect<Array<LLMEvent>, LLMError> =>
  Effect.gen(function* () {
    const events: Array<LLMEvent> = []
    for (const itemId of [...state.texts.keys()]) {
      closeText(state, itemId, events)
    }
    for (const itemId of [...state.reasonings.keys()]) {
      closeReasoning(state, itemId, events)
    }
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
 * Decodes streamed Codex Responses SSE payloads into provider-neutral events.
 * Emits exactly one final `finish`; a stream that ends without a terminal
 * response event finishes with reason `unknown`.
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

export const OpenAICodexResponses = {
  path: OPENAI_CODEX_RESPONSES_PATH,
  prepare,
  decode,
  encodeToolCallId,
  splitToolCallId,
}
