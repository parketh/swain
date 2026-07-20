import type { Model, ProviderOptions } from "../schema"
import { Provider } from "../schema"
import type { OpenAICompatibleFacade } from "./openai-compatible"
import { OpenAICompatible } from "./openai-compatible"

export const KIMI_PROVIDER_ID = Provider.Kimi
export const KIMI_BASE_URL = "https://api.moonshot.ai/v1"

/**
 * Kimi K3 fixes its sampling configuration and does not accept `temperature`;
 * only the reasoning effort is exposed, and K3 currently accepts only `"max"`.
 */
export interface KimiOptions {
  readonly reasoningEffort?: "max"
}

export interface KimiConfig {
  readonly apiKey?: string
  readonly baseURL?: string
  readonly headers?: Record<string, string>
}

/**
 * Thin profile over `OpenAICompatible` for Moonshot's pay-as-you-go Chat
 * Completions. K3 requires historical reasoning replayed as `reasoning_content`
 * and uses `max_completion_tokens` for the output limit.
 */
const configure = (config: KimiConfig = {}): OpenAICompatibleFacade =>
  OpenAICompatible.configure({
    providerId: KIMI_PROVIDER_ID,
    baseURL: config.baseURL ?? KIMI_BASE_URL,
    apiKeyEnv: "MOONSHOT_API_KEY",
    reasoningHistory: "reasoning_content",
    maxTokensField: "max_completion_tokens",
    warnOnReasoningLoss: true,
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
  })

const model = (modelId: string): Model => configure().chat(modelId)

const options = (input: KimiOptions): ProviderOptions =>
  OpenAICompatible.options(KIMI_PROVIDER_ID, input)

export const Kimi = {
  configure,
  model,
  options,
}
