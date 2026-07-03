import type { Model, ProviderOptions } from "../schema"
import { OpenAICompatible } from "./openai-compatible"
import type { OpenAICompatibleFacade } from "./openai-compatible"

export const DEEPSEEK_PROVIDER_ID = "deepseek"
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com"

/** DeepSeek documents `temperature`/`top_p`; it does not document `seed`. */
export interface DeepSeekOptions {
  readonly temperature?: number
  readonly topP?: number
}

export interface DeepSeekConfig {
  readonly apiKey?: string
  readonly baseURL?: string
  readonly headers?: Record<string, string>
}

/** Thin profile over `OpenAICompatible` for DeepSeek Chat Completions. */
const configure = (config: DeepSeekConfig = {}): OpenAICompatibleFacade =>
  OpenAICompatible.configure({
    providerId: DEEPSEEK_PROVIDER_ID,
    baseURL: config.baseURL ?? DEEPSEEK_BASE_URL,
    apiKeyEnv: "DEEPSEEK_API_KEY",
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
  })

const model = (modelId: string): Model => configure().chat(modelId)

const options = (input: DeepSeekOptions): ProviderOptions =>
  OpenAICompatible.options(DEEPSEEK_PROVIDER_ID, input)

export const DeepSeek = {
  configure,
  model,
  options,
}
