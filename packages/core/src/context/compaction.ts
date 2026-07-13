import type { LLMError } from "@swain/llms"
import { LLMClient, LLMTurnSummary, Message } from "@swain/llms"
import { Context, Data, Effect } from "effect"
import type { SessionState } from "../state"
import { effectiveContextWindow, outputReserve } from "./accounting"
import { defaultTokenCounter, type TokenCounter } from "./token-counter"

type LLMClientService = Context.Tag.Identifier<typeof LLMClient.Service>

export type CompactionReason = "auto" | "manual" | "overflow"

export class CompactionError extends Data.TaggedError("CompactionError")<{
  readonly reason: "nothing-to-compact" | "empty-summary" | "tool-call" | "invalid-transcript"
  readonly message: string
}> {}

export interface CompactionResult {
  /** Count of messages replaced by the single compaction meta message. */
  readonly compactedMessages: number
  readonly summary: string
}

export interface CompactOptions {
  readonly reason: CompactionReason
  readonly counter?: TokenCounter
  /** Recent verbatim tail budget in tokens; defaults to 20k, clamped for small windows. */
  readonly tailBudget?: number
  /** ISO timestamp recorded as `lastCompactedAt`; defaults to now. */
  readonly now?: string
}

const DEFAULT_TAIL_BUDGET = 20_000
// Rough allowance for the summary system prompt when sizing the input budget.
const SUMMARY_PROMPT_OVERHEAD = 1_000

const SUMMARY_SYSTEM = `You are compacting a long coding-assistant conversation into a compact, self-contained summary so a future model can resume the task without the original transcript.

Read the entire conversation above (which may already begin with an earlier summary) and produce EXACTLY these Markdown sections, in this order, with these headings:

## Goal

## Decisions and constraints

## Key Context (files, code references, etc)

## Progress so far

## Remaining work

## All user messages

Rules:
- Respond with text only. Do not call any tools.
- Output only the requested Markdown sections in the requested order. Do not wrap the summary in extra XML tags, prefaces, or explanations.
- Keep it self-contained for a future model resuming the task.
- Preserve every user instruction in "All user messages".
- Preserve exact file paths, commands, error strings, identifiers, and model/tool names.
- Preserve active tasks, blockers, approvals, and pending user questions.
- "Remaining work" must be specific enough to continue without asking what to do next.
- If an earlier summary is present, update it: keep still-true facts, drop stale facts, merge new facts.
- Do not mention the compaction process itself.`

const toolCallIds = (message: Message): ReadonlyArray<string> =>
  message.role === "assistant"
    ? message.content.filter((b) => b.type === "tool-call").map((b) => b.toolCallId)
    : []

const toolResultIds = (message: Message): ReadonlyArray<string> =>
  message.role === "user"
    ? message.content.filter((b) => b.type === "tool-result").map((b) => b.toolCallId)
    : []

/**
 * A transcript is validly paired when every assistant tool-call is answered by
 * tool-results in the immediately following user message, and every tool-result
 * answers a call in the immediately preceding assistant message. This is the
 * invariant providers enforce; the mutated transcript must satisfy it before it
 * can be submitted.
 */
export const isValidlyPaired = (messages: ReadonlyArray<Message>): boolean => {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!
    const callIds = toolCallIds(message)
    if (callIds.length > 0) {
      const next = messages[i + 1]
      if (next === undefined || next.role !== "user") return false
      const resultIds = new Set(toolResultIds(next))
      if (!callIds.every((id) => resultIds.has(id))) return false
    }
    const resultIds = toolResultIds(message)
    if (resultIds.length > 0) {
      const prev = messages[i - 1]
      if (prev === undefined || prev.role !== "assistant") return false
      const prevCalls = new Set(toolCallIds(prev))
      if (!resultIds.every((id) => prevCalls.has(id))) return false
    }
  }
  return true
}

/** Assistant-boundary indices `i` (`1 <= i < len`) where a verbatim tail may begin. */
const assistantBoundaries = (messages: ReadonlyArray<Message>): ReadonlyArray<number> => {
  const boundaries: Array<number> = []
  for (let i = 1; i < messages.length; i += 1) {
    if (messages[i]!.role === "assistant") boundaries.push(i)
  }
  return boundaries
}

/**
 * The cut index `p`: `messages[0..p)` is summarized, `messages[p..]` kept
 * verbatim. Default keeps the largest recent tail within `tailBudget`. If the
 * summarized prefix would itself exceed the summary input budget, a smaller
 * bounded prefix is summarized instead (leaving a larger verbatim middle).
 */
export const selectCut = (
  messages: ReadonlyArray<Message>,
  counter: TokenCounter,
  tailBudget: number,
  summaryInputBudget: number,
): number => {
  const boundaries = assistantBoundaries(messages)
  if (boundaries.length === 0) return 0

  // Largest tail within budget: smallest boundary whose suffix fits.
  let tailStart = boundaries[boundaries.length - 1]!
  for (const i of boundaries) {
    if (counter.estimateMessages(messages.slice(i)) <= tailBudget) {
      tailStart = i
      break
    }
  }

  if (counter.estimateMessages(messages.slice(0, tailStart)) <= summaryInputBudget) {
    return tailStart
  }

  // Bounded-prefix fallback: summarize the largest prefix that fits the summary
  // input budget, leaving everything after it (middle + tail) verbatim.
  let cut = boundaries[0]!
  for (const i of boundaries) {
    if (i >= tailStart) break
    if (counter.estimateMessages(messages.slice(0, i)) <= summaryInputBudget) cut = i
  }
  return cut
}

/**
 * Runs one full compaction: summarizes the older transcript prefix into a single
 * compound summary via the current session model (no tools), then replaces that
 * prefix with one compaction meta message while preserving the recent verbatim
 * tail. Updates `session.compaction.summary` and invalidates context accounting.
 */
export const compactSession = (
  session: SessionState,
  options: CompactOptions,
): Effect.Effect<CompactionResult, CompactionError | LLMError, LLMClientService> =>
  Effect.gen(function* () {
    const counter = options.counter ?? defaultTokenCounter
    const model = session.systemContext.model
    const eff = effectiveContextWindow(model)
    const tailBudget =
      eff === undefined
        ? (options.tailBudget ?? DEFAULT_TAIL_BUDGET)
        : Math.min(options.tailBudget ?? DEFAULT_TAIL_BUDGET, Math.floor(eff / 2))
    const summaryInputBudget =
      eff === undefined
        ? Number.POSITIVE_INFINITY
        : eff - outputReserve(model) - SUMMARY_PROMPT_OVERHEAD

    const messages = session.messages
    const cut = selectCut(messages, counter, tailBudget, summaryInputBudget)
    if (cut <= 0) {
      return yield* new CompactionError({
        reason: "nothing-to-compact",
        message: "Not enough older conversation to compact yet.",
      })
    }

    const prefix = messages.slice(0, cut)
    const summaryCap = Math.min(
      DEFAULT_TAIL_BUDGET,
      model.limits?.maxOutputTokens ?? DEFAULT_TAIL_BUDGET,
    )
    const requestOptions = session.systemContext.requestOptions
    const request = LLMClient.request({
      model,
      system: SUMMARY_SYSTEM,
      messages: prefix,
      generation: { maxTokens: summaryCap },
      ...(requestOptions.providerOptions !== undefined && {
        providerOptions: requestOptions.providerOptions,
      }),
    })

    const response = yield* LLMClient.generateTurn(request)
    const summary = yield* LLMTurnSummary.fromEvents(response.events)
    if (summary.toolCalls.length > 0) {
      return yield* new CompactionError({
        reason: "tool-call",
        message: "Compaction request unexpectedly produced a tool call.",
      })
    }
    const text = summary.text.trim()
    if (text === "") {
      return yield* new CompactionError({
        reason: "empty-summary",
        message: "Compaction produced an empty summary.",
      })
    }

    const meta = Message.user(
      [{ type: "compaction", reason: options.reason, compactedMessages: cut, summary: text }],
      true,
    )
    const kept = messages.slice(cut)
    const next = [meta, ...kept]
    if (!isValidlyPaired(next)) {
      return yield* new CompactionError({
        reason: "invalid-transcript",
        message: "Compaction would split a tool-call/tool-result pair.",
      })
    }

    messages.splice(0, messages.length, ...next)
    Object.assign(session.compaction, {
      lastCompactedAt: options.now ?? new Date().toISOString(),
      summary: text,
    })
    // Older messages changed; force a full local re-estimate next request.
    session.contextUsage = undefined

    return { compactedMessages: cut, summary: text }
  })
