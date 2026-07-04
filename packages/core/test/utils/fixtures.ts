import type { FinishReason, LLMEvent } from "@swain/llms"
import { ContentId, ToolCallId } from "@swain/llms"

const contentId = ContentId.make("content-1")

/** A scripted text-only turn ending with the given finish reason. */
export const textTurn = (text: string, reason: FinishReason = "stop"): ReadonlyArray<LLMEvent> => [
  { type: "text-start", contentId },
  { type: "text-delta", contentId, text },
  { type: "text-end", contentId },
  { type: "finish", reason, usage: { inputTokens: 1, outputTokens: 1 } },
]

/** A scripted turn that emits a single tool call and finishes with `tool-call`. */
export const toolCallTurn = (
  name: string,
  input: unknown,
  toolCallId = "call-1",
): ReadonlyArray<LLMEvent> => {
  const id = ToolCallId.make(toolCallId)
  return [
    { type: "tool-input-start", toolCallId: id, name },
    { type: "tool-input-delta", toolCallId: id, text: JSON.stringify(input) },
    { type: "tool-input-end", toolCallId: id, name },
    { type: "tool-call", toolCallId: id, name, input },
    { type: "finish", reason: "tool-call", usage: { inputTokens: 1, outputTokens: 1 } },
  ]
}
