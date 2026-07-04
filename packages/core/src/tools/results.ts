import type { ToolCall, ToolResultContent } from "@swain/llms"
import { ToolResultContent as ToolResultContentSchema } from "@swain/llms"

export const successResult = (toolCall: ToolCall, value: unknown): ToolResultContent =>
  ToolResultContentSchema.make({
    type: "tool-result",
    toolCallId: toolCall.toolCallId,
    name: toolCall.name,
    result: { type: "json", value },
  })

export const errorResult = (toolCall: ToolCall, message: string): ToolResultContent =>
  ToolResultContentSchema.make({
    type: "tool-result",
    toolCallId: toolCall.toolCallId,
    name: toolCall.name,
    result: { type: "text", value: message },
    isError: true,
  })
