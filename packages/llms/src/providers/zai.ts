import type { Model, ProviderOptions } from "../schema"
import { OpenAICompatible } from "./openai-compatible"
import type { OpenAICompatibleFacade } from "./openai-compatible"

export const ZAI_PROVIDER_ID = "zai"
export const ZAI_BASE_URL = "https://api.z.ai/api/paas/v4"

/** Z.AI documents `temperature`/`top_p`; it does not document `seed`. */
export interface ZAIOptions {
  readonly temperature?: number
  readonly topP?: number
}

export interface ZAIConfig {
  readonly apiKey?: string
  /** Overridable for GLM Coding Plan endpoints. */
  readonly baseURL?: string
  readonly headers?: Record<string, string>
}

/** Thin profile over `OpenAICompatible` for Z.AI's OpenAI-compatible API. */
const configure = (config: ZAIConfig = {}): OpenAICompatibleFacade =>
  OpenAICompatible.configure({
    providerId: ZAI_PROVIDER_ID,
    baseURL: config.baseURL ?? ZAI_BASE_URL,
    apiKeyEnv: "ZAI_API_KEY",
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
  })

const model = (modelId: string): Model => configure().chat(modelId)

const options = (input: ZAIOptions): ProviderOptions =>
  OpenAICompatible.options(ZAI_PROVIDER_ID, input)

export const ZAI = {
  configure,
  model,
  options,
}
