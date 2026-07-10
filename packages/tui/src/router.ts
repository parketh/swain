import type { RouterPromptTarget } from "@swain/core"
import type { RouterConfig, TuiConfig } from "./config"
import {
  aggregateRouting,
  allCatalogModels,
  availableModels,
  type ModelOption,
  type RoutingProfile,
} from "./models"

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

/** Normalized router settings; an omitted `router` reads as disabled with empty opt-outs. */
export const routerSettings = (config: TuiConfig): RouterConfig =>
  config.router ?? { enabled: false, disabledModels: [], disabledTargets: [] }

/**
 * Router targets currently enabled: every routable target of a configured
 * provider, minus whole-model opt-outs (`disabledModels`) and variant opt-outs
 * (`disabledTargets`). New models/variants are enabled by default because config
 * stores opt-outs only.
 */
export const enabledRouterTargets = (config: TuiConfig): ReadonlyArray<RoutableTarget> => {
  const settings = routerSettings(config)
  const disabledModels = new Set(settings.disabledModels)
  const disabledTargets = new Set(settings.disabledTargets)
  return availableModels(config)
    .filter((model) => !disabledModels.has(modelKey(model)))
    .flatMap(modelRoutableTargets)
    .filter((target) => !disabledTargets.has(target.id))
}

/**
 * Enabled targets rendered as router prompt rows: canonical id, label, and the
 * derived comparison signals from each target's routing profile. Missing
 * metadata stays `undefined` so the prompt can mark it unknown rather than
 * inventing a value.
 */
export const routerPromptTargets = (config: TuiConfig): ReadonlyArray<RouterPromptTarget> =>
  enabledRouterTargets(config).map((target) => {
    const routing = target.routing
    const aggregate = routing !== undefined ? aggregateRouting(routing) : undefined
    return {
      id: target.id,
      label: target.label,
      hasBenchmarks: (routing?.benchmarks.length ?? 0) > 0,
      ...(aggregate?.capability !== undefined && { capability: aggregate.capability }),
      ...(aggregate?.benchmarkAvg !== undefined && { benchmarkAvg: aggregate.benchmarkAvg }),
      ...(aggregate?.contextWindow !== undefined && { contextWindow: aggregate.contextWindow }),
      ...(aggregate?.aggregateCost !== undefined && { aggregateCost: aggregate.aggregateCost }),
      ...(routing?.relCostEstimate !== undefined && { relCostEstimate: routing.relCostEstimate }),
      ...(routing?.relCostBasis !== undefined && { relCostBasis: routing.relCostBasis }),
    }
  })

export type RouterStatus = "off" | "inactive" | "on"

/**
 * Router runtime state: `off` when the master toggle is disabled, `inactive`
 * when on but fewer than two enabled connected targets exist, otherwise `on`.
 */
export const routerStatus = (config: TuiConfig): RouterStatus => {
  if (routerSettings(config).enabled !== true) return "off"
  return enabledRouterTargets(config).length >= 2 ? "on" : "inactive"
}
