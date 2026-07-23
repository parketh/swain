import type { CompactionContent, LLMError, Message } from "@swain/llms"
import { LLMClient, LLMTurnSummary } from "@swain/llms"
import { Context, Data, Duration, Effect } from "effect"
import { type SessionState, userMessage } from "../state"
import { effectiveContextWindow } from "./accounting"
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

/**
 * Notice surfaced when compaction runs on a model that depends on full reasoning
 * history (Kimi K3). Moonshot flags dropping cross-turn reasoning as risky, but
 * compaction still runs — the same lossy tradeoff every model makes.
 */
export const REASONING_LOSS_COMPACTION_WARNING =
  "Compacted a session on a model that relies on full reasoning history (Kimi K3). Moonshot flags cross-turn reasoning loss as risky; reasoning in the compacted turns will not be replayed."

/** Whether compacting this session risks reasoning loss the model depends on. */
export const warnsOnReasoningLoss = (session: SessionState): boolean =>
  session.systemContext.model.warnOnReasoningLoss === true

const compactionBlock = (message: Message): CompactionContent | undefined =>
  message.role === "user"
    ? (message.content.find((b) => b.type === "compaction") as CompactionContent | undefined)
    : undefined

/**
 * Projects the full append-only history into the message list sent to the model.
 * `session.messages` is the source of truth (persisted and displayed in full);
 * this is the one seam that maps it to model context. The most recent compaction
 * marker replaces everything before its recorded `contextTailStart` with the
 * summary; earlier markers drop out (their content is already folded into the
 * latest, cumulative summary). Without any marker the history passes through
 * unchanged. `sourceIndex[i]` is the history index context message `i` came from
 * (`-1` for the synthesized summary), letting callers map a context cut back to
 * a history index.
 */
export const deriveContext = (
  history: ReadonlyArray<Message>,
): { messages: ReadonlyArray<Message>; sourceIndex: ReadonlyArray<number> } => {
  let last = -1
  for (let i = 0; i < history.length; i += 1) {
    if (compactionBlock(history[i]!) !== undefined) last = i
  }
  if (last === -1) return { messages: history, sourceIndex: history.map((_, i) => i) }

  const marker = history[last]!
  // Absent `contextTailStart` (legacy top-of-history marker) ⇒ tail is everything
  // after the marker, matching the pre-retention splice layout.
  const tailStart = compactionBlock(marker)!.contextTailStart ?? last + 1
  const messages: Array<Message> = [marker]
  const sourceIndex: Array<number> = [-1]
  for (let i = tailStart; i < history.length; i += 1) {
    if (compactionBlock(history[i]!) !== undefined) continue
    messages.push(history[i]!)
    sourceIndex.push(i)
  }
  return { messages, sourceIndex }
}

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
  // input budget, leaving everything after it (middle + tail) verbatim. If not
  // even the smallest prefix fits, return 0 so the caller fails fast rather than
  // issuing an over-budget summary request (which would overflow again).
  let cut = 0
  for (const i of boundaries) {
    if (i >= tailStart) break
    if (counter.estimateMessages(messages.slice(0, i)) <= summaryInputBudget) cut = i
  }
  return cut
}

/**
 * Runs one full compaction: summarizes the older context prefix into a single
 * compound summary via the current session model (no tools), then appends one
 * compaction marker at the end of history recording where the verbatim tail
 * resumes. History is retained in full (for display/persistence); the marker is
 * what `deriveContext` later applies to shrink the model context. Updates
 * `session.compaction.summary` and invalidates context accounting.
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
    // `eff` is already the usable input window (contextWindow − outputReserve),
    // so only the summary system prompt's overhead is subtracted here.
    const summaryInputBudget =
      eff === undefined ? Number.POSITIVE_INFINITY : eff - SUMMARY_PROMPT_OVERHEAD

    const history = session.messages
    const { messages: context, sourceIndex } = deriveContext(history)
    const cut = selectCut(context, counter, tailBudget, summaryInputBudget)
    if (cut <= 0) {
      return yield* new CompactionError({
        reason: "nothing-to-compact",
        message: "Not enough older conversation to compact yet.",
      })
    }

    const prefix = context.slice(0, cut)
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

    const [responseElapsed, response] = yield* Effect.timed(LLMClient.generateTurn(request))
    const responseDurationMs = Duration.toMillis(responseElapsed)
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

    // `contextTailStart` is the history index where the kept tail resumes; the
    // context cut maps back through `sourceIndex`. Count only real messages
    // folded (excluding a prior summary meta) for the display notice.
    const contextTailStart = sourceIndex[cut]!
    const compactedMessages = prefix.filter((m) => compactionBlock(m) === undefined).length
    const meta = userMessage(
      [
        {
          type: "compaction",
          reason: options.reason,
          compactedMessages,
          summary: text,
          contextTailStart,
        },
      ],
      {
        isMeta: true,
        responseDurationMs,
        ...(options.now !== undefined && { createdAt: options.now }),
      },
    )

    // The projection this marker will produce must be validly paired: the tail
    // starts at an assistant boundary, so prepending the summary keeps pairing.
    const nextContext = [meta, ...context.slice(cut)]
    if (!isValidlyPaired(nextContext)) {
      return yield* new CompactionError({
        reason: "invalid-transcript",
        message: "Compaction would split a tool-call/tool-result pair.",
      })
    }

    // Compaction spends real provider tokens; fold this turn's usage into the
    // session counters at the commit point (context accounting is re-estimated
    // below, so only the cumulative totals are updated here).
    if (summary.usage !== undefined) {
      session.counters.inputTokens += summary.usage.inputTokens
      session.counters.outputTokens += summary.usage.outputTokens
    }

    // Append at the temporal position; full history is retained for display.
    history.push(meta)
    Object.assign(session.compaction, {
      lastCompactedAt: options.now ?? new Date().toISOString(),
      summary: text,
    })
    // Context shape changed; force a full local re-estimate next request.
    session.contextUsage = undefined

    return { compactedMessages, summary: text }
  })
