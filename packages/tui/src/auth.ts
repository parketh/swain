import * as NodePath from "node:path"
import { FileSystem } from "@effect/platform"
import { Effect, Schema } from "effect"
import { ConfigError, ProviderConfig } from "./config"

const DIR_MODE = 0o700
const FILE_MODE = 0o600

// Distinguishes temp files of concurrent saves in one process, where `process.pid`
// alone would collide and let one save rename away another's temp file.
let saveSeq = 0

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
  loadAuthStrict(path).pipe(Effect.orElseSucceed(() => ({})))

/**
 * Like {@link loadAuth} but keeps an existing-yet-unreadable/corrupt file distinct
 * from an absent one: a missing file resolves to empty, while a read or parse
 * failure fails with `ConfigError`. Callers that would otherwise revert to stale
 * credentials on a transient error use this instead of silently getting `{}`.
 */
export const loadAuthStrict = (
  path: string,
): Effect.Effect<AuthStore, ConfigError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
    if (!exists) return {}
    return yield* fs.readFileString(path).pipe(
      Effect.flatMap(Schema.decode(Schema.parseJson(AuthStore))),
      Effect.mapError((e) => new ConfigError({ reason: "read-failed", message: String(e) })),
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
    const failWrite = (e: unknown) =>
      new ConfigError({ reason: "write-failed", message: String(e) })
    yield* fs
      .makeDirectory(NodePath.dirname(path), { recursive: true, mode: DIR_MODE })
      .pipe(Effect.mapError(failWrite))
    // Write to a temp file and rename over the target so a crash mid-write can
    // never leave a truncated auth.json (which would read back as empty creds).
    const tmp = `${path}.${process.pid}.${saveSeq++}.tmp`
    yield* Effect.gen(function* () {
      yield* fs.writeFileString(tmp, body, { mode: FILE_MODE }).pipe(Effect.mapError(failWrite))
      yield* fs.chmod(tmp, FILE_MODE).pipe(Effect.orElseSucceed(() => undefined))
      yield* fs.rename(tmp, path).pipe(Effect.mapError(failWrite))
    }).pipe(Effect.tapError(() => fs.remove(tmp).pipe(Effect.ignore)))
  })
