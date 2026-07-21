import { FileSystem } from "@effect/platform"
import type { GenerationOptions, Model, ProviderOptions } from "@swain/llms"
import { ModelId, ProviderId } from "@swain/llms"
import { Effect, Stream } from "effect"
import { authPath, loadAuth, saveAuth } from "./auth"
import { mergeCodexCliCredentials } from "./codex-auth"
import {
  type ActiveModel,
  type ConfigError,
  defaultConfigPath,
  loadConfig,
  type ProviderConfig,
  saveConfig,
  type TuiConfig,
} from "./config"
import {
  availableModels,
  defaultVariantId,
  environmentCredentialSources,
  resolveModelSelection,
} from "./models"

type Env = Record<string, string | undefined>

/**
 * How missing provider credentials are filled. Interactive startup considers
 * only credentials stored in `auth.json` (`stored-only`); headless `exec` fills
 * missing required fields from the standard environment variables in addition
 * (`stored-then-environment`) without ever persisting those values.
 */
export type CredentialPolicy = "stored-only" | "stored-then-environment"

export interface RequestOptions {
  readonly providerOptions?: ProviderOptions
  readonly generation?: GenerationOptions
}

export interface ResolvedModel {
  readonly model: Model
  readonly activeModel: ActiveModel
  readonly requestOptions: RequestOptions
}

export interface LoadedStartup {
  readonly configPath: string
  readonly config: TuiConfig
  /**
   * True when legacy plaintext credentials were found in `config.json`.
   * Interactive startup performs a one-time migration; headless startup ignores
   * it so loading environment credentials never rewrites config on disk.
   */
  readonly needsMigration: boolean
}

// Rendered when no provider is configured yet; the interactive app prompts the
// user to run /connect instead of crashing on missing credentials.
export const placeholderModel: Model = {
  id: ModelId.make("unconfigured"),
  provider: ProviderId.make("none"),
  streamTurn: () => Stream.empty,
}
export const placeholderActive: ActiveModel = { provider: "none", modelId: "unconfigured" }

/** Fills each missing required credential from its environment variable; stored values win. */
const applyEnvironmentCredentials = (
  providers: Readonly<Record<string, ProviderConfig>>,
  env: Env,
): Record<string, ProviderConfig> => {
  const next: Record<string, ProviderConfig> = { ...providers }
  for (const source of environmentCredentialSources) {
    const value = env[source.envVar]
    if (value === undefined || value === "") continue
    const existing = next[source.provider]
    const current = existing?.[source.field]
    if (typeof current === "string" && current.length > 0) continue
    next[source.provider] = { ...existing, [source.field]: value }
  }
  return next
}

/**
 * Reads config and auth, merges legacy plaintext keys (auth wins), bootstraps
 * Codex credentials from the Codex CLI, and — under the exec policy — overlays
 * missing required credentials from the environment. Never migrates or persists;
 * the caller decides whether to run the one-time migration.
 */
export const loadStartup = (
  env: Env,
  policy: CredentialPolicy,
): Effect.Effect<LoadedStartup, ConfigError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const configPath = defaultConfigPath(env)
    const stored = yield* loadConfig(configPath)
    const auth = yield* loadAuth(authPath(configPath))
    // Credentials live in auth.json; auth.json wins over any legacy plaintext
    // keys still sitting in config.json.
    let providers: Record<string, ProviderConfig> = { ...stored.providers, ...auth }
    providers = yield* mergeCodexCliCredentials(providers, env)
    if (policy === "stored-then-environment") {
      providers = applyEnvironmentCredentials(providers, env)
    }
    const config: TuiConfig = { ...stored, providers }
    return { configPath, config, needsMigration: Object.keys(stored.providers).length > 0 }
  })

/**
 * One-time migration: move legacy plaintext keys out of config.json into
 * auth.json (saveConfig strips providers, so this also cleans config.json).
 * Best-effort; failures are swallowed. Interactive startup only.
 */
export const migrateLegacyAuth = (
  configPath: string,
  config: TuiConfig,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  saveAuth(authPath(configPath), config.providers).pipe(
    Effect.andThen(saveConfig(configPath, config)),
    Effect.catchAll(() => Effect.void),
  )

/**
 * Seeds a model ref with its recommended default variant when none is given, so
 * the initial request uses the recommended effort rather than no override.
 */
export const withDefaultVariant = (
  provider: string,
  modelId: string,
  variant?: string,
): ActiveModel => {
  if (variant !== undefined) return { provider, modelId, variant }
  const recommended = defaultVariantId(provider, modelId)
  return { provider, modelId, ...(recommended !== undefined && { variant: recommended }) }
}

const isAvailable = (config: TuiConfig, candidate: ActiveModel): boolean =>
  availableModels(config).some(
    (m) => m.provider === candidate.provider && m.modelId === candidate.modelId,
  )

/**
 * Interactive model precedence: `--model` flag → saved active model → first
 * configured model → placeholder. Preserves the current TUI behavior, including
 * ignoring a variant segment on the flag.
 */
export const resolveInteractiveModel = (
  config: TuiConfig,
  flagModel: string | undefined,
): ResolvedModel => {
  let requested: ActiveModel | undefined
  if (flagModel !== undefined) {
    const [provider, modelId] = flagModel.split(":")
    if (provider !== undefined && modelId !== undefined) {
      requested = withDefaultVariant(provider, modelId)
    }
  }
  if (
    requested === undefined &&
    config.activeModel !== undefined &&
    isAvailable(config, config.activeModel)
  ) {
    requested = config.activeModel
  }
  if (requested === undefined) {
    const models = availableModels(config)
    const first = models[0]
    if (first !== undefined) requested = withDefaultVariant(first.provider, first.modelId)
  }
  if (requested === undefined) {
    return { model: placeholderModel, activeModel: placeholderActive, requestOptions: {} }
  }
  const resolved = resolveModelSelection(
    requested.provider,
    requested.modelId,
    requested.variant,
    config,
  )
  if (resolved.type === "ok") {
    return {
      model: resolved.selection.model,
      activeModel: requested,
      requestOptions: resolved.selection.requestOptions,
    }
  }
  return { model: placeholderModel, activeModel: placeholderActive, requestOptions: {} }
}

export type HeadlessModelResult =
  | { readonly ok: true; readonly resolved: ResolvedModel }
  | { readonly ok: false; readonly error: string }

/**
 * Headless model precedence: `--model` flag → saved active model → error. There
 * is no catalog-order fallback or placeholder; a run that cannot resolve a model
 * fails before the runtime starts.
 */
export const resolveHeadlessModel = (
  config: TuiConfig,
  flag: ActiveModel | undefined,
): HeadlessModelResult => {
  const requested =
    flag !== undefined
      ? withDefaultVariant(flag.provider, flag.modelId, flag.variant)
      : config.activeModel !== undefined
        ? withDefaultVariant(
            config.activeModel.provider,
            config.activeModel.modelId,
            config.activeModel.variant,
          )
        : undefined
  if (requested === undefined) {
    return {
      ok: false,
      error:
        "No model available. Pass --model provider:model[:variant] or set an active model in the interactive TUI.",
    }
  }
  const resolved = resolveModelSelection(
    requested.provider,
    requested.modelId,
    requested.variant,
    config,
  )
  if (resolved.type === "error") return { ok: false, error: resolved.error.message }
  return {
    ok: true,
    resolved: {
      model: resolved.selection.model,
      activeModel: requested,
      requestOptions: resolved.selection.requestOptions,
    },
  }
}
