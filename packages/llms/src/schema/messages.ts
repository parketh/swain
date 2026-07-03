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

export const UserContent = Schema.Union(TextContent, ToolResultContent)
export type UserContent = typeof UserContent.Type

export const AssistantContent = Schema.Union(TextContent, ReasoningContent, ToolCallContent)
export type AssistantContent = typeof AssistantContent.Type

export const UserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Array(UserContent),
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
  user: (input: string | ReadonlyArray<UserContent>): UserMessage =>
    UserMessage.make({
      role: "user",
      content: typeof input === "string" ? [text(input)] : input,
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
})

export const Tool = Object.assign(ToolSchema, {
  define: (input: {
    readonly name: string
    readonly description: string
    readonly inputSchema: JsonSchemaObject
  }): Tool => ToolSchema.make(input),
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
