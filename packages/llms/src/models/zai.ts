/** Z.AI model ids. */
export const ZAIModel = {
  GLM_5_2: "glm-5.2",
} as const
export type ZAIModel = (typeof ZAIModel)[keyof typeof ZAIModel]

/** Reasoning effort for GLM-5.2; only `High` and `Max` are distinct. */
export const ZAIVariant = {
  High: "high",
  Max: "max",
} as const
export type ZAIVariant = (typeof ZAIVariant)[keyof typeof ZAIVariant]

/** Reasoning-effort levels each model supports. */
export const ZAIModelVariants = {
  [ZAIModel.GLM_5_2]: [ZAIVariant.High, ZAIVariant.Max],
} as const satisfies Record<ZAIModel, ReadonlyArray<ZAIVariant>>

/** Provider-recommended default effort per model, used when none is specified. */
export const ZAIModelDefaultVariant = {
  [ZAIModel.GLM_5_2]: ZAIVariant.High,
} as const satisfies Record<ZAIModel, ZAIVariant>
