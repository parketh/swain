import type { GenerationOptions, Model, ProviderOptions } from "@swain/llms"
import { Lab, Provider } from "@swain/llms"
import {
  AnthropicModel,
  AnthropicModelVariants,
  AnthropicVariant,
  DeepSeekModel,
  DeepSeekModelVariants,
  DeepSeekVariant,
  OpenAIModel,
  OpenAIModelVariants,
  OpenAIVariant,
  ZAIModel,
  ZAIModelVariants,
  ZAIVariant,
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

/** Router comparison signals for a single model variant. */
export interface RoutingProfile {
  /** Rough 0-100 capability tier; higher is better. */
  readonly capability?: number
  /** Weighted average cost per task in USD; higher effort ≈ higher cost. */
  readonly avgCostPerTask?: number
}

// No published routing data for this variant. An empty profile (no capability or
// cost) marks it "no data": the router excludes it rather than routing on
// fabricated numbers, while it stays selectable manually via `/model`.
const p = (): RoutingProfile => ({})

// Data per Artificial Analysis (AA): https://artificialanalysis.ai
const ROUTING: Record<string, Record<string, RoutingProfile>> = {
  // AA does not publish Anthropic model effort-variant benchmarks, so we scale the 'Max' model
  // score by effort-level benchmark scores (specifically Humanity's Last Exam) from Anthropic's
  // Fable 5 System Card.
  // https://www.anthropic.com/system-cards
  [AnthropicModel.Claude_Opus_4_8]: {
    [AnthropicVariant.Low]: { capability: 48.6, avgCostPerTask: 0.41 },
    [AnthropicVariant.Medium]: { capability: 53.4, avgCostPerTask: 0.62 },
    [AnthropicVariant.High]: { capability: 53.9, avgCostPerTask: 0.77 },
    [AnthropicVariant.XHigh]: { capability: 55.7, avgCostPerTask: 1.43 },
    [AnthropicVariant.Max]: { capability: 56, avgCostPerTask: 1.8 },
  },
  [OpenAIModel.GPT_5_5]: {
    [OpenAIVariant.Low]: { capability: 43, avgCostPerTask: 0.19 },
    [OpenAIVariant.Medium]: { capability: 50, avgCostPerTask: 0.34 },
    [OpenAIVariant.High]: { capability: 53, avgCostPerTask: 0.61 },
    [OpenAIVariant.XHigh]: { capability: 55, avgCostPerTask: 0.86 },
  },
  // AA does not publish benchmarks for GPT-5.5 Pro which is in any case only used through for
  // the ChatGPT web interface and not for Codex.
  [OpenAIModel.GPT_5_5_Pro]: {
    [OpenAIVariant.Medium]: p(),
    [OpenAIVariant.High]: p(),
    [OpenAIVariant.XHigh]: p(),
  },
  [OpenAIModel.GPT_5_6_Sol]: {
    [OpenAIVariant.Low]: { capability: 49, avgCostPerTask: 0.2 },
    [OpenAIVariant.Medium]: { capability: 54, avgCostPerTask: 0.31 },
    [OpenAIVariant.High]: { capability: 56, avgCostPerTask: 0.45 },
    [OpenAIVariant.XHigh]: { capability: 59, avgCostPerTask: 1.04 },
  },
  [OpenAIModel.GPT_5_6_Terra]: {
    [OpenAIVariant.Low]: { capability: 40, avgCostPerTask: 0.1 },
    [OpenAIVariant.Medium]: { capability: 46, avgCostPerTask: 0.13 },
    [OpenAIVariant.High]: { capability: 49, avgCostPerTask: 0.24 },
    [OpenAIVariant.XHigh]: { capability: 55, avgCostPerTask: 0.55 },
  },
  [OpenAIModel.GPT_5_6_Luna]: {
    [OpenAIVariant.Low]: { capability: 33, avgCostPerTask: 0.04 },
    [OpenAIVariant.Medium]: { capability: 38, avgCostPerTask: 0.05 },
    [OpenAIVariant.High]: { capability: 46, avgCostPerTask: 0.09 },
    [OpenAIVariant.XHigh]: { capability: 51, avgCostPerTask: 0.21 },
  },
  // AA does not publish avgCostPerTask for DeepSeek High variants. Assumed same cost as Max variant
  // given similar capability scores.
  [DeepSeekModel.V4_Flash]: {
    [DeepSeekVariant.High]: { capability: 37, avgCostPerTask: 0.02 },
    [DeepSeekVariant.Max]: { capability: 40, avgCostPerTask: 0.02 },
  },
  [DeepSeekModel.V4_Pro]: {
    [DeepSeekVariant.High]: { capability: 41, avgCostPerTask: 0.04 },
    [DeepSeekVariant.Max]: { capability: 44, avgCostPerTask: 0.04 },
  },
  // AA does not publish data for Z.AI High variant
  [ZAIModel.GLM_5_2]: {
    [ZAIVariant.High]: p(),
    [ZAIVariant.Max]: { capability: 51, avgCostPerTask: 0.37 },
  },
}

/** Routing signals for a model variant, or `undefined` when none are recorded. */
const routingFor = (modelId: string, variant: string): RoutingProfile | undefined =>
  ROUTING[modelId]?.[variant]

// Published list prices per 1M tokens (USD), for the usage-cost display only
// (distinct from routing's avgCostPerTask). Standard tier.
const PRICES: Record<string, { readonly input: number; readonly output: number }> = {
  [AnthropicModel.Claude_Opus_4_8]: { input: 5, output: 25 },
  [OpenAIModel.GPT_5_5]: { input: 5, output: 30 },
  [OpenAIModel.GPT_5_5_Pro]: { input: 30, output: 180 },
  [OpenAIModel.GPT_5_6_Sol]: { input: 5, output: 30 },
  [OpenAIModel.GPT_5_6_Terra]: { input: 2.5, output: 15 },
  [OpenAIModel.GPT_5_6_Luna]: { input: 1, output: 6 },
  [DeepSeekModel.V4_Flash]: { input: 0.14, output: 0.28 },
  [DeepSeekModel.V4_Pro]: { input: 0.44, output: 0.87 },
  [ZAIModel.GLM_5_2]: { input: 1.4, output: 4.4 },
}

interface VariantSpec {
  readonly id: string
  readonly label: string
  readonly providerOptions?: ProviderOptions
  readonly generation?: GenerationOptions
  readonly routing?: RoutingProfile
}

interface ModelSpec {
  readonly id: string
  /** The lab that created this model, independent of the serving provider. */
  readonly lab: Lab
  readonly label: string
  readonly variants: ReadonlyArray<VariantSpec>
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

const effortLabel = (effort: string): string => (effort === "xhigh" ? "Extra" : effort)

const withRouting = (modelId: string, effort: string, base: VariantSpec): VariantSpec => {
  const routing = routingFor(modelId, effort)
  return { ...base, ...(routing !== undefined && { routing }) }
}

// Anthropic adaptive-thinking variants for a model's supported effort levels.
const anthropicVariants = (model: AnthropicModel): ReadonlyArray<VariantSpec> =>
  AnthropicModelVariants[model].map((effort) =>
    withRouting(model, effort, {
      id: effort,
      label: effortLabel(effort),
      providerOptions: { anthropic: { thinking: { type: "adaptive", effort } } },
    }),
  )

// OpenAI reasoning-effort variants via the chat API's `reasoning_effort`.
const openaiVariants = (model: OpenAIModel): ReadonlyArray<VariantSpec> =>
  OpenAIModelVariants[model].map((effort) =>
    withRouting(model, effort, {
      id: effort,
      label: effortLabel(effort),
      providerOptions: { openai: { reasoningEffort: effort } },
    }),
  )

// The Codex provider serves the same OpenAI models via the Responses API.
const codexVariants = (model: OpenAIModel): ReadonlyArray<VariantSpec> =>
  OpenAIModelVariants[model].map((effort) =>
    withRouting(model, effort, {
      id: effort,
      label: effortLabel(effort),
      providerOptions: { openaiCodex: { reasoning: { effort } } },
    }),
  )

// DeepSeek/Z.AI graded reasoning: a thinking flag plus the effort level.
const gradedVariants = (
  modelId: string,
  providerKey: string,
  efforts: ReadonlyArray<"high" | "max">,
): ReadonlyArray<VariantSpec> =>
  efforts.map((effort) =>
    withRouting(modelId, effort, {
      id: effort,
      label: effort,
      providerOptions: { [providerKey]: { thinking: true, reasoningEffort: effort } },
    }),
  )

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
      },
      {
        id: OpenAIModel.GPT_5_5_Pro,
        lab: Lab.OpenAI,
        label: "ChatGPT 5.5 Pro",
        variants: openaiVariants(OpenAIModel.GPT_5_5_Pro),
      },
      {
        id: OpenAIModel.GPT_5_6_Sol,
        lab: Lab.OpenAI,
        label: "ChatGPT 5.6 Sol",
        variants: openaiVariants(OpenAIModel.GPT_5_6_Sol),
      },
      {
        id: OpenAIModel.GPT_5_6_Terra,
        lab: Lab.OpenAI,
        label: "ChatGPT 5.6 Terra",
        variants: openaiVariants(OpenAIModel.GPT_5_6_Terra),
      },
      {
        id: OpenAIModel.GPT_5_6_Luna,
        lab: Lab.OpenAI,
        label: "ChatGPT 5.6 Luna",
        variants: openaiVariants(OpenAIModel.GPT_5_6_Luna),
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
        variants: gradedVariants(
          DeepSeekModel.V4_Flash,
          Provider.DeepSeek,
          DeepSeekModelVariants[DeepSeekModel.V4_Flash],
        ),
      },
      {
        id: DeepSeekModel.V4_Pro,
        lab: Lab.DeepSeek,
        label: "DeepSeek V4 Pro",
        variants: gradedVariants(
          DeepSeekModel.V4_Pro,
          Provider.DeepSeek,
          DeepSeekModelVariants[DeepSeekModel.V4_Pro],
        ),
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
        variants: gradedVariants(
          ZAIModel.GLM_5_2,
          Provider.ZAI,
          ZAIModelVariants[ZAIModel.GLM_5_2],
        ),
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
      },
      {
        id: OpenAIModel.GPT_5_6_Sol,
        lab: Lab.OpenAI,
        label: "GPT-5.6 Sol",
        variants: codexVariants(OpenAIModel.GPT_5_6_Sol),
      },
      {
        id: OpenAIModel.GPT_5_6_Terra,
        lab: Lab.OpenAI,
        label: "GPT-5.6 Terra",
        variants: codexVariants(OpenAIModel.GPT_5_6_Terra),
      },
      {
        id: OpenAIModel.GPT_5_6_Luna,
        lab: Lab.OpenAI,
        label: "GPT-5.6 Luna",
        variants: codexVariants(OpenAIModel.GPT_5_6_Luna),
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
      variants: model.variants.map((v) => ({
        id: v.id,
        label: v.label,
        ...(v.routing !== undefined && { routing: v.routing }),
      })),
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
  const price = PRICES[modelId]
  if (price === undefined) return undefined
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000
}
