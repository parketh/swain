import { Effect, Schema } from "effect"
import { LLMError } from "./errors"
import { ContentId, ToolCallId } from "./ids"
import type { AssistantContent } from "./messages"
import { ReasoningContent, TextContent, ToolCallContent } from "./messages"

export const Usage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  /**
   * Provider-reported active context pressure for the turn: the total tokens
   * the provider counted against the context window (input + output + any cache
   * read/creation). Providers translate their native usage fields into this;
   * core treats a missing value as `inputTokens + outputTokens`.
   */
  activeContextTokens: Schema.optional(Schema.Number),
})
export type Usage = typeof Usage.Type

export const FinishReason = Schema.Literal(
  "stop",
  "length",
  "tool-call",
  "content-filter",
  "refusal",
  "unknown",
)
export type FinishReason = typeof FinishReason.Type

export const TextStart = Schema.Struct({
  type: Schema.Literal("text-start"),
  contentId: ContentId,
})
export type TextStart = typeof TextStart.Type

export const TextDelta = Schema.Struct({
  type: Schema.Literal("text-delta"),
  contentId: ContentId,
  text: Schema.String,
})
export type TextDelta = typeof TextDelta.Type

export const TextEnd = Schema.Struct({
  type: Schema.Literal("text-end"),
  contentId: ContentId,
})
export type TextEnd = typeof TextEnd.Type

export const ReasoningStart = Schema.Struct({
  type: Schema.Literal("reasoning-start"),
  contentId: ContentId,
})
export type ReasoningStart = typeof ReasoningStart.Type

export const ReasoningDelta = Schema.Struct({
  type: Schema.Literal("reasoning-delta"),
  contentId: ContentId,
  text: Schema.String,
})
export type ReasoningDelta = typeof ReasoningDelta.Type

export const ReasoningEnd = Schema.Struct({
  type: Schema.Literal("reasoning-end"),
  contentId: ContentId,
})
export type ReasoningEnd = typeof ReasoningEnd.Type

export const ToolInputStart = Schema.Struct({
  type: Schema.Literal("tool-input-start"),
  toolCallId: ToolCallId,
  name: Schema.String,
})
export type ToolInputStart = typeof ToolInputStart.Type

export const ToolInputDelta = Schema.Struct({
  type: Schema.Literal("tool-input-delta"),
  toolCallId: ToolCallId,
  text: Schema.String,
})
export type ToolInputDelta = typeof ToolInputDelta.Type

export const ToolInputEnd = Schema.Struct({
  type: Schema.Literal("tool-input-end"),
  toolCallId: ToolCallId,
  name: Schema.String,
})
export type ToolInputEnd = typeof ToolInputEnd.Type

export const ToolCall = Schema.Struct({
  type: Schema.Literal("tool-call"),
  toolCallId: ToolCallId,
  name: Schema.String,
  input: Schema.Unknown,
})
export type ToolCall = typeof ToolCall.Type

export const ProviderError = Schema.Struct({
  type: Schema.Literal("provider-error"),
  message: Schema.String,
  code: Schema.optional(Schema.String),
  recoverable: Schema.optional(Schema.Boolean),
})
export type ProviderError = typeof ProviderError.Type

export const Finish = Schema.Struct({
  type: Schema.Literal("finish"),
  reason: FinishReason,
  usage: Schema.optional(Usage),
})
export type Finish = typeof Finish.Type

const LLMEventSchema = Schema.Union(
  TextStart,
  TextDelta,
  TextEnd,
  ReasoningStart,
  ReasoningDelta,
  ReasoningEnd,
  ToolInputStart,
  ToolInputDelta,
  ToolInputEnd,
  ToolCall,
  ProviderError,
  Finish,
)
export type LLMEvent = typeof LLMEventSchema.Type

export const LLMEvent = Object.assign(LLMEventSchema, {
  is: {
    textStart: (event: LLMEvent): event is TextStart => event.type === "text-start",
    textDelta: (event: LLMEvent): event is TextDelta => event.type === "text-delta",
    textEnd: (event: LLMEvent): event is TextEnd => event.type === "text-end",
    reasoningStart: (event: LLMEvent): event is ReasoningStart => event.type === "reasoning-start",
    reasoningDelta: (event: LLMEvent): event is ReasoningDelta => event.type === "reasoning-delta",
    reasoningEnd: (event: LLMEvent): event is ReasoningEnd => event.type === "reasoning-end",
    toolInputStart: (event: LLMEvent): event is ToolInputStart => event.type === "tool-input-start",
    toolInputDelta: (event: LLMEvent): event is ToolInputDelta => event.type === "tool-input-delta",
    toolInputEnd: (event: LLMEvent): event is ToolInputEnd => event.type === "tool-input-end",
    toolCall: (event: LLMEvent): event is ToolCall => event.type === "tool-call",
    providerError: (event: LLMEvent): event is ProviderError => event.type === "provider-error",
    finish: (event: LLMEvent): event is Finish => event.type === "finish",
  },
})

export interface LLMTurnSummary {
  readonly finish: Finish
  readonly usage?: Usage
  readonly text: string
  readonly reasoning: string
  readonly toolCalls: ReadonlyArray<ToolCall>
  readonly assistantContent: ReadonlyArray<AssistantContent>
  readonly providerErrors: ReadonlyArray<ProviderError>
}

const invalid = (message: string, eventsSoFar: ReadonlyArray<LLMEvent>) =>
  new LLMError({
    reason: "invalid-provider-output",
    message,
    retryable: false,
    eventsSoFar,
  })

const fromEvents = (events: ReadonlyArray<LLMEvent>): Effect.Effect<LLMTurnSummary, LLMError> =>
  Effect.suspend(() => {
    const textStarted = new Set<string>()
    const reasoningStarted = new Set<string>()
    const toolStarted = new Set<string>()
    const toolEnded = new Set<string>()

    const textBuffers = new Map<string, string>()
    const reasoningBuffers = new Map<string, string>()
    const contentOrder: Array<
      | { kind: "text"; contentId: ContentId }
      | { kind: "reasoning"; contentId: ContentId }
      | { kind: "tool"; toolCallId: ToolCallId }
    > = []
    const toolCalls = new Map<string, ToolCall>()
    const providerErrors: Array<ProviderError> = []

    let finish: Finish | undefined
    let text = ""
    let reasoning = ""

    for (const [index, event] of events.entries()) {
      if (finish !== undefined) {
        return Effect.fail(invalid("finish must be the final event", events.slice(0, index)))
      }
      switch (event.type) {
        case "text-start":
          textStarted.add(event.contentId)
          textBuffers.set(event.contentId, "")
          contentOrder.push({ kind: "text", contentId: event.contentId })
          break
        case "text-delta":
          if (!textStarted.has(event.contentId)) {
            return Effect.fail(invalid("text-delta before text-start", events.slice(0, index)))
          }
          text += event.text
          textBuffers.set(event.contentId, (textBuffers.get(event.contentId) ?? "") + event.text)
          break
        case "text-end":
          if (!textStarted.has(event.contentId)) {
            return Effect.fail(invalid("text-end before text-start", events.slice(0, index)))
          }
          break
        case "reasoning-start":
          reasoningStarted.add(event.contentId)
          reasoningBuffers.set(event.contentId, "")
          contentOrder.push({ kind: "reasoning", contentId: event.contentId })
          break
        case "reasoning-delta":
          if (!reasoningStarted.has(event.contentId)) {
            return Effect.fail(
              invalid("reasoning-delta before reasoning-start", events.slice(0, index)),
            )
          }
          reasoning += event.text
          reasoningBuffers.set(
            event.contentId,
            (reasoningBuffers.get(event.contentId) ?? "") + event.text,
          )
          break
        case "reasoning-end":
          if (!reasoningStarted.has(event.contentId)) {
            return Effect.fail(
              invalid("reasoning-end before reasoning-start", events.slice(0, index)),
            )
          }
          break
        case "tool-input-start":
          toolStarted.add(event.toolCallId)
          contentOrder.push({ kind: "tool", toolCallId: event.toolCallId })
          break
        case "tool-input-delta":
          if (!toolStarted.has(event.toolCallId)) {
            return Effect.fail(
              invalid("tool-input-delta before tool-input-start", events.slice(0, index)),
            )
          }
          break
        case "tool-input-end":
          if (!toolStarted.has(event.toolCallId)) {
            return Effect.fail(
              invalid("tool-input-end before tool-input-start", events.slice(0, index)),
            )
          }
          toolEnded.add(event.toolCallId)
          break
        case "tool-call":
          if (!toolEnded.has(event.toolCallId)) {
            return Effect.fail(invalid("tool-call before tool-input-end", events.slice(0, index)))
          }
          toolCalls.set(event.toolCallId, event)
          break
        case "provider-error":
          providerErrors.push(event)
          break
        case "finish":
          finish = event
          break
      }
    }

    if (finish === undefined) {
      return Effect.fail(invalid("missing finish event", events))
    }

    const assistantContent: Array<AssistantContent> = []
    for (const entry of contentOrder) {
      switch (entry.kind) {
        case "text":
          assistantContent.push(
            TextContent.make({ type: "text", text: textBuffers.get(entry.contentId) ?? "" }),
          )
          break
        case "reasoning":
          assistantContent.push(
            ReasoningContent.make({
              type: "reasoning",
              text: reasoningBuffers.get(entry.contentId) ?? "",
            }),
          )
          break
        case "tool": {
          const call = toolCalls.get(entry.toolCallId)
          if (call !== undefined) {
            assistantContent.push(
              ToolCallContent.make({
                type: "tool-call",
                toolCallId: call.toolCallId,
                name: call.name,
                input: call.input,
              }),
            )
          }
          break
        }
      }
    }

    return Effect.succeed({
      finish,
      ...(finish.usage !== undefined ? { usage: finish.usage } : {}),
      text,
      reasoning,
      toolCalls: Array.from(toolCalls.values()),
      assistantContent,
      providerErrors,
    })
  })

export const LLMTurnSummary = { fromEvents }
