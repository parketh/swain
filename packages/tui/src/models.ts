import type { GenerationOptions, Model, ProviderOptions } from "@swain/llms"
import { Lab, Provider } from "@swain/llms"
import {
  AnthropicModel,
  AnthropicModelVariants,
  DeepSeekModel,
  DeepSeekModelVariants,
  OpenAIModel,
  OpenAIModelVariants,
  ZAIModel,
  ZAIModelVariants,
} from "@swain/llms/models"
import {
  Anthropic as AnthropicProvider,
  DeepSeek as DeepSeekProvider,
  OpenAICodex as OpenAICodexProvider,
  OpenAI as OpenAIProvider,
  Pollinations,
  ZAI as ZAIProvider,
} from "@swain/llms/providers"
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

// Hard-coded routing metadata per model, keyed by model id. `input`/`output`
// are published list prices per 1M tokens (USD, standard tier, 2026-07 docs;
// cache/batch discounts aren't modelled, so a computed cost is an upper bound).
// `capability` is a rough 0-100 tier, a manual estimate pending real benchmark
// data (benchmarks stay empty until measured values are supplied).
interface ModelRoutingData {
  readonly input: number
  readonly output: number
  readonly capability: number
}

const ROUTING: Record<string, ModelRoutingData> = {
  [AnthropicModel.Claude_Opus_4_8]: { input: 5, output: 25, capability: 95 },
  [OpenAIModel.GPT_5_5]: { input: 5, output: 30, capability: 87 },
  [OpenAIModel.GPT_5_5_Pro]: { input: 30, output: 180, capability: 93 },
  [DeepSeekModel.V4_Flash]: { input: 0.14, output: 0.28, capability: 68 },
  [DeepSeekModel.V4_Pro]: { input: 0.44, output: 0.87, capability: 80 },
  [ZAIModel.GLM_5_2]: { input: 1.4, output: 4.4, capability: 75 },
}

/**
 * Base routing profile for a model's default (lowest/no-effort) target: known
 * token prices, a rough capability tier, and a `~1x` cost baseline. Benchmarks
 * are left empty (explicit unknown) rather than invented. Effort variants
 * override `relCostEstimate` to carry the effort-token uplift.
 */
const modelRouting = (modelId: string): RoutingProfile => {
  const data = ROUTING[modelId]
  return {
    ...(data !== undefined && {
      capability: data.capability,
      inputCostPerMTok: data.input,
      outputCostPerMTok: data.output,
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
  /** The lab that created this model, independent of the serving provider. */
  readonly lab: Lab
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

// Rough effort-token cost multiplier by rung; higher effort ≈ more tokens.
const EFFORT_REL: Record<string, number> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 }
const effortLabel = (effort: string): string => (effort === "xhigh" ? "Extra" : effort)

// Anthropic adaptive-thinking variants for a model's supported effort levels.
const anthropicVariants = (model: AnthropicModel): ReadonlyArray<VariantSpec> =>
  AnthropicModelVariants[model].map((effort) => ({
    id: effort,
    label: effortLabel(effort),
    providerOptions: { anthropic: { thinking: { type: "adaptive", effort } } },
    relCostEstimate: EFFORT_REL[effort],
    relCostBasis: MANUAL,
  }))

// OpenAI reasoning-effort variants via the chat API's `reasoning_effort`.
const openaiVariants = (model: OpenAIModel): ReadonlyArray<VariantSpec> =>
  OpenAIModelVariants[model].map((effort) => ({
    id: effort,
    label: effortLabel(effort),
    providerOptions: { openai: { reasoningEffort: effort } },
    relCostEstimate: EFFORT_REL[effort],
    relCostBasis: MANUAL,
  }))

// The Codex provider serves the same OpenAI models via the Responses API.
const codexVariants = (model: OpenAIModel): ReadonlyArray<VariantSpec> =>
  OpenAIModelVariants[model].map((effort) => ({
    id: effort,
    label: effortLabel(effort),
    providerOptions: { openaiCodex: { reasoning: { effort } } },
    relCostEstimate: EFFORT_REL[effort],
    relCostBasis: MANUAL,
  }))

// DeepSeek/Z.AI graded reasoning: a thinking flag plus the effort level.
const gradedVariants = (
  providerKey: string,
  efforts: ReadonlyArray<"high" | "max">,
): ReadonlyArray<VariantSpec> =>
  efforts.map((effort) => ({
    id: effort,
    label: effort,
    providerOptions: { [providerKey]: { thinking: true, reasoningEffort: effort } },
    relCostEstimate: EFFORT_REL[effort],
    relCostBasis: MANUAL,
  }))

const CATALOG: ReadonlyArray<ProviderSpec> = [
  {
    id: Provider.Anthropic,
    label: "Anthropic",
    popular: true,
    requiredFields: ["apiKey"],
    models: [
      {
        id: AnthropicModel.Claude_Opus_4_8,
        lab: Lab.Anthropic,
        label: "Claude Opus 4.8",
        variants: anthropicVariants(AnthropicModel.Claude_Opus_4_8),
        routing: modelRouting(AnthropicModel.Claude_Opus_4_8),
      },
    ],
    build: (modelId, creds) =>
      AnthropicProvider.configure({
        ...(creds?.apiKey !== undefined && { apiKey: creds.apiKey }),
        ...(creds?.baseURL !== undefined && { baseURL: creds.baseURL }),
      }).model(modelId),
  },
  {
    id: Provider.OpenAI,
    label: "OpenAI",
    popular: true,
    requiredFields: ["apiKey"],
    models: [
      {
        id: OpenAIModel.GPT_5_5,
        lab: Lab.OpenAI,
        label: "ChatGPT 5.5",
        variants: openaiVariants(OpenAIModel.GPT_5_5),
        routing: modelRouting(OpenAIModel.GPT_5_5),
      },
      {
        id: OpenAIModel.GPT_5_5_Pro,
        lab: Lab.OpenAI,
        label: "ChatGPT 5.5 Pro",
        variants: openaiVariants(OpenAIModel.GPT_5_5_Pro),
        routing: modelRouting(OpenAIModel.GPT_5_5_Pro),
      },
    ],
    build: (modelId, creds) =>
      OpenAIProvider.configure({
        ...(creds?.apiKey !== undefined && { apiKey: creds.apiKey }),
        ...(creds?.baseURL !== undefined && { baseURL: creds.baseURL }),
      }).chat(modelId),
  },
  {
    id: Provider.DeepSeek,
    label: "DeepSeek",
    popular: false,
    requiredFields: ["apiKey"],
    models: [
      {
        id: DeepSeekModel.V4_Flash,
        lab: Lab.DeepSeek,
        label: "DeepSeek V4 Flash",
        variants: gradedVariants(Provider.DeepSeek, DeepSeekModelVariants[DeepSeekModel.V4_Flash]),
        routing: modelRouting(DeepSeekModel.V4_Flash),
      },
      {
        id: DeepSeekModel.V4_Pro,
        lab: Lab.DeepSeek,
        label: "DeepSeek V4 Pro",
        variants: gradedVariants(Provider.DeepSeek, DeepSeekModelVariants[DeepSeekModel.V4_Pro]),
        routing: modelRouting(DeepSeekModel.V4_Pro),
      },
    ],
    build: (modelId, creds) =>
      DeepSeekProvider.configure({
        ...(creds?.apiKey !== undefined && { apiKey: creds.apiKey }),
        ...(creds?.baseURL !== undefined && { baseURL: creds.baseURL }),
      }).chat(modelId),
  },
  {
    id: Provider.ZAI,
    label: "Z.AI",
    popular: false,
    requiredFields: ["apiKey"],
    models: [
      {
        id: ZAIModel.GLM_5_2,
        lab: Lab.ZAI,
        label: "GLM 5.2",
        variants: gradedVariants(Provider.ZAI, ZAIModelVariants[ZAIModel.GLM_5_2]),
        routing: modelRouting(ZAIModel.GLM_5_2),
      },
    ],
    build: (modelId, creds) =>
      ZAIProvider.configure({
        ...(creds?.apiKey !== undefined && { apiKey: creds.apiKey }),
        ...(creds?.baseURL !== undefined && { baseURL: creds.baseURL }),
      }).chat(modelId),
  },
  {
    // Codex is a second provider serving OpenAI's models (a 2:1 mapping): it
    // exposes gpt-5.5 with the same reasoning ladder via the Responses API.
    id: Provider.OpenAICodex,
    label: "OpenAI Codex",
    popular: false,
    requiredFields: ["accessToken"],
    models: [
      {
        id: OpenAIModel.GPT_5_5,
        lab: Lab.OpenAI,
        label: "GPT-5.5",
        variants: codexVariants(OpenAIModel.GPT_5_5),
        routing: modelRouting(OpenAIModel.GPT_5_5),
      },
    ],
    build: (modelId, creds) =>
      OpenAICodexProvider.configure({
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
  /** The lab that created this model, independent of the serving provider. */
  readonly lab: Lab
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
      lab: model.lab,
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
  _provider: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined => {
  const data = ROUTING[modelId]
  if (data === undefined) return undefined
  return (inputTokens * data.input + outputTokens * data.output) / 1_000_000
}
