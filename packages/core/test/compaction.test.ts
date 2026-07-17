import { describe, expect, test } from "bun:test"
import type { LLMEvent, Message, Model } from "@swain/llms"
import { ContentId, ModelId, Message as Msg, ProviderId, ToolCallId } from "@swain/llms"
import { Effect } from "effect"
import {
  compactSession,
  defaultTokenCounter,
  deriveContext,
  isValidlyPaired,
  selectCut,
} from "../src/context"
import { createSessionState, type SessionState } from "../src/state"
import { scriptedLLMClient } from "./utils/harness"

const model: Model = {
  id: ModelId.make("test-model"),
  provider: ProviderId.make("test"),
  streamTurn: () => {
    throw new Error("unused")
  },
}

const summaryText = "## Goal\nDo the thing\n\n## Remaining work\nKeep going"

const summaryTurn: ReadonlyArray<LLMEvent> = [
  { type: "text-start", contentId: ContentId.make("s-1") },
  { type: "text-delta", contentId: ContentId.make("s-1"), text: summaryText },
  { type: "text-end", contentId: ContentId.make("s-1") },
  { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
]

const toolResult = (id: string) =>
  ({
    type: "tool-result" as const,
    toolCallId: ToolCallId.make(id),
    name: "Read",
    result: { type: "text" as const, value: "file contents" },
  }) satisfies Message["content"][number]

const toolCall = (id: string) =>
  ({
    type: "tool-call" as const,
    toolCallId: ToolCallId.make(id),
    name: "Read",
    input: { path: "/f" },
  }) satisfies Message["content"][number]

/** A five-turn transcript with a tool-call/result pair; assistant boundaries at 1,3,5. */
const transcript = (): Array<Message> => [
  Msg.user("first prompt"),
  Msg.assistant([{ type: "text", text: "working" }, toolCall("call-1")]),
  Msg.user([toolResult("call-1")]),
  Msg.assistant([{ type: "text", text: "done step one" }]),
  Msg.user("second prompt"),
  Msg.assistant([{ type: "text", text: "final answer" }]),
]

const session = (messages: Array<Message>): SessionState =>
  createSessionState({
    workingDirectory: "/work",
    model,
    currentDate: "2026-07-13",
    messages,
  })

const compactionBlocks = (messages: ReadonlyArray<Message>) =>
  messages.flatMap((m) => m.content.filter((b) => b.type === "compaction"))

const run = (state: SessionState, options: Parameters<typeof compactSession>[1]) =>
  Effect.runPromise(
    compactSession(state, options).pipe(Effect.provide(scriptedLLMClient([summaryTurn]))),
  )

describe("compaction", () => {
  test("manual compaction retains full history and appends the marker at the end", async () => {
    const original = transcript()
    const state = session([...original])
    const result = await run(state, {
      reason: "manual",
      tailBudget: 20,
      now: "2026-07-13T00:00:00Z",
    })

    expect(result.compactedMessages).toBeGreaterThan(0)
    expect(state.compaction.summary).toBe(summaryText)
    expect(state.compaction.lastCompactedAt).toBe("2026-07-13T00:00:00Z")

    // History is retained in full; the marker is appended at the temporal end.
    expect(state.messages).toHaveLength(original.length + 1)
    expect(state.messages.slice(0, original.length)).toEqual(original)
    const last = state.messages[state.messages.length - 1]!
    if (last.role !== "user") throw new Error("expected a user meta message")
    expect(last.isMeta).toBe(true)
    // The meta reuses the deterministic `now` override as its commit timestamp.
    expect(last.createdAt).toBe("2026-07-13T00:00:00Z")
    const block = last.content[0]!
    expect(block.type).toBe("compaction")
    if (block.type === "compaction") {
      expect(block.summary).toBe(summaryText)
      expect(block.reason).toBe("manual")
      expect(block.compactedMessages).toBe(result.compactedMessages)
      expect(block.contextTailStart).toBeGreaterThan(0)
    }
  })

  test("derived context replaces the older prefix with the summary", async () => {
    const state = session(transcript())
    await run(state, { reason: "manual", tailBudget: 20 })

    const { messages: context } = deriveContext(state.messages)
    // Context begins with the summary meta, then the kept verbatim tail.
    expect(compactionBlocks(context)).toHaveLength(1)
    const head = context[0]!
    expect(head.role === "user" && head.isMeta).toBe(true)
    expect(context[1]!.role).toBe("assistant")
    expect(isValidlyPaired(context)).toBe(true)
    // Context is smaller than the full retained history.
    expect(context.length).toBeLessThan(state.messages.length)
  })

  test("a second compaction stacks markers in history but the context carries one summary", async () => {
    const state = session(transcript())
    await run(state, { reason: "manual", tailBudget: 20 })
    // Continue the conversation, then compact again.
    state.messages.push(Msg.user("third prompt"), Msg.assistant([{ type: "text", text: "more" }]))
    await run(state, { reason: "manual", tailBudget: 20 })

    // Both markers persist in history (append-only)…
    expect(compactionBlocks(state.messages)).toHaveLength(2)
    // …but deriveContext applies only the latest, yielding one active summary.
    expect(compactionBlocks(deriveContext(state.messages).messages)).toHaveLength(1)
    expect(state.compaction.summary).toBe(summaryText)
  })

  test("manual compaction runs even when auto compaction is disabled", async () => {
    const state = session(transcript())
    Object.assign(state.compaction, { autoEnabled: false, failureReason: "earlier failure" })
    await run(state, { reason: "manual", tailBudget: 20 })
    expect(state.compaction.summary).toBe(summaryText)
    // Manual compaction must not re-enable auto.
    expect(state.compaction.autoEnabled).toBe(false)
  })

  test("compaction invalidates the context-usage snapshot", async () => {
    const state = session(transcript())
    state.contextUsage = { activeContextTokens: 1234, measuredAtMessageIndex: 6 }
    await run(state, { reason: "manual", tailBudget: 20 })
    expect(state.contextUsage).toBeUndefined()
  })

  test("empty summary text is a compaction failure", async () => {
    const state = session(transcript())
    const emptyTurn: ReadonlyArray<LLMEvent> = [
      { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
    ]
    const error = await Effect.runPromise(
      compactSession(state, { reason: "manual", tailBudget: 20 }).pipe(
        Effect.provide(scriptedLLMClient([emptyTurn])),
        Effect.flip,
      ),
    )
    expect(error._tag).toBe("CompactionError")
    if (error._tag === "CompactionError") expect(error.reason).toBe("empty-summary")
  })

  test("a tool call in the summary response is a compaction failure", async () => {
    const state = session(transcript())
    const id = ToolCallId.make("t-1")
    const toolTurn: ReadonlyArray<LLMEvent> = [
      { type: "tool-input-start", toolCallId: id, name: "Read" },
      { type: "tool-input-end", toolCallId: id, name: "Read" },
      { type: "tool-call", toolCallId: id, name: "Read", input: {} },
      { type: "finish", reason: "tool-call" },
    ]
    const error = await Effect.runPromise(
      compactSession(state, { reason: "manual", tailBudget: 20 }).pipe(
        Effect.provide(scriptedLLMClient([toolTurn])),
        Effect.flip,
      ),
    )
    expect(error._tag).toBe("CompactionError")
    if (error._tag === "CompactionError") expect(error.reason).toBe("tool-call")
  })
})

describe("deriveContext", () => {
  const marker = (contextTailStart?: number): Message =>
    Msg.user(
      [
        {
          type: "compaction" as const,
          reason: "manual" as const,
          compactedMessages: 2,
          summary: summaryText,
          ...(contextTailStart !== undefined && { contextTailStart }),
        },
      ],
      true,
    )

  test("passes history through unchanged when there is no marker", () => {
    const history = transcript()
    const { messages, sourceIndex } = deriveContext(history)
    expect(messages).toBe(history)
    expect(sourceIndex).toEqual(history.map((_, i) => i))
  })

  test("applies the latest marker: summary then verbatim tail from contextTailStart", () => {
    const history = [...transcript(), marker(4)]
    const { messages, sourceIndex } = deriveContext(history)
    // [summary(meta), history[4], history[5]] — the prefix 0..3 is dropped.
    expect(messages).toHaveLength(3)
    expect(compactionBlocks(messages)).toHaveLength(1)
    expect(sourceIndex).toEqual([-1, 4, 5])
    expect(messages[1]).toBe(history[4])
  })

  test("legacy marker without contextTailStart keeps everything after the marker", () => {
    // Pre-retention layout: marker at index 0, tail follows.
    const tail = transcript().slice(1)
    const history = [marker(), ...tail]
    const { messages, sourceIndex } = deriveContext(history)
    expect(messages).toHaveLength(1 + tail.length)
    expect(messages.slice(1)).toEqual(tail)
    expect(sourceIndex[0]).toBe(-1)
  })

  test("drops earlier markers, keeping only the latest summary", () => {
    const history = [
      ...transcript(),
      marker(4),
      Msg.assistant([{ type: "text", text: "x" }]),
      marker(6),
    ]
    const { messages } = deriveContext(history)
    expect(compactionBlocks(messages)).toHaveLength(1)
    // Latest marker (index 8) has contextTailStart 6 → tail is history[6..], markers stripped.
    expect(messages[0]!.content[0]!.type).toBe("compaction")
  })
})

describe("selectCut", () => {
  const counter = defaultTokenCounter

  test("keeps the largest recent tail within the tail budget", () => {
    const messages = transcript()
    const tailBudget = counter.estimateMessages(messages.slice(5))
    const cut = selectCut(messages, counter, tailBudget, Number.POSITIVE_INFINITY)
    // Only the final assistant message fits; the cut is at boundary 5.
    expect(cut).toBe(5)
    expect(counter.estimateMessages(messages.slice(cut))).toBeLessThanOrEqual(tailBudget)
  })

  test("falls back to a bounded prefix when the prefix exceeds the input budget", () => {
    const messages = transcript()
    // Generous tail budget wants to summarize almost everything, but a tiny
    // input budget forces summarizing only the earliest bounded prefix.
    const tinyInputBudget = counter.estimateMessages(messages.slice(0, 1))
    const cut = selectCut(messages, counter, 100_000, tinyInputBudget)
    expect(cut).toBeGreaterThan(0)
    expect(cut).toBeLessThan(5)
    expect(counter.estimateMessages(messages.slice(0, cut))).toBeLessThanOrEqual(tinyInputBudget)
  })

  test("returns 0 when not even the smallest prefix fits the input budget", () => {
    const messages = transcript()
    // A budget below the first boundary's prefix: nothing can be summarized
    // within budget, so the cut must be 0 (caller fails fast, no over-budget
    // summary request).
    const cut = selectCut(messages, counter, 100_000, 0)
    expect(cut).toBe(0)
  })
})

describe("isValidlyPaired", () => {
  test("rejects an orphaned tool-result", () => {
    const messages: Array<Message> = [Msg.user([toolResult("call-x")])]
    expect(isValidlyPaired(messages)).toBe(false)
  })

  test("rejects an unanswered tool-call", () => {
    const messages: Array<Message> = [
      Msg.user("hi"),
      Msg.assistant([toolCall("call-y")]),
      Msg.user("no results here"),
    ]
    expect(isValidlyPaired(messages)).toBe(false)
  })
})
