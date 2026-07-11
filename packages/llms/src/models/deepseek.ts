/** DeepSeek model ids. */
export const DeepSeekModel = {
  V4_Flash: "deepseek-v4-flash",
  V4_Pro: "deepseek-v4-pro",
} as const
export type DeepSeekModel = (typeof DeepSeekModel)[keyof typeof DeepSeekModel]

/** Reasoning effort; lower requests clamp up to `High`, so only these are distinct. */
export const DeepSeekVariant = {
  High: "high",
  Max: "max",
} as const
export type DeepSeekVariant = (typeof DeepSeekVariant)[keyof typeof DeepSeekVariant]

/** Reasoning-effort levels each model supports; both V4 models are identical. */
export const DeepSeekModelVariants = {
  [DeepSeekModel.V4_Flash]: [DeepSeekVariant.High, DeepSeekVariant.Max],
  [DeepSeekModel.V4_Pro]: [DeepSeekVariant.High, DeepSeekVariant.Max],
} as const satisfies Record<DeepSeekModel, ReadonlyArray<DeepSeekVariant>>
