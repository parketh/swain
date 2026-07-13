import * as NodeOS from "node:os"
import * as NodePath from "node:path"
import { FileSystem } from "@effect/platform"
import { Data, Effect, ParseResult, Schema } from "effect"

const DIR_MODE = 0o700
const FILE_MODE = 0o600

export const ActiveModel = Schema.Struct({
  provider: Schema.String,
  modelId: Schema.String,
  variant: Schema.optional(Schema.String),
})
export type ActiveModel = typeof ActiveModel.Type

export const ProviderConfig = Schema.Struct({
  apiKey: Schema.optional(Schema.String),
  baseURL: Schema.optional(Schema.String),
  accountId: Schema.optional(Schema.String),
  accessToken: Schema.optional(Schema.String),
  refreshToken: Schema.optional(Schema.String),
})
export type ProviderConfig = typeof ProviderConfig.Type

export const RouterConfig = Schema.Struct({
  enabled: Schema.Boolean,
  disabledModels: Schema.Array(Schema.String),
  disabledTargets: Schema.Array(Schema.String),
})
export type RouterConfig = typeof RouterConfig.Type

export const TuiConfig = Schema.Struct({
  activeModel: Schema.optional(ActiveModel),
  router: Schema.optional(RouterConfig),
  providers: Schema.optionalWith(Schema.Record({ key: Schema.String, value: ProviderConfig }), {
    default: () => ({}),
  }),
})
export type TuiConfig = typeof TuiConfig.Type

export const emptyConfig: TuiConfig = { providers: {} }

/** Credential/settings persistence failures surface with a clear, typed message. */
export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly reason: "invalid" | "read-failed" | "write-failed"
  readonly message: string
}> {}

type Env = Record<string, string | undefined>

/**
 * Resolves the global config directory: `$XDG_CONFIG_HOME/swain` when the
 * override is set, otherwise `~/.config/swain`.
 */
export const configDir = (env: Env = process.env): string => {
  const xdg = env.XDG_CONFIG_HOME
  if (xdg !== undefined && xdg !== "") return NodePath.join(xdg, "swain")
  const home = env.HOME ?? NodeOS.homedir()
  return NodePath.join(home, ".config", "swain")
}

export const defaultConfigPath = (env: Env = process.env): string =>
  NodePath.join(configDir(env), "config.json")

/** Folder-safe slug of an absolute path, e.g. `/Users/x/dev` → `-Users-x-dev`. */
const projectSlug = (workingDirectory: string): string =>
  workingDirectory.replace(/[^A-Za-z0-9]/g, "-")

/**
 * Directory holding a project's saved sessions, scoped by working directory so
 * `/resume` only lists sessions from the current project. Anchored to the same
 * base as `config.json` (its parent dir) — i.e. `~/.config/swain/sessions/` —
 * rather than the project tree, so sessions are stored globally.
 */
export const sessionsDir = (configPath: string, workingDirectory: string): string =>
  NodePath.join(NodePath.dirname(configPath), "sessions", projectSlug(workingDirectory))

/** Loads config from `path`; a missing file resolves to empty defaults. */
export const loadConfig = (
  path: string,
): Effect.Effect<TuiConfig, ConfigError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
    if (!exists) return emptyConfig
    const raw = yield* fs
      .readFileString(path)
      .pipe(Effect.mapError((e) => new ConfigError({ reason: "read-failed", message: String(e) })))
    return yield* Schema.decode(Schema.parseJson(TuiConfig))(raw).pipe(
      Effect.mapError(
        (e) =>
          new ConfigError({
            reason: "invalid",
            message: ParseResult.TreeFormatter.formatErrorSync(e),
          }),
      ),
    )
  })

/**
 * Persists config to `path`, creating the directory `0700` and the file `0600`
 * where the platform exposes modes. Any failure fails with a typed
 * `ConfigError` and leaves no partial file. Provider credentials are never
 * written here — they live in `auth.json` (see `auth.ts`) — so `config.json`
 * stays free of secrets and safe to share.
 */
export const saveConfig = (
  path: string,
  config: TuiConfig,
): Effect.Effect<void, ConfigError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = NodePath.dirname(path)
    const nonSecret = {
      ...(config.activeModel !== undefined && { activeModel: config.activeModel }),
      ...(config.router !== undefined && { router: config.router }),
    }
    const body = JSON.stringify(nonSecret, null, 2)
    yield* fs
      .makeDirectory(dir, { recursive: true, mode: DIR_MODE })
      .pipe(Effect.mapError((e) => new ConfigError({ reason: "write-failed", message: String(e) })))
    yield* fs
      .writeFileString(path, body, { mode: FILE_MODE })
      .pipe(Effect.mapError((e) => new ConfigError({ reason: "write-failed", message: String(e) })))
    // writeFile only applies mode on creation; chmod guarantees 0600 on rewrite.
    yield* fs.chmod(path, FILE_MODE).pipe(Effect.orElseSucceed(() => undefined))
  })

/** Redacts an API key to a short suffix; never returns the raw key. */
export const redactKey = (key: string): string =>
  key.length <= 4 ? "****" : `****${key.slice(-4)}`
