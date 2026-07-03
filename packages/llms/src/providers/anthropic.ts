import { Effect, Stream } from "effect"
import { AnthropicMessages } from "../protocols"
import type { AnthropicMessagesRequest, AnthropicOptions } from "../protocols"
import { ModelId, ProviderId } from "../schema"
import type { LLMRequest, Model, ProviderOptions } from "../schema"
import { Auth, Http } from "../transport"

export const ANTHROPIC_PROVIDER_ID = "anthropic"
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1"

export type { AnthropicOptions }

export interface AnthropicConfig {
  readonly apiKey?: string
  readonly baseURL?: string
  readonly headers?: Record<string, string>
  /** Default `max_tokens` when the request carries none. Defaults to 4096. */
  readonly maxTokens?: number
}

export interface AnthropicFacade {
  readonly providerId: ProviderId
  readonly baseURL: string
  model(modelId: string): Model
  options(input: AnthropicOptions): ProviderOptions
}

const toProtocolRequest = (modelId: string, request: LLMRequest): AnthropicMessagesRequest => ({
  modelId,
  messages: request.messages,
  ...(request.system !== undefined ? { system: request.system } : {}),
  ...(request.tools !== undefined ? { tools: request.tools } : {}),
  ...(request.toolChoice !== undefined ? { toolChoice: request.toolChoice } : {}),
  ...(request.generation !== undefined ? { generation: request.generation } : {}),
  ...(request.providerOptions !== undefined ? { providerOptions: request.providerOptions } : {}),
})

/**
 * Facade for the Anthropic Messages API. Auth resolves lazily at execution,
 * so missing credentials fail the returned stream with `auth-failed` instead
 * of throwing at configure time.
 */
const configure = (config: AnthropicConfig = {}): AnthropicFacade => {
  const baseURL = (config.baseURL ?? ANTHROPIC_BASE_URL).replace(/\/+$/, "")
  const provider = ProviderId.make(ANTHROPIC_PROVIDER_ID)
  return {
    providerId: provider,
    baseURL,
    options: (input) => ({ [ANTHROPIC_PROVIDER_ID]: input }),
    model: (modelId) => ({
      id: ModelId.make(modelId),
      provider,
      streamTurn: (request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const apiKey = yield* Auth.resolveSecret({
              ...(config.apiKey !== undefined ? { value: config.apiKey } : {}),
              env: "ANTHROPIC_API_KEY",
              subject: ANTHROPIC_PROVIDER_ID,
            })
            const prepared = yield* AnthropicMessages.prepare(
              toProtocolRequest(modelId, request),
              config.maxTokens !== undefined ? { defaultMaxTokens: config.maxTokens } : {},
            )
            const httpRequest = Http.prepareJson({
              url: `${baseURL}${prepared.path}`,
              headers: Auth.mergeHeaders(
                prepared.headers,
                Auth.toHeaders(Auth.header("x-api-key", apiKey)),
                config.headers,
              ),
              body: prepared.body,
            })
            return Http.streamSseJson(httpRequest).pipe(
              Stream.map((event) => event.json),
              AnthropicMessages.decode,
            )
          }),
        ),
    }),
  }
}

const options = (input: AnthropicOptions): ProviderOptions => ({
  [ANTHROPIC_PROVIDER_ID]: input,
})

export const Anthropic = {
  configure,
  options,
}
