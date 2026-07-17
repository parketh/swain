import * as NodeOS from "node:os"
import * as NodePath from "node:path"
import { FileSystem } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import type { Model } from "@swain/llms"
import { OPENAI_CODEX_PROVIDER_ID, OpenAICodex as OpenAICodexProvider } from "@swain/llms/providers"
import { Effect, Schema } from "effect"
import { type AuthStore, authPath, loadAuth, saveAuth } from "./auth"
import { type ConfigError, defaultConfigPath, type ProviderConfig } from "./config"

type Env = Record<string, string | undefined>

export interface CodexCredentials {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly accountId?: string
}

/** Path to the Codex CLI's own credential store (`~/.codex/auth.json`). */
export const codexCliAuthPath = (env: Env = process.env): string =>
  NodePath.join(env.HOME ?? NodeOS.homedir(), ".codex", "auth.json")

// Only the fields we bootstrap from; the Codex CLI writes many more.
const CodexCliAuth = Schema.Struct({
  tokens: Schema.optional(
    Schema.Struct({
      access_token: Schema.optional(Schema.String),
      refresh_token: Schema.optional(Schema.String),
      account_id: Schema.optional(Schema.String),
    }),
  ),
})

/**
 * Reads the Codex CLI's credentials as a fallback source, so a user who logged
 * in with `codex` never has to paste a token into swain. Missing/unreadable
 * files (and files without an access token) resolve to `undefined`.
 */
export const loadCodexCliCredentials = (
  env: Env = process.env,
): Effect.Effect<CodexCredentials | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = codexCliAuthPath(env)
    const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
    if (!exists) return undefined
    const parsed = yield* fs.readFileString(path).pipe(
      Effect.flatMap(Schema.decode(Schema.parseJson(CodexCliAuth))),
      Effect.orElseSucceed(() => ({}) as typeof CodexCliAuth.Type),
    )
    const tokens = parsed.tokens
    if (tokens?.access_token === undefined || tokens.access_token === "") return undefined
    return {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token !== undefined && { refreshToken: tokens.refresh_token }),
      ...(tokens.account_id !== undefined && { accountId: tokens.account_id }),
    }
  })

/**
 * Bootstraps Codex credentials from the Codex CLI's own store
 * (`~/.codex/auth.json`) when swain has no refresh token of its own, so users who
 * logged in with `codex` never paste a token and swain can refresh expired access
 * tokens automatically. Adopts the CLI pair when it carries a refresh token, or
 * when swain has no Codex access token at all. Returns a new providers map;
 * missing/unreadable CLI credentials leave the input unchanged. Never writes.
 */
export const mergeCodexCliCredentials = (
  providers: Readonly<Record<string, ProviderConfig>>,
  env: Env = process.env,
): Effect.Effect<Record<string, ProviderConfig>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (providers[OPENAI_CODEX_PROVIDER_ID]?.refreshToken !== undefined) return { ...providers }
    const cli = yield* loadCodexCliCredentials(env).pipe(Effect.orElseSucceed(() => undefined))
    if (cli === undefined) return { ...providers }
    if (
      cli.refreshToken === undefined &&
      providers[OPENAI_CODEX_PROVIDER_ID]?.accessToken !== undefined
    ) {
      return { ...providers }
    }
    return {
      ...providers,
      [OPENAI_CODEX_PROVIDER_ID]: {
        accessToken: cli.accessToken,
        ...(cli.refreshToken !== undefined && { refreshToken: cli.refreshToken }),
        ...(cli.accountId !== undefined && { accountId: cli.accountId }),
      },
    }
  })

/** Persists rotated Codex credentials into swain's own `auth.json`, preserving other providers. */
export const persistCodexCredentials = (
  configPath: string,
  creds: CodexCredentials,
): Effect.Effect<void, ConfigError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const path = authPath(configPath)
    const store = yield* loadAuth(path)
    const next: AuthStore = {
      ...store,
      [OPENAI_CODEX_PROVIDER_ID]: {
        ...store[OPENAI_CODEX_PROVIDER_ID],
        accessToken: creds.accessToken,
        ...(creds.refreshToken !== undefined && { refreshToken: creds.refreshToken }),
        ...(creds.accountId !== undefined && { accountId: creds.accountId }),
      },
    }
    yield* saveAuth(path, next)
  })

/**
 * Builds the Codex `Model` with automatic OAuth refresh: the resolver seeds from
 * stored credentials and is updated in place on each refresh, while the rotated
 * tokens are persisted to swain's `auth.json`. Falls back to the provider's env
 * credentials when nothing is stored.
 */
export const buildCodexModel = (
  modelId: string,
  creds: ProviderConfig | undefined,
  env: Env = process.env,
): Model => {
  const hasStored = creds?.accessToken !== undefined || creds?.refreshToken !== undefined
  if (!hasStored) {
    return OpenAICodexProvider.configure({
      ...(creds?.baseURL !== undefined && { baseURL: creds.baseURL }),
    }).model(modelId)
  }
  const state: { accessToken?: string; refreshToken?: string; accountId?: string } = {
    accessToken: creds?.accessToken,
    refreshToken: creds?.refreshToken,
    accountId: creds?.accountId,
  }
  const configPath = defaultConfigPath(env)
  return OpenAICodexProvider.configure({
    credentialResolver: () => ({
      accessToken: state.accessToken ?? "",
      ...(state.refreshToken !== undefined && { refreshToken: state.refreshToken }),
      ...(state.accountId !== undefined && { accountId: state.accountId }),
    }),
    onCredentialsRefreshed: (next) => {
      state.accessToken = next.accessToken
      state.refreshToken = next.refreshToken
      if (next.accountId !== undefined) state.accountId = next.accountId
      return Effect.runPromise(
        persistCodexCredentials(configPath, {
          accessToken: next.accessToken,
          refreshToken: next.refreshToken,
          ...(state.accountId !== undefined && { accountId: state.accountId }),
        }).pipe(Effect.provide(BunContext.layer)),
      ).then(
        () => undefined,
        () => undefined,
      )
    },
    ...(creds?.baseURL !== undefined && { baseURL: creds.baseURL }),
  }).model(modelId)
}
