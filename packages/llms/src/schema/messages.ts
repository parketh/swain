import { Schema } from "effect"
import { ToolCallId } from "./ids"

const SystemContentSchema = Schema.Struct({
  text: Schema.String,
})

export const SystemContent = Object.assign(SystemContentSchema, {
  text: (text: string): SystemContent => SystemContentSchema.make({ text }),
})
export type SystemContent = typeof SystemContentSchema.Type

export const TextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
})
export type TextContent = typeof TextContent.Type

export const ReasoningContent = Schema.Struct({
  type: Schema.Literal("reasoning"),
  text: Schema.String,
})
export type ReasoningContent = typeof ReasoningContent.Type

export const ToolCallContent = Schema.Struct({
  type: Schema.Literal("tool-call"),
  toolCallId: ToolCallId,
  name: Schema.String,
  input: Schema.Unknown,
})
export type ToolCallContent = typeof ToolCallContent.Type

export const ToolResultValue = Schema.Union(
  Schema.Struct({ type: Schema.Literal("text"), value: Schema.String }),
  Schema.Struct({ type: Schema.Literal("json"), value: Schema.Unknown }),
)
export type ToolResultValue = typeof ToolResultValue.Type

export const ToolResultContent = Schema.Struct({
  type: Schema.Literal("tool-result"),
  toolCallId: ToolCallId,
  name: Schema.optional(Schema.String),
  result: ToolResultValue,
  isError: Schema.optional(Schema.Boolean),
  /** Local-only tool execution latency in milliseconds. Present only for tools
   * whose core definition opts into timing; never sent to a provider. */
  durationMs: Schema.optional(Schema.Number),
})
export type ToolResultContent = typeof ToolResultContent.Type

const ModelSwitchRef = Schema.Struct({
  provider: Schema.String,
  modelId: Schema.String,
  variant: Schema.optional(Schema.String),
})

/**
 * A meta transcript event recording a model switch mid-conversation. Persisted
 * as an `isMeta` user message so consumers can render it as a distinct switch
 * row rather than genuine user input.
 */
export const ModelSwitchContent = Schema.Struct({
  type: Schema.Literal("model-switch"),
  from: ModelSwitchRef,
  to: ModelSwitchRef,
  reason: Schema.String,
  requestedBy: Schema.Literal("router", "user"),
})
export type ModelSwitchContent = typeof ModelSwitchContent.Type

/**
 * A model-visible compaction boundary. Persisted as an `isMeta` user message
 * marking where earlier transcript was replaced by a single compound summary.
 * Providers render it as concise text; the TUI can render it as a boundary row.
 */
export const CompactionContent = Schema.Struct({
  type: Schema.Literal("compaction"),
  reason: Schema.Literal("auto", "manual", "overflow"),
  compactedMessages: Schema.Number,
  summary: Schema.String,
  /**
   * Absolute index in the full history where the verbatim tail resumes when this
   * marker is applied to derive the model context. Absent on legacy markers
   * written before history was retained — treated as "everything after the
   * marker" so those (top-of-history) markers still project correctly.
   */
  contextTailStart: Schema.optional(Schema.Number),
})
export type CompactionContent = typeof CompactionContent.Type

export const UserContent = Schema.Union(
  TextContent,
  ToolResultContent,
  ModelSwitchContent,
  CompactionContent,
)
export type UserContent = typeof UserContent.Type

const switchRefKey = (ref: ModelSwitchContent["from"]): string =>
  ref.variant !== undefined && ref.variant !== ""
    ? `${ref.provider}:${ref.modelId}:${ref.variant}`
    : `${ref.provider}:${ref.modelId}`

/** One-line text form of a model-switch event, for provider history and logs. */
export const renderModelSwitch = (block: ModelSwitchContent): string =>
  `[Model switched from ${switchRefKey(block.from)} to ${switchRefKey(block.to)} — ${block.reason}]`

/** Provider-visible text form of a compaction boundary: a marker plus the summary. */
export const renderCompaction = (block: CompactionContent): string =>
  `[Conversation compacted: ${block.compactedMessages} earlier messages summarized.]\n<summary>\n${block.summary}\n</summary>`

export const AssistantContent = Schema.Union(TextContent, ReasoningContent, ToolCallContent)
export type AssistantContent = typeof AssistantContent.Type

/**
 * Local-only timing metadata carried on every persisted transcript message.
 * `createdAt` is required (an ISO-8601 UTC commit timestamp); the duration
 * fields are conditionally present depending on runtime placement. None of
 * these are ever lowered into a provider request.
 */
const timingFields = {
  createdAt: Schema.String,
  responseDurationMs: Schema.optional(Schema.Number),
  turnDurationMs: Schema.optional(Schema.Number),
}

export const UserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Array(UserContent),
  /** Harness-injected (e.g. a subagent task notification) rather than user-typed.
   * Model-visible, but consumers must not treat it as genuine user input. */
  isMeta: Schema.optional(Schema.Boolean),
  ...timingFields,
})
export type UserMessage = typeof UserMessage.Type

export const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(AssistantContent),
  ...timingFields,
})
export type AssistantMessage = typeof AssistantMessage.Type

const text = (value: string): TextContent => TextContent.make({ type: "text", text: value })

const MessageSchema = Schema.Union(UserMessage, AssistantMessage)

/** Optional local timing passed through to the persisted message. `createdAt`
 * defaults to current UTC at the constructor boundary so in-memory call sites
 * (facades, provider-lowering tests) still produce a stamped message. */
export interface MessageTiming {
  readonly createdAt?: string
  readonly responseDurationMs?: number
  readonly turnDurationMs?: number
}

const withTiming = (timing: MessageTiming) => ({
  createdAt: timing.createdAt ?? new Date().toISOString(),
  ...(timing.responseDurationMs !== undefined && { responseDurationMs: timing.responseDurationMs }),
  ...(timing.turnDurationMs !== undefined && { turnDurationMs: timing.turnDurationMs }),
})

export const Message = Object.assign(MessageSchema, {
  user: (
    input: string | ReadonlyArray<UserContent>,
    isMeta = false,
    timing: MessageTiming = {},
  ): UserMessage =>
    UserMessage.make({
      role: "user",
      content: typeof input === "string" ? [text(input)] : input,
      ...(isMeta && { isMeta: true }),
      ...withTiming(timing),
    }),
  assistant: (
    input: string | ReadonlyArray<AssistantContent>,
    timing: MessageTiming = {},
  ): AssistantMessage =>
    AssistantMessage.make({
      role: "assistant",
      content: typeof input === "string" ? [text(input)] : input,
      ...withTiming(timing),
    }),
})
export type Message = typeof MessageSchema.Type

export const JsonSchemaObject = Schema.Record({ key: Schema.String, value: Schema.Unknown })
export type JsonSchemaObject = typeof JsonSchemaObject.Type

const ToolSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  inputSchema: JsonSchemaObject,
  outputSchema: Schema.optional(JsonSchemaObject),
})

export const Tool = Object.assign(ToolSchema, {
  define: (input: {
    readonly name: string
    readonly description: string
    readonly inputSchema: JsonSchemaObject
    readonly outputSchema?: JsonSchemaObject
  }): Tool =>
    ToolSchema.make({
      name: input.name,
      description: input.description,
      inputSchema: input.inputSchema,
      ...(input.outputSchema !== undefined && { outputSchema: input.outputSchema }),
    }),
})
export type Tool = typeof ToolSchema.Type

export const NamedToolChoice = Schema.Struct({
  type: Schema.Literal("tool"),
  name: Schema.String,
})
export type NamedToolChoice = typeof NamedToolChoice.Type

const ToolChoiceSchema = Schema.Union(
  Schema.Literal("auto"),
  Schema.Literal("none"),
  Schema.Literal("required"),
  NamedToolChoice,
)

export const ToolChoice = Object.assign(ToolChoiceSchema, {
  auto: "auto" as const,
  none: "none" as const,
  required: "required" as const,
  tool: (name: string): NamedToolChoice => NamedToolChoice.make({ type: "tool", name }),
})
export type ToolChoice = typeof ToolChoiceSchema.Type
