import type { Model, ProviderOptions } from "../schema"
import { Provider } from "../schema"
import type { OpenAICompatibleFacade } from "./openai-compatible"
import { OpenAICompatible } from "./openai-compatible"

export const OPENAI_PROVIDER_ID = Provider.OpenAI
export const OPENAI_BASE_URL = "https://api.openai.com/v1"

/** OpenAI-specific request options; sampling knobs apply only to models that accept them. */
export interface OpenAIOptions {
  readonly temperature?: number
  readonly topP?: number
  readonly seed?: number
}

export interface OpenAIConfig {
  readonly apiKey?: string
  readonly baseURL?: string
  readonly headers?: Record<string, string>
}

export interface OpenAIFacade {
  readonly providerId: OpenAICompatibleFacade["providerId"]
  readonly baseURL: string
  chat(modelId: string): Model
  options(input: OpenAIOptions): ProviderOptions
}

/** Thin profile over `OpenAICompatible` for the OpenAI API. */
const configure = (config: OpenAIConfig = {}): OpenAIFacade =>
  OpenAICompatible.configure({
    providerId: OPENAI_PROVIDER_ID,
    baseURL: config.baseURL ?? OPENAI_BASE_URL,
    apiKeyEnv: "OPENAI_API_KEY",
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
  })

const options = (input: OpenAIOptions): ProviderOptions =>
  OpenAICompatible.options(OPENAI_PROVIDER_ID, input)

export const OpenAI = {
  configure,
  options,
}
