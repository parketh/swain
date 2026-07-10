import { allCatalogModels, type ModelOption, type RoutingProfile } from "./models"

export interface RouterTargetRef {
  readonly provider: string
  readonly modelId: string
  readonly variant?: string
}

/** Canonical string identity for a routable target: `provider:modelId[:variant]`. */
export type RouterTargetId = string

/** Encodes a target ref as `provider:modelId[:variant]`. */
export const targetId = (ref: RouterTargetRef): RouterTargetId =>
  ref.variant !== undefined && ref.variant !== ""
    ? `${ref.provider}:${ref.modelId}:${ref.variant}`
    : `${ref.provider}:${ref.modelId}`

/** `provider:modelId` for whole-model identity, ignoring any variant. */
export const modelKey = (ref: Pick<RouterTargetRef, "provider" | "modelId">): string =>
  `${ref.provider}:${ref.modelId}`

/**
 * Parses a `provider:modelId[:variant]` id, validating exactly two or three
 * non-empty segments. Returns `undefined` for malformed ids.
 */
export const parseTargetId = (id: string): RouterTargetRef | undefined => {
  const segments = id.split(":")
  if (segments.length < 2 || segments.length > 3) return undefined
  if (segments.some((segment) => segment.length === 0)) return undefined
  const [provider, modelId, variant] = segments as [string, string, string?]
  return { provider, modelId, ...(variant !== undefined ? { variant } : {}) }
}

export interface RoutableTarget {
  readonly ref: RouterTargetRef
  readonly id: RouterTargetId
  readonly label: string
  readonly routing?: RoutingProfile
}

/**
 * All routable targets for a catalog model: the model's default target when it
 * has no variants, otherwise one target per variant. Variant targets carry the
 * variant's effective routing profile (model base merged with the variant cost).
 */
export const modelRoutableTargets = (model: ModelOption): ReadonlyArray<RoutableTarget> => {
  if (model.variants.length === 0) {
    const ref: RouterTargetRef = { provider: model.provider, modelId: model.modelId }
    return [
      {
        ref,
        id: targetId(ref),
        label: model.label,
        ...(model.routing !== undefined && { routing: model.routing }),
      },
    ]
  }
  return model.variants.map((variant) => {
    const ref: RouterTargetRef = {
      provider: model.provider,
      modelId: model.modelId,
      variant: variant.id,
    }
    return {
      ref,
      id: targetId(ref),
      label: `${model.label} (${variant.label})`,
      ...(variant.routing !== undefined && { routing: variant.routing }),
    }
  })
}

/** Every routable target across the catalog, independent of configuration. */
export const catalogRoutableTargets = (): ReadonlyArray<RoutableTarget> =>
  allCatalogModels().flatMap(modelRoutableTargets)
