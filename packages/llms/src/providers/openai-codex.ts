import { Effect, Stream } from "effect"
import type { OpenAICodexOptions, OpenAICodexRequest } from "../protocols"
import { OpenAICodexResponses } from "../protocols"
import type { LLMRequest, Model, ProviderOptions } from "../schema"
import { LLMError, ModelId, ProviderId } from "../schema"
import { Auth, Http } from "../transport"

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex"
export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api"
export const OPENAI_CODEX_TOKEN_ENV = "OPENAI_CODEX_ACCESS_TOKEN"

/** JWT payload claim carrying the ChatGPT account id. */
const ACCOUNT_CLAIM = "https://api.openai.com/auth"

export type { OpenAICodexOptions }

export interface OpenAICodexCredentials {
  readonly accessToken: string
  readonly accountId: string
}

export type OpenAICodexCredentialResolver =
  | Effect.Effect<OpenAICodexCredentials, LLMError>
  | (() => OpenAICodexCredentials | Promise<OpenAICodexCredentials>)

export interface OpenAICodexProviderConfig {
  /** Returns reusable ChatGPT/Codex subscription credentials; resolved lazily per turn. */
  readonly credentialResolver?: OpenAICodexCredentialResolver
  readonly baseURL?: string
  readonly headers?: Record<string, string>
  readonly originator?: string
}

export interface OpenAICodexFacade {
  readonly providerId: ProviderId
  readonly baseURL: string
  model(modelId: string): Model
  options(input: OpenAICodexOptions): ProviderOptions
}

const authFailed = (message: string): LLMError =>
  new LLMError({ reason: "auth-failed", message, retryable: false })

const accountIdFromToken = (token: string): string | undefined => {
  const payload = token.split(".")[1]
  if (payload === undefined || payload === "") {
    return undefined
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >
    const auth = claims[ACCOUNT_CLAIM] as { chatgpt_account_id?: unknown } | undefined
    const accountId = auth?.chatgpt_account_id
    return typeof accountId === "string" && accountId !== "" ? accountId : undefined
  } catch {
    return undefined
  }
}

/**
 * Env fallback: `OPENAI_CODEX_ACCESS_TOKEN` is usable only when the account
 * id is derivable from the token's `chatgpt_account_id` JWT claim.
 */
const envCredentials = (): Effect.Effect<OpenAICodexCredentials, LLMError> =>
  Effect.suspend(() => {
    const token = process.env[OPENAI_CODEX_TOKEN_ENV]
    if (token === undefined || token === "") {
      return Effect.fail(
        authFailed(
          `Missing credentials for ${OPENAI_CODEX_PROVIDER_ID} (supply credentialResolver or set ${OPENAI_CODEX_TOKEN_ENV})`,
        ),
      )
    }
    const accountId = accountIdFromToken(token)
    if (accountId === undefined) {
      return Effect.fail(
        authFailed(`${OPENAI_CODEX_TOKEN_ENV} does not carry a chatgpt_account_id claim`),
      )
    }
    return Effect.succeed({ accessToken: token, accountId })
  })

const resolveCredentials = (
  resolver: OpenAICodexCredentialResolver | undefined,
): Effect.Effect<OpenAICodexCredentials, LLMError> => {
  if (resolver === undefined) {
    return envCredentials()
  }
  if (Effect.isEffect(resolver)) {
    return resolver
  }
  return Effect.tryPromise({
    try: async () => await resolver(),
    catch: (cause) => authFailed(`credential resolver failed: ${String(cause)}`),
  })
}

const toProtocolRequest = (modelId: string, request: LLMRequest): OpenAICodexRequest => ({
  modelId,
  messages: request.messages,
  ...(request.system !== undefined ? { system: request.system } : {}),
  ...(request.tools !== undefined ? { tools: request.tools } : {}),
  ...(request.toolChoice !== undefined ? { toolChoice: request.toolChoice } : {}),
  ...(request.generation !== undefined ? { generation: request.generation } : {}),
  ...(request.providerOptions !== undefined ? { providerOptions: request.providerOptions } : {}),
})

/**
 * Facade for the ChatGPT/Codex subscription Responses endpoint. Credentials
 * come from the supplied resolver (or the env fallback) and are resolved
 * lazily per turn; failures surface as `auth-failed` in the stream.
 */
const configure = (config: OpenAICodexProviderConfig = {}): OpenAICodexFacade => {
  const baseURL = (config.baseURL ?? OPENAI_CODEX_BASE_URL).replace(/\/+$/, "")
  const provider = ProviderId.make(OPENAI_CODEX_PROVIDER_ID)
  return {
    providerId: provider,
    baseURL,
    options: (input) => ({ openaiCodex: input }),
    model: (modelId) => ({
      id: ModelId.make(modelId),
      provider,
      streamTurn: (request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const credentials = yield* resolveCredentials(config.credentialResolver)
            const prepared = OpenAICodexResponses.prepare(toProtocolRequest(modelId, request), {
              accessToken: credentials.accessToken,
              accountId: credentials.accountId,
              ...(config.originator !== undefined ? { originator: config.originator } : {}),
            })
            const httpRequest = Http.prepareJson({
              url: `${baseURL}${prepared.path}`,
              headers: Auth.mergeHeaders(prepared.headers, config.headers),
              body: prepared.body,
            })
            return Http.streamSseJson(httpRequest).pipe(
              Stream.map((event) => event.json),
              OpenAICodexResponses.decode,
            )
          }),
        ),
    }),
  }
}

const options = (input: OpenAICodexOptions): ProviderOptions => ({ openaiCodex: input })

export const OpenAICodex = {
  configure,
  options,
}
