import type { FileSystem } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import type { Model } from "@swain/llms"
import { OPENAI_CODEX_PROVIDER_ID, OpenAICodex as OpenAICodexProvider } from "@swain/llms/providers"
import { Effect } from "effect"
import { type AuthStore, authPath, loadAuth, saveAuth } from "./auth"
import { type ConfigError, defaultConfigPath, type ProviderConfig } from "./config"

type Env = Record<string, string | undefined>

export interface CodexCredentials {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly accountId?: string
}

/** Reads swain's persisted Codex credentials from `auth.json`, or `undefined` when none are stored. */
export const loadStoredCodexCredentials = (
  configPath: string,
): Effect.Effect<CodexCredentials | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const store = yield* loadAuth(authPath(configPath))
    const stored = store[OPENAI_CODEX_PROVIDER_ID]
    if (stored?.accessToken === undefined && stored?.refreshToken === undefined) return undefined
    return {
      accessToken: stored.accessToken ?? "",
      ...(stored.refreshToken !== undefined && { refreshToken: stored.refreshToken }),
      ...(stored.accountId !== undefined && { accountId: stored.accountId }),
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
 * Builds the Codex `Model` with automatic OAuth refresh. The resolver re-reads
 * the persisted credentials from `auth.json` on every turn — the single source
 * of truth that refreshes are written back to — so a refresh token rotated by an
 * earlier turn is never replayed (which fails with `refresh_token_reused`). The
 * config-supplied `creds` only seed the first turn, until `auth.json` holds a
 * codex entry. Falls back to the provider's env credentials when nothing is
 * stored.
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
  const seed: CodexCredentials = {
    accessToken: creds?.accessToken ?? "",
    ...(creds?.refreshToken !== undefined && { refreshToken: creds.refreshToken }),
    ...(creds?.accountId !== undefined && { accountId: creds.accountId }),
  }
  const configPath = defaultConfigPath(env)
  return OpenAICodexProvider.configure({
    credentialResolver: () =>
      Effect.runPromise(
        loadStoredCodexCredentials(configPath).pipe(Effect.provide(BunContext.layer)),
      ).then((stored) => stored ?? seed),
    onCredentialsRefreshed: (next) =>
      Effect.runPromise(
        persistCodexCredentials(configPath, {
          accessToken: next.accessToken,
          refreshToken: next.refreshToken,
          ...((next.accountId ?? seed.accountId) !== undefined && {
            accountId: next.accountId ?? seed.accountId,
          }),
        }).pipe(Effect.provide(BunContext.layer)),
      ).then(
        () => undefined,
        () => undefined,
      ),
    ...(creds?.baseURL !== undefined && { baseURL: creds.baseURL }),
  }).model(modelId)
}
