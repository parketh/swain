import * as NodePath from "node:path"
import { FileSystem } from "@effect/platform"
import { Effect, Schema } from "effect"
import { ConfigError, ProviderConfig } from "./config"

const DIR_MODE = 0o700
const FILE_MODE = 0o600

const AuthStore = Schema.Record({ key: Schema.String, value: ProviderConfig })
export type AuthStore = typeof AuthStore.Type

/**
 * Provider credentials live in `auth.json`, split from `config.json` so the
 * (shareable) config never holds secrets. Anchored beside the config file.
 */
export const authPath = (configPath: string): string =>
  NodePath.join(NodePath.dirname(configPath), "auth.json")

/** Loads stored credentials; a missing, unreadable, or invalid file resolves to empty. */
export const loadAuth = (path: string): Effect.Effect<AuthStore, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
    if (!exists) return {}
    return yield* fs.readFileString(path).pipe(
      Effect.flatMap(Schema.decode(Schema.parseJson(AuthStore))),
      Effect.orElseSucceed(() => ({})),
    )
  })

/** Persists credentials (dir `0700`, file `0600`); fails with a typed `ConfigError`. */
export const saveAuth = (
  path: string,
  store: AuthStore,
): Effect.Effect<void, ConfigError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const body = JSON.stringify(store, null, 2)
    yield* fs
      .makeDirectory(NodePath.dirname(path), { recursive: true, mode: DIR_MODE })
      .pipe(Effect.mapError((e) => new ConfigError({ reason: "write-failed", message: String(e) })))
    yield* fs
      .writeFileString(path, body, { mode: FILE_MODE })
      .pipe(Effect.mapError((e) => new ConfigError({ reason: "write-failed", message: String(e) })))
    yield* fs.chmod(path, FILE_MODE).pipe(Effect.orElseSucceed(() => undefined))
  })
