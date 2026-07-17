import type { Model, Tool, Usage } from "@swain/llms"
import type { SessionState } from "../state"
import { deriveContext } from "./compaction"
import type { TokenCounter } from "./token-counter"

/** Hard cap on tokens reserved for model output when sizing the context window. */
export const OUTPUT_RESERVE_CAP = 20_000

/** Auto compaction triggers at ~90% of the effective context window. */
export const AUTO_COMPACT_FRACTION = 0.9

/**
 * Tokens held back for the model's response: the smaller of the model's own max
 * output and the global cap. Undefined `maxOutputTokens` falls back to the cap.
 */
export const outputReserve = (model: Model): number =>
  Math.min(model.limits?.maxOutputTokens ?? OUTPUT_RESERVE_CAP, OUTPUT_RESERVE_CAP)

/**
 * The usable input window: `contextWindow - outputReserve`. Undefined when the
 * model carries no context-window limit, in which case callers cannot compute
 * token pressure and must skip window-relative policy.
 */
export const effectiveContextWindow = (model: Model): number | undefined => {
  const contextWindow = model.limits?.contextWindow
  if (contextWindow === undefined) return undefined
  // Never let the reserve consume more than half the window. For a small window
  // with an unset `maxOutputTokens`, the flat cap would exceed it and yield a
  // negative window, which makes `shouldAutoCompact` trivially true (perpetual
  // compaction). Real catalog windows dwarf the reserve, so this is a no-op there.
  const reserve = Math.min(outputReserve(model), Math.floor(contextWindow / 2))
  return contextWindow - reserve
}

/** The active-context value from a provider usage snapshot, defaulting when absent. */
export const activeContextTokens = (usage: Usage): number =>
  usage.activeContextTokens ?? usage.inputTokens + usage.outputTokens

/**
 * Records the provider usage from the just-appended assistant response as the
 * session's context-usage snapshot, anchored at the current transcript length.
 */
export const recordContextUsage = (session: SessionState, usage: Usage): void => {
  session.contextUsage = {
    activeContextTokens: activeContextTokens(usage),
    measuredAtMessageIndex: session.messages.length,
  }
}

/** System prompt and tool-schema inputs not represented in the transcript. */
export interface RequestShape {
  readonly system?: string
  readonly tools?: ReadonlyArray<Tool>
}

const estimateShape = (shape: RequestShape, counter: TokenCounter): number => {
  let total = shape.system !== undefined ? counter.estimateText(shape.system) : 0
  for (const tool of shape.tools ?? []) total += counter.estimateJson(tool)
  return total
}

/**
 * Best-estimate current request pressure. With a valid provider snapshot, adds
 * a local estimate of the transcript appended since the snapshot to the reported
 * active context. Without one — or when the transcript has since shrunk (e.g.
 * after compaction), invalidating the snapshot — estimates the whole request
 * locally, including the system prompt and tool schemas.
 */
export const estimateCurrentContextTokens = (
  session: SessionState,
  shape: RequestShape,
  counter: TokenCounter,
): number => {
  const snapshot = session.contextUsage
  if (snapshot !== undefined && snapshot.measuredAtMessageIndex <= session.messages.length) {
    const delta = counter.estimateMessages(session.messages.slice(snapshot.measuredAtMessageIndex))
    return snapshot.activeContextTokens + delta
  }
  return (
    estimateShape(shape, counter) +
    counter.estimateMessages(deriveContext(session.messages).messages)
  )
}

/**
 * Whether automatic compaction should run before this request: auto is enabled,
 * the model has a known window, and estimated pressure has reached the trigger
 * fraction of the effective window.
 */
export const shouldAutoCompact = (
  session: SessionState,
  shape: RequestShape,
  counter: TokenCounter,
): boolean => {
  if (!session.compaction.autoEnabled) return false
  const eff = effectiveContextWindow(session.systemContext.model)
  if (eff === undefined) return false
  return estimateCurrentContextTokens(session, shape, counter) >= eff * AUTO_COMPACT_FRACTION
}
