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

export const UserContent = Schema.Union(TextContent, ToolResultContent, ModelSwitchContent)
export type UserContent = typeof UserContent.Type

const switchRefKey = (ref: ModelSwitchContent["from"]): string =>
  ref.variant !== undefined && ref.variant !== ""
    ? `${ref.provider}:${ref.modelId}:${ref.variant}`
    : `${ref.provider}:${ref.modelId}`

/** One-line text form of a model-switch event, for provider history and logs. */
export const renderModelSwitch = (block: ModelSwitchContent): string =>
  `[Model switched from ${switchRefKey(block.from)} to ${switchRefKey(block.to)} — ${block.reason}]`

export const AssistantContent = Schema.Union(TextContent, ReasoningContent, ToolCallContent)
export type AssistantContent = typeof AssistantContent.Type

export const UserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Array(UserContent),
  /** Harness-injected (e.g. a subagent task notification) rather than user-typed.
   * Model-visible, but consumers must not treat it as genuine user input. */
  isMeta: Schema.optional(Schema.Boolean),
})
export type UserMessage = typeof UserMessage.Type

export const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(AssistantContent),
})
export type AssistantMessage = typeof AssistantMessage.Type

const text = (value: string): TextContent => TextContent.make({ type: "text", text: value })

const MessageSchema = Schema.Union(UserMessage, AssistantMessage)

export const Message = Object.assign(MessageSchema, {
  user: (input: string | ReadonlyArray<UserContent>, isMeta = false): UserMessage =>
    UserMessage.make({
      role: "user",
      content: typeof input === "string" ? [text(input)] : input,
      ...(isMeta && { isMeta: true }),
    }),
  assistant: (input: string | ReadonlyArray<AssistantContent>): AssistantMessage =>
    AssistantMessage.make({
      role: "assistant",
      content: typeof input === "string" ? [text(input)] : input,
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
