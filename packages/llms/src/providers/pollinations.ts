import type { Model, ProviderOptions } from "../schema"
import type { OpenAICompatibleFacade } from "./openai-compatible"
import { OpenAICompatible } from "./openai-compatible"

export const POLLINATIONS_PROVIDER_ID = "pollinations"
export const POLLINATIONS_BASE_URL = "https://text.pollinations.ai/openai"

export interface PollinationsOptions {
  readonly temperature?: number
  readonly topP?: number
  readonly seed?: number
}

export interface PollinationsConfig {
  readonly baseURL?: string
  readonly headers?: Record<string, string>
}

/**
 * Keyless, free OpenAI-compatible endpoint (Pollinations). No credentials are
 * sent; it rejects `stream_options`, so usage reporting is disabled. Best-effort
 * availability — intended as a zero-setup fallback, not a primary provider.
 */
const configure = (config: PollinationsConfig = {}): OpenAICompatibleFacade =>
  OpenAICompatible.configure({
    providerId: POLLINATIONS_PROVIDER_ID,
    baseURL: config.baseURL ?? POLLINATIONS_BASE_URL,
    auth: "none",
    includeUsage: false,
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
  })

const model = (modelId: string): Model => configure().chat(modelId)

const options = (input: PollinationsOptions): ProviderOptions =>
  OpenAICompatible.options(POLLINATIONS_PROVIDER_ID, input)

export const Pollinations = {
  configure,
  model,
  options,
}
