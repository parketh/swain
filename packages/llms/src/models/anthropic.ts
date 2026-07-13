/** Anthropic model ids (values are the provider-native ids). */
export const AnthropicModel = {
  Claude_Opus_4_8: "claude-opus-4-8",
} as const
export type AnthropicModel = (typeof AnthropicModel)[keyof typeof AnthropicModel]

/** Adaptive-thinking effort vocabulary; `XHigh` is labelled "Extra" in the UI. */
export const AnthropicVariant = {
  Low: "low",
  Medium: "medium",
  High: "high",
  XHigh: "xhigh",
  Max: "max",
} as const
export type AnthropicVariant = (typeof AnthropicVariant)[keyof typeof AnthropicVariant]

/** Reasoning-effort levels each model supports. */
export const AnthropicModelVariants = {
  [AnthropicModel.Claude_Opus_4_8]: [
    AnthropicVariant.Low,
    AnthropicVariant.Medium,
    AnthropicVariant.High,
    AnthropicVariant.XHigh,
    AnthropicVariant.Max,
  ],
} as const satisfies Record<AnthropicModel, ReadonlyArray<AnthropicVariant>>

/** Provider-recommended default effort per model, used when none is specified. */
export const AnthropicModelDefaultVariant = {
  [AnthropicModel.Claude_Opus_4_8]: AnthropicVariant.High,
} as const satisfies Record<AnthropicModel, AnthropicVariant>
