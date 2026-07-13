import type { Model } from "@swain/llms"

/** Hard cap on tokens reserved for model output when sizing the context window. */
export const OUTPUT_RESERVE_CAP = 20_000

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
  return contextWindow === undefined ? undefined : contextWindow - outputReserve(model)
}
