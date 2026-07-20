import { Message, ToolCallId } from "@swain/llms"

/**
 * A user → assistant(tool-call) → tool-result turn used by the per-protocol
 * "timing metadata never reaches the request body" tests. When `timed`, every
 * message carries the local-only timing fields (`createdAt`, response/turn
 * durations, tool-result `durationMs`) that lowering must strip. Callers vary
 * the provider-specific tool-call id, an optional leading assistant text block,
 * and the tool-result value shape.
 */
export const timingTurn = (opts: {
  readonly callId: string
  readonly assistantText?: string
  readonly result: { type: "text"; value: string } | { type: "json"; value: unknown }
  readonly timed: boolean
}) => {
  const { callId, assistantText, result, timed } = opts
  const toolCallId = ToolCallId.make(callId)
  return [
    Message.user("What is bun?", false, timed ? { createdAt: "2026-07-17T10:00:00.000Z" } : {}),
    Message.assistant(
      [
        ...(assistantText !== undefined ? [{ type: "text" as const, text: assistantText }] : []),
        { type: "tool-call" as const, toolCallId, name: "lookup", input: { query: "bun" } },
      ],
      timed
        ? { createdAt: "2026-07-17T10:00:01.000Z", responseDurationMs: 1000, turnDurationMs: 3000 }
        : {},
    ),
    Message.user(
      [
        {
          type: "tool-result" as const,
          toolCallId,
          name: "lookup",
          result,
          ...(timed && { durationMs: 420 }),
        },
      ],
      false,
      timed ? { createdAt: "2026-07-17T10:00:01.420Z" } : {},
    ),
  ]
}
