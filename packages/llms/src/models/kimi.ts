/** Kimi model ids (Moonshot pay-as-you-go). */
export const KimiModel = {
  K3: "kimi-k3",
} as const
export type KimiModel = (typeof KimiModel)[keyof typeof KimiModel]

/** K3 currently accepts only `reasoning_effort: "max"`; no `low`/`high` ladder. */
export const KimiVariant = {
  Max: "max",
} as const
export type KimiVariant = (typeof KimiVariant)[keyof typeof KimiVariant]

/** Reasoning-effort levels each model supports. */
export const KimiModelVariants = {
  [KimiModel.K3]: [KimiVariant.Max],
} as const satisfies Record<KimiModel, ReadonlyArray<KimiVariant>>

/** Provider-recommended default effort per model, used when none is specified. */
export const KimiModelDefaultVariant = {
  [KimiModel.K3]: KimiVariant.Max,
} as const satisfies Record<KimiModel, KimiVariant>
