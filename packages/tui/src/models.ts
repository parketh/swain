import type { GenerationOptions, Model, ProviderOptions } from "@swain/llms"
import { Anthropic, DeepSeek, OpenAI, OpenAICodex, Pollinations, ZAI } from "@swain/llms/providers"
import { Data } from "effect"
import type { ProviderConfig, TuiConfig } from "./config"
import { redactKey } from "./config"

export type CredentialField = "apiKey" | "baseURL" | "accountId" | "accessToken"

export type RelCostBasis = "published-price" | "measured-usage" | "manual-estimate"

export interface RoutingBenchmark {
  readonly name: string
  readonly score: number // normalized 0-100, higher is always better
}

export interface RoutingProfile {
  readonly inputCostPerMTok?: number
  readonly outputCostPerMTok?: number
  readonly contextWindow?: number
  readonly capability?: number
  readonly relCostEstimate?: number
  readonly relCostBasis?: RelCostBasis
  readonly benchmarks: ReadonlyArray<RoutingBenchmark>
}

/** Comparison signals derived from a `RoutingProfile`; unknown inputs stay undefined. */
export interface RoutingAggregate {
  readonly capability?: number
  readonly benchmarkAvg?: number
  readonly contextWindow?: number
  readonly aggregateCost?: number
  readonly relCostBasis?: RelCostBasis
}

// Published list prices per 1M tokens (USD), keyed by `${provider}/${modelId}`.
// Standard tier, sourced from each provider's 2026-07 pricing docs. Prompt-cache
// and batch discounts aren't modelled — and swain doesn't track cache-hit
// tokens — so a computed cost is an upper bound on the real bill.
interface ModelPrice {
  readonly input: number
  readonly output: number
}

const PRICES: Record<string, ModelPrice> = {
  "anthropic/claude-opus-4-8": { input: 5, output: 25 },
  "anthropic/claude-sonnet-5": { input: 3, output: 15 },
  "openai/gpt-5.5": { input: 5, output: 30 },
  "openai/gpt-5.5-pro": { input: 30, output: 180 },
  "openai/gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "openai/gpt-5.4-nano": { input: 0.2, output: 1.25 },
  "deepseek/deepseek-v4-flash": { input: 0.14, output: 0.28 },
  "deepseek/deepseek-v4-pro": { input: 0.44, output: 0.87 },
  "zai/glm-5.2": { input: 1.4, output: 4.4 },
  "openai-codex/gpt-5-codex": { input: 1.25, output: 10 },
}

// Rough relative capability tier (0-100), a manual estimate pending real
// benchmark data. Benchmarks stay empty until measured values are supplied.
const CAPABILITY: Record<string, number> = {
  "anthropic/claude-opus-4-8": 95,
  "anthropic/claude-sonnet-5": 88,
  "openai/gpt-5.5": 87,
  "openai/gpt-5.5-pro": 93,
  "openai/gpt-5.4-mini": 70,
  "openai/gpt-5.4-nano": 55,
  "deepseek/deepseek-v4-flash": 68,
  "deepseek/deepseek-v4-pro": 80,
  "zai/glm-5.2": 75,
  "openai-codex/gpt-5-codex": 85,
}

/**
 * Base routing profile for a model's default (lowest/no-effort) target: known
 * token prices, a rough capability tier, and a `~1x` cost baseline. Benchmarks
 * are left empty (explicit unknown) rather than invented. Effort variants
 * override `relCostEstimate` to carry the effort-token uplift.
 */
const modelRouting = (provider: string, modelId: string): RoutingProfile => {
  const price = PRICES[`${provider}/${modelId}`]
  const capability = CAPABILITY[`${provider}/${modelId}`]
  return {
    ...(capability !== undefined && { capability }),
    ...(price !== undefined && {
      inputCostPerMTok: price.input,
      outputCostPerMTok: price.output,
    }),
    relCostEstimate: 1,
    relCostBasis: "manual-estimate",
    benchmarks: [],
  }
}

interface VariantSpec {
  readonly id: string
  readonly label: string
  readonly providerOptions?: ProviderOptions
  readonly generation?: GenerationOptions
  readonly relCostEstimate?: number
  readonly relCostBasis?: RelCostBasis
}

interface ModelSpec {
  readonly id: string
  readonly label: string
  readonly variants: ReadonlyArray<VariantSpec>
  readonly routing?: RoutingProfile
  readonly deprecated?: boolean
}

interface ProviderSpec {
  readonly id: string
  readonly label: string
  readonly popular: boolean
  readonly requiredFields: ReadonlyArray<CredentialField>
  readonly models: ReadonlyArray<ModelSpec>
  readonly build: (modelId: string, creds: ProviderConfig | undefined) => Model
}

const MANUAL: RelCostBasis = "manual-estimate"

const codexEffort = (effort: "low" | "medium" | "high", relCostEstimate: number): VariantSpec => ({
  id: effort,
  label: effort,
  providerOptions: { openaiCodex: { reasoning: { effort } } },
  relCostEstimate,
  relCostBasis: MANUAL,
})

// Anthropic adaptive-thinking effort ladder; xhigh is labelled "Extra" in the UI.
const anthropicEfforts: ReadonlyArray<{ effort: string; label: string; rel: number }> = [
  { effort: "low", label: "low", rel: 1 },
  { effort: "medium", label: "medium", rel: 2 },
  { effort: "high", label: "high", rel: 3 },
  { effort: "xhigh", label: "Extra", rel: 4 },
  { effort: "max", label: "max", rel: 5 },
]

const anthropicVariants: ReadonlyArray<VariantSpec> = anthropicEfforts.map(
  ({ effort, label, rel }) => ({
    id: effort,
    label,
    providerOptions: { anthropic: { thinking: { type: "adaptive", effort } } },
    relCostEstimate: rel,
    relCostBasis: MANUAL,
  }),
)

// DeepSeek V4 and Z.AI GLM-5.2 expose `off`, `high`, `max`; lower efforts clamp
// to `high`, so only these three rungs are distinct.
const gradedReasoningVariants = (providerKey: string): ReadonlyArray<VariantSpec> => [
  { id: "off", label: "off", relCostEstimate: 1, relCostBasis: MANUAL },
  {
    id: "high",
    label: "high",
    providerOptions: { [providerKey]: { thinking: true, reasoningEffort: "high" } },
    relCostEstimate: 2,
    relCostBasis: MANUAL,
  },
  {
    id: "max",
    label: "max",
    providerOptions: { [providerKey]: { thinking: true, reasoningEffort: "max" } },
    relCostEstimate: 3,
    relCostBasis: MANUAL,
  },
]

const CATALOG: ReadonlyArray<ProviderSpec> = [
  {
    id: "anthropic",
    label: "Anthropic",
    popular: true,
    requiredFields: ["apiKey"],
    models: [
      {
        id: "claude-opus-4-8",
        label: "Claude Opus 4.8",
        variants: anthropicVariants,
        routing: modelRouting("anthropic", "claude-opus-4-8"),
      },
      {
        id: "claude-sonnet-5",
        label: "Claude Sonnet 5",
        variants: anthropicVariants,
        routing: modelRouting("anthropic", "claude-sonnet-5"),
      },
    ],
    build: (modelId, creds) =>
      Anthropic.configure({
        ...(creds?.apiKey !== undefined && { apiKey: creds.apiKey }),
        ...(creds?.baseURL !== undefined && { baseURL: creds.baseURL }),
      }).model(modelId),
  },
  {
    id: "openai",
    label: "OpenAI",
    popular: true,
    requiredFields: ["apiKey"],
    models: [
      {
        id: "gpt-5.5",
        label: "ChatGPT 5.5",
        variants: [],
        routing: modelRouting("openai", "gpt-5.5"),
      },
      {
        id: "gpt-5.5-pro",
        label: "ChatGPT 5.5 Pro",
        variants: [],
        routing: modelRouting("openai", "gpt-5.5-pro"),
      },
      {
        id: "gpt-5.4-nano",
        label: "ChatGPT 5.4 nano",
        variants: [],
        routing: modelRouting("openai", "gpt-5.4-nano"),
      },
      {
        id: "gpt-5.4-mini",
        label: "ChatGPT 5.4 mini",
        variants: [],
        routing: modelRouting("openai", "gpt-5.4-mini"),
      },
    ],
    build: (modelId, creds) =>
      OpenAI.configure({
        ...(creds?.apiKey !== undefined && { apiKey: creds.apiKey }),
        ...(creds?.baseURL !== undefined && { baseURL: creds.baseURL }),
      }).chat(modelId),
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    popular: false,
    requiredFields: ["apiKey"],
    models: [
      {
        id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        variants: gradedReasoningVariants("deepseek"),
        routing: modelRouting("deepseek", "deepseek-v4-flash"),
      },
      {
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        variants: gradedReasoningVariants("deepseek"),
        routing: modelRouting("deepseek", "deepseek-v4-pro"),
      },
    ],
    build: (modelId, creds) =>
      DeepSeek.configure({
        ...(creds?.apiKey !== undefined && { apiKey: creds.apiKey }),
        ...(creds?.baseURL !== undefined && { baseURL: creds.baseURL }),
      }).chat(modelId),
  },
  {
    id: "zai",
    label: "Z.AI",
    popular: false,
    requiredFields: ["apiKey"],
    models: [
      {
        id: "glm-5.2",
        label: "GLM 5.2",
        variants: gradedReasoningVariants("zai"),
        routing: modelRouting("zai", "glm-5.2"),
      },
    ],
    build: (modelId, creds) =>
      ZAI.configure({
        ...(creds?.apiKey !== undefined && { apiKey: creds.apiKey }),
        ...(creds?.baseURL !== undefined && { baseURL: creds.baseURL }),
      }).chat(modelId),
  },
  {
    id: "openai-codex",
    label: "OpenAI Codex",
    popular: false,
    requiredFields: ["accessToken"],
    models: [
      {
        id: "gpt-5-codex",
        label: "GPT-5 Codex",
        variants: [codexEffort("low", 1), codexEffort("medium", 2), codexEffort("high", 3)],
        routing: modelRouting("openai-codex", "gpt-5-codex"),
      },
    ],
    build: (modelId, creds) =>
      OpenAICodex.configure({
        ...(creds?.accessToken !== undefined
          ? {
              credentialResolver: () => ({
                accessToken: creds.accessToken!,
                ...(creds.accountId !== undefined && { accountId: creds.accountId }),
              }),
            }
          : {}),
        ...(creds?.baseURL !== undefined && { baseURL: creds.baseURL }),
      }).model(modelId),
  },
]

const specById = (id: string): ProviderSpec | undefined => CATALOG.find((p) => p.id === id)

/**
 * A provider is configured only when the global config holds all its required
 * credentials. Provider env vars are deliberately ignored by the TUI; they are
 * reserved for standalone package smoke tests via the `llms` transport.
 */
const isConfigured = (spec: ProviderSpec, config: TuiConfig): boolean => {
  const stored = config.providers[spec.id]
  if (stored === undefined) return false
  return spec.requiredFields.every((field) => {
    const value = stored[field]
    return typeof value === "string" && value.length > 0
  })
}

export interface ProviderOption {
  readonly id: string
  readonly label: string
  readonly popular: boolean
  readonly configured: boolean
  readonly requiredFields: ReadonlyArray<CredentialField>
  readonly redactedKey?: string
}

export interface ModelVariantOption {
  readonly id: string
  readonly label: string
  readonly routing?: RoutingProfile
}

export interface ModelOption {
  readonly provider: string
  readonly providerLabel: string
  readonly modelId: string
  readonly label: string
  readonly variants: ReadonlyArray<ModelVariantOption>
  readonly routing?: RoutingProfile
}

/** Effective routing for a variant target: model base overlaid with variant cost. */
const variantRouting = (
  base: RoutingProfile | undefined,
  variant: VariantSpec,
): RoutingProfile | undefined => {
  if (base === undefined && variant.relCostEstimate === undefined) return undefined
  return {
    ...(base ?? { benchmarks: [] }),
    ...(variant.relCostEstimate !== undefined && { relCostEstimate: variant.relCostEstimate }),
    ...(variant.relCostBasis !== undefined && { relCostBasis: variant.relCostBasis }),
  }
}

/**
 * Derives the model-facing comparison signals from a routing profile. Missing
 * inputs surface as `undefined` rather than being silently zeroed:
 * `benchmarkAvg` is the mean of benchmark scores, and `aggregateCost` is
 * `relCostEstimate × (inputCostPerMTok × 4 + outputCostPerMTok × 1)`.
 */
export const aggregateRouting = (profile: RoutingProfile): RoutingAggregate => {
  const benchmarkAvg =
    profile.benchmarks.length > 0
      ? profile.benchmarks.reduce((sum, b) => sum + b.score, 0) / profile.benchmarks.length
      : undefined
  const tokenCost =
    profile.inputCostPerMTok !== undefined && profile.outputCostPerMTok !== undefined
      ? profile.inputCostPerMTok * 4 + profile.outputCostPerMTok
      : undefined
  const aggregateCost =
    profile.relCostEstimate !== undefined && tokenCost !== undefined
      ? profile.relCostEstimate * tokenCost
      : undefined
  return {
    ...(profile.capability !== undefined && { capability: profile.capability }),
    ...(benchmarkAvg !== undefined && { benchmarkAvg }),
    ...(profile.contextWindow !== undefined && { contextWindow: profile.contextWindow }),
    ...(aggregateCost !== undefined && { aggregateCost }),
    ...(profile.relCostBasis !== undefined && { relCostBasis: profile.relCostBasis }),
  }
}

const toProviderOption = (spec: ProviderSpec, config: TuiConfig): ProviderOption => {
  const stored = config.providers[spec.id]
  return {
    id: spec.id,
    label: spec.label,
    popular: spec.popular,
    configured: isConfigured(spec, config),
    requiredFields: spec.requiredFields,
    ...(stored?.apiKey !== undefined && { redactedKey: redactKey(stored.apiKey) }),
  }
}

const toModelOptions = (spec: ProviderSpec): ReadonlyArray<ModelOption> =>
  spec.models
    .filter((model) => model.deprecated !== true)
    .map((model) => ({
      provider: spec.id,
      providerLabel: spec.label,
      modelId: model.id,
      label: model.label,
      ...(model.routing !== undefined && { routing: model.routing }),
      variants: model.variants.map((v) => {
        const routing = variantRouting(model.routing, v)
        return { id: v.id, label: v.label, ...(routing !== undefined && { routing }) }
      }),
    }))

/** Every routable catalog model (non-deprecated), independent of configuration. */
export const allCatalogModels = (): ReadonlyArray<ModelOption> => CATALOG.flatMap(toModelOptions)

/** Every static provider the TUI knows how to configure. */
export const allProviders = (
  config: TuiConfig = { providers: {} },
): ReadonlyArray<ProviderOption> => CATALOG.map((spec) => toProviderOption(spec, config))

/** Every provider `/connect` should display; currently all static providers. */
export const connectableProviders = (
  config: TuiConfig = { providers: {} },
): ReadonlyArray<ProviderOption> => allProviders(config)

/** Providers usable from stored config. */
export const configuredProviders = (config: TuiConfig): ReadonlyArray<ProviderOption> =>
  CATALOG.filter((spec) => isConfigured(spec, config)).map((spec) => toProviderOption(spec, config))

/** Models shown by `/model`: configured providers, non-deprecated models. */
export const availableModels = (config: TuiConfig): ReadonlyArray<ModelOption> =>
  CATALOG.filter((spec) => isConfigured(spec, config)).flatMap(toModelOptions)

export class ModelSelectionError extends Data.TaggedError("ModelSelectionError")<{
  readonly reason:
    | "unknown-provider"
    | "provider-not-configured"
    | "unknown-model"
    | "unknown-variant"
  readonly message: string
}> {}

export interface ModelSelection {
  readonly model: Model
  readonly provider: string
  readonly modelId: string
  readonly variant?: string
  readonly requestOptions: {
    readonly providerOptions?: ProviderOptions
    readonly generation?: GenerationOptions
  }
}

export type ResolveResult =
  | { readonly type: "ok"; readonly selection: ModelSelection }
  | { readonly type: "error"; readonly error: ModelSelectionError }

const fail = (reason: ModelSelectionError["reason"], message: string): ResolveResult => ({
  type: "error",
  error: new ModelSelectionError({ reason, message }),
})

/**
 * Validates a `(provider, modelId, variant?)` selection against the static
 * catalog and stored config, then builds the live `Model` and lowers the
 * variant to provider-specific request options for `core.runTurn()`. Unknown
 * providers/models/variants and unconfigured providers are rejected rather than
 * silently downgraded.
 */
export const resolveModelSelection = (
  provider: string,
  modelId: string,
  variant: string | undefined,
  config: TuiConfig,
): ResolveResult => {
  const spec = specById(provider)
  if (spec === undefined) return fail("unknown-provider", `Unknown provider "${provider}".`)
  if (!isConfigured(spec, config)) {
    return fail("provider-not-configured", `Provider "${provider}" is not configured.`)
  }
  const model = spec.models.find((m) => m.id === modelId)
  if (model === undefined || model.deprecated === true) {
    return fail("unknown-model", `Unknown model "${modelId}" for provider "${provider}".`)
  }
  let variantSpec: VariantSpec | undefined
  if (variant !== undefined) {
    variantSpec = model.variants.find((v) => v.id === variant)
    if (variantSpec === undefined) {
      return fail("unknown-variant", `Unknown variant "${variant}" for model "${modelId}".`)
    }
  }
  const requestOptions = {
    ...(variantSpec?.providerOptions !== undefined && {
      providerOptions: variantSpec.providerOptions,
    }),
    ...(variantSpec?.generation !== undefined && { generation: variantSpec.generation }),
  }
  return {
    type: "ok",
    selection: {
      model: spec.build(modelId, config.providers[spec.id]),
      provider,
      modelId,
      ...(variant !== undefined && { variant }),
      requestOptions,
    },
  }
}

/** Default model id for a configured provider, used for startup fallback. */
export const defaultModelId = (provider: string): string | undefined =>
  specById(provider)?.models.find((m) => m.deprecated !== true)?.id

/**
 * Keyless, free model for background chores (e.g. summarizing sessions) when the
 * user has no provider configured. Backed by Pollinations; best-effort.
 */
export const freeModel = (): Model => Pollinations.model("openai-fast")

/** Estimated USD cost for token usage, or undefined when the model is unpriced. */
export const costUsd = (
  provider: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined => {
  const price = PRICES[`${provider}/${modelId}`]
  if (price === undefined) return undefined
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000
}
