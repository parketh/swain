import * as NodePath from "node:path"
import { FileSystem } from "@effect/platform"
import { Effect, Schema } from "effect"

const HISTORY_LIMIT = 100
const DIR_MODE = 0o700
const FILE_MODE = 0o600

const History = Schema.Array(Schema.String)

/** Global prompt history, anchored beside `config.json` (shared across cwds). */
export const historyPath = (configPath: string): string =>
  NodePath.join(NodePath.dirname(configPath), "history.json")

/**
 * Appends `text`, skipping empties and consecutive duplicates, and caps the
 * result to the most recent `HISTORY_LIMIT` entries. Returns the same reference
 * when nothing changes so callers can skip a redundant write.
 */
export const appendHistory = (
  entries: ReadonlyArray<string>,
  text: string,
): ReadonlyArray<string> =>
  text === "" || entries[entries.length - 1] === text
    ? entries
    : [...entries, text].slice(-HISTORY_LIMIT)

/** Loads history; a missing, unreadable, or invalid file resolves to empty. */
export const loadHistory = (
  path: string,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
    if (!exists) return []
    return yield* fs.readFileString(path).pipe(
      Effect.flatMap(Schema.decode(Schema.parseJson(History))),
      Effect.orElseSucceed(() => []),
    )
  })

/** Persists history best-effort (dir `0700`, file `0600`); failures are ignored. */
export const saveHistory = (
  path: string,
  entries: ReadonlyArray<string>,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs
      .makeDirectory(NodePath.dirname(path), { recursive: true, mode: DIR_MODE })
      .pipe(Effect.orElseSucceed(() => undefined))
    yield* fs
      .writeFileString(path, JSON.stringify(entries), { mode: FILE_MODE })
      .pipe(Effect.orElseSucceed(() => undefined))
    yield* fs.chmod(path, FILE_MODE).pipe(Effect.orElseSucceed(() => undefined))
  })
