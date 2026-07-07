import type { GenerationOptions, Model, ProviderOptions } from "@swain/llms"
import { Anthropic, DeepSeek, OpenAI, OpenAICodex, Pollinations, ZAI } from "@swain/llms/providers"
import { Data } from "effect"
import type { ProviderConfig, TuiConfig } from "./config"
import { redactKey } from "./config"

export type CredentialField = "apiKey" | "baseURL" | "accountId" | "accessToken"

interface VariantSpec {
  readonly id: string
  readonly label: string
  readonly providerOptions?: ProviderOptions
  readonly generation?: GenerationOptions
}

interface ModelSpec {
  readonly id: string
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

const codexEffort = (effort: "low" | "medium" | "high"): VariantSpec => ({
  id: effort,
  label: effort,
  providerOptions: { openaiCodex: { reasoning: { effort } } },
})

const CATALOG: ReadonlyArray<ProviderSpec> = [
  {
    id: "anthropic",
    label: "Anthropic",
    popular: true,
    requiredFields: ["apiKey"],
    models: [
      { id: "claude-opus-4-8", label: "Claude Opus 4.8", variants: [] },
      {
        id: "claude-sonnet-5",
        label: "Claude Sonnet 5",
        variants: [
          {
            id: "thinking",
            label: "extended thinking",
            providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 8192 } } },
          },
        ],
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
      { id: "gpt-5.5", label: "ChatGPT 5.5", variants: [] },
      { id: "gpt-5.5-pro", label: "ChatGPT 5.5 Pro", variants: [] },
      { id: "gpt-5.4-nano", label: "ChatGPT 5.4 nano", variants: [] },
      { id: "gpt-5.4-mini", label: "ChatGPT 5.4 mini", variants: [] },
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
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", variants: [] },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", variants: [] },
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
    models: [{ id: "glm-5.2", label: "GLM 5.2", variants: [] }],
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
    requiredFields: ["accessToken", "accountId"],
    models: [
      {
        id: "gpt-5-codex",
        label: "GPT-5 Codex",
        variants: [codexEffort("low"), codexEffort("medium"), codexEffort("high")],
      },
    ],
    build: (modelId, creds) =>
      OpenAICodex.configure({
        ...(creds?.accessToken !== undefined && creds.accountId !== undefined
          ? {
              credentialResolver: () => ({
                accessToken: creds.accessToken!,
                accountId: creds.accountId!,
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
}

export interface ModelOption {
  readonly provider: string
  readonly providerLabel: string
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
      modelId: model.id,
      label: model.label,
      variants: model.variants.map((v) => ({ id: v.id, label: v.label })),
    }))

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
