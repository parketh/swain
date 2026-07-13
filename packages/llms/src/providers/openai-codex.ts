import type { HttpClient } from "@effect/platform"
import { Effect, Stream } from "effect"
import type { OpenAICodexOptions, OpenAICodexRequest } from "../protocols"
import { OpenAICodexResponses } from "../protocols"
import type { LLMRequest, Model, ProviderOptions } from "../schema"
import { LLMError, ModelId, Provider, ProviderId } from "../schema"
import { Auth, Http } from "../transport"

export const OPENAI_CODEX_PROVIDER_ID = Provider.OpenAICodex
export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api"
export const OPENAI_CODEX_TOKEN_ENV = "OPENAI_CODEX_ACCESS_TOKEN"

/** OAuth client id shared with the ChatGPT/Codex CLI; required by the token endpoint. */
export const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token"

/** Refresh once the access token is within this margin of its `exp`. */
const REFRESH_SKEW_MS = 60_000

/** JWT payload claim carrying the ChatGPT account id. */
const ACCOUNT_CLAIM = "https://api.openai.com/auth"

export type { OpenAICodexOptions }

export interface OpenAICodexCredentials {
  readonly accessToken: string
  /** OAuth refresh token; when present, an expired access token is refreshed automatically. */
  readonly refreshToken?: string
  /** Derived from the token's `chatgpt_account_id` claim when omitted. */
  readonly accountId?: string
}

/** New credentials handed back to the caller after an automatic refresh, so it can persist them. */
export interface RefreshedCodexCredentials {
  readonly accessToken: string
  readonly refreshToken: string
  readonly accountId?: string
}

export type OpenAICodexCredentialResolver =
  | Effect.Effect<OpenAICodexCredentials, LLMError>
  | (() => OpenAICodexCredentials | Promise<OpenAICodexCredentials>)

export interface OpenAICodexProviderConfig {
  /** Returns reusable ChatGPT/Codex subscription credentials; resolved lazily per turn. */
  readonly credentialResolver?: OpenAICodexCredentialResolver
  /**
   * Called after an expired access token is refreshed, with the rotated
   * credentials, so the caller can persist them. Persistence errors are ignored
   * (they never fail the turn).
   */
  readonly onCredentialsRefreshed?: (credentials: RefreshedCodexCredentials) => void | Promise<void>
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

/** Absolute expiry (epoch ms) from the token's `exp` claim, or `undefined` if unreadable. */
const expiryMsFromToken = (token: string): number | undefined => {
  const payload = token.split(".")[1]
  if (payload === undefined || payload === "") return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown
    }
    return typeof claims.exp === "number" ? claims.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

interface TokenResponse {
  readonly access_token?: unknown
  readonly refresh_token?: unknown
  readonly id_token?: unknown
}

/** Exchanges a refresh token for a fresh access token via the OpenAI OAuth endpoint. */
const refreshAccessToken = (
  refreshToken: string,
): Effect.Effect<RefreshedCodexCredentials, LLMError, HttpClient.HttpClient> =>
  Http.postForm({
    url: OPENAI_CODEX_TOKEN_URL,
    form: {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID,
    },
  }).pipe(
    Effect.flatMap((json) => {
      const tokens = json as TokenResponse
      const accessToken = tokens.access_token
      if (typeof accessToken !== "string" || accessToken === "") {
        return Effect.fail(authFailed("token refresh response is missing access_token"))
      }
      const nextRefresh =
        typeof tokens.refresh_token === "string" && tokens.refresh_token !== ""
          ? tokens.refresh_token
          : refreshToken
      const idToken = typeof tokens.id_token === "string" ? tokens.id_token : accessToken
      const accountId = accountIdFromToken(idToken) ?? accountIdFromToken(accessToken)
      return Effect.succeed({
        accessToken,
        refreshToken: nextRefresh,
        ...(accountId !== undefined && { accountId }),
      })
    }),
  )

interface ResolvedCredentials {
  readonly accessToken: string
  readonly accountId: string
}

/** Fills a missing account id from the token's `chatgpt_account_id` JWT claim. */
const normalizeCredentials = (
  credentials: OpenAICodexCredentials,
): Effect.Effect<ResolvedCredentials, LLMError> => {
  const accountId = credentials.accountId ?? accountIdFromToken(credentials.accessToken)
  if (accountId === undefined) {
    return Effect.fail(
      authFailed(
        "Missing account id: none supplied and the access token carries no chatgpt_account_id claim",
      ),
    )
  }
  return Effect.succeed({ accessToken: credentials.accessToken, accountId })
}

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
    return Effect.succeed({ accessToken: token })
  })

const rawCredentials = (
  resolver: OpenAICodexCredentialResolver | undefined,
): Effect.Effect<OpenAICodexCredentials, LLMError> =>
  resolver === undefined
    ? envCredentials()
    : Effect.isEffect(resolver)
      ? resolver
      : Effect.tryPromise({
          try: async () => await resolver(),
          catch: (cause) => authFailed(`credential resolver failed: ${String(cause)}`),
        })

/**
 * Resolves credentials for a turn, refreshing the access token first when it is
 * expired (or within the skew margin) and a refresh token is available. Rotated
 * credentials are handed to `onCredentialsRefreshed` for persistence.
 */
const resolveCredentials = (
  config: OpenAICodexProviderConfig,
): Effect.Effect<ResolvedCredentials, LLMError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const raw = yield* rawCredentials(config.credentialResolver)
    const expiry = expiryMsFromToken(raw.accessToken)
    const stale = expiry !== undefined && expiry <= Date.now() + REFRESH_SKEW_MS
    if (raw.refreshToken === undefined || !stale) {
      return yield* normalizeCredentials(raw)
    }
    const refreshed = yield* refreshAccessToken(raw.refreshToken)
    if (config.onCredentialsRefreshed !== undefined) {
      const persist = config.onCredentialsRefreshed
      yield* Effect.promise(async () => {
        try {
          await persist(refreshed)
        } catch {
          // Persistence is best-effort; a write failure must not fail the turn.
        }
      })
    }
    return yield* normalizeCredentials(refreshed)
  })

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
            const credentials = yield* resolveCredentials(config)
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
