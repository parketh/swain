import { Effect, Stream } from "effect"
import { OpenAIChat } from "../protocols"
import type { OpenAIChatOptions, OpenAIChatRequest } from "../protocols"
import { ModelId, ProviderId } from "../schema"
import type { LLMRequest, Model, ProviderOptions } from "../schema"
import { Auth, Http } from "../transport"

export interface OpenAICompatibleConfig {
  readonly providerId: string
  readonly baseURL: string
  readonly apiKey?: string
  readonly apiKeyEnv?: string
  readonly headers?: Record<string, string>
  /** Set false for deployments that reject `stream_options`. */
  readonly includeUsage?: boolean
}

export interface OpenAICompatibleFacade {
  readonly providerId: ProviderId
  readonly baseURL: string
  chat(modelId: string): Model
  options(input: OpenAIChatOptions): ProviderOptions
}

const toProtocolRequest = (modelId: string, request: LLMRequest): OpenAIChatRequest => ({
  modelId,
  messages: request.messages,
  ...(request.system !== undefined ? { system: request.system } : {}),
  ...(request.tools !== undefined ? { tools: request.tools } : {}),
  ...(request.toolChoice !== undefined ? { toolChoice: request.toolChoice } : {}),
  ...(request.generation !== undefined ? { generation: request.generation } : {}),
  ...(request.providerOptions !== undefined ? { providerOptions: request.providerOptions } : {}),
})

/**
 * Generic facade for OpenAI-compatible `/chat/completions` deployments.
 * Auth resolves lazily at execution, so missing credentials fail the
 * returned stream with `auth-failed` instead of throwing at configure time.
 */
const configure = (config: OpenAICompatibleConfig): OpenAICompatibleFacade => {
  const baseURL = config.baseURL.replace(/\/+$/, "")
  const provider = ProviderId.make(config.providerId)
  return {
    providerId: provider,
    baseURL,
    options: (input) => ({ [config.providerId]: input }),
    chat: (modelId) => ({
      id: ModelId.make(modelId),
      provider,
      streamTurn: (request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const apiKey = yield* Auth.resolveSecret({
              ...(config.apiKey !== undefined ? { value: config.apiKey } : {}),
              ...(config.apiKeyEnv !== undefined ? { env: config.apiKeyEnv } : {}),
              subject: config.providerId,
            })
            const { path, body } = OpenAIChat.prepare(toProtocolRequest(modelId, request), {
              optionsKey: config.providerId,
              ...(config.includeUsage !== undefined ? { includeUsage: config.includeUsage } : {}),
            })
            const httpRequest = Http.prepareJson({
              url: `${baseURL}${path}`,
              headers: Auth.mergeHeaders(Auth.toHeaders(Auth.bearer(apiKey)), config.headers),
              body,
            })
            return Http.streamSseJson(httpRequest).pipe(
              Stream.map((event) => event.json),
              OpenAIChat.decode,
            )
          }),
        ),
    }),
  }
}

const options = (providerId: string, input: OpenAIChatOptions): ProviderOptions => ({
  [providerId]: input,
})

export const OpenAICompatible = {
  configure,
  options,
}
