import * as NodePath from "node:path"
import { FileSystem } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import type { Model } from "@swain/llms"
import { Message } from "@swain/llms"
import { Effect, ParseResult, Schema } from "effect"
import {
  createSessionState,
  type RequestOptions,
  type SessionModelRef,
  type SessionState,
} from "./session"

const ModelRef = Schema.Struct({
  provider: Schema.String,
  modelId: Schema.String,
  variant: Schema.optional(Schema.String),
})

const SessionMetadata = Schema.Struct({
  sessionId: Schema.String,
  workingDirectory: Schema.String,
  permissionMode: Schema.Literal("plan", "ask", "auto"),
  currentDate: Schema.String,
  model: Schema.Struct({ id: Schema.String, provider: Schema.String }),
  // Legacy sessions predate model refs; both fields tolerate their absence.
  modelRef: Schema.optional(ModelRef),
  pastModels: Schema.optionalWith(Schema.Array(ModelRef), { default: () => [] }),
  counters: Schema.Struct({
    turns: Schema.Number,
    inputTokens: Schema.Number,
    outputTokens: Schema.Number,
  }),
  // Legacy sessions predate compaction; default to auto-enabled with no summary.
  compaction: Schema.optionalWith(
    Schema.Struct({
      autoEnabled: Schema.Boolean,
      failureReason: Schema.optional(Schema.String),
      lastCompactedAt: Schema.optional(Schema.String),
      summary: Schema.optional(Schema.String),
    }),
    { default: () => ({ autoEnabled: true }) },
  ),
})
type SessionMetadata = typeof SessionMetadata.Type

const ToolResultReplacement = Schema.Struct({
  toolCallId: Schema.String,
  name: Schema.optional(Schema.String),
  path: Schema.String,
  originalChars: Schema.Number,
  previewChars: Schema.Number,
  createdAt: Schema.String,
})
const ToolResultSidecar = Schema.Array(ToolResultReplacement)

// Monotonic suffix so two concurrent writers never share a temp path; a shared
// temp would let one writer's rename publish the other's bytes, or rename a file
// the other already moved.
let tmpSeq = 0

/**
 * Writes `path` atomically: write a sibling temp file in full, then rename it
 * over the destination. A crashed, interrupted, or concurrently-racing write
 * leaves either the old complete file or the new one, never a truncated mix —
 * the guarantee mid-turn progress persistence relies on. The temp sits in the
 * same directory so the rename stays on one filesystem (and is atomic).
 */
const writeFileAtomic = (
  fs: FileSystem.FileSystem,
  path: string,
  content: string,
): Effect.Effect<void, PlatformError> =>
  Effect.gen(function* () {
    const tmp = `${path}.tmp-${(tmpSeq += 1)}`
    yield* fs.writeFileString(tmp, content)
    yield* fs.rename(tmp, path)
  })

const sessionPath = (sessionsDir: string, sessionId: string): string =>
  NodePath.join(sessionsDir, sessionId)

/**
 * Persists session metadata and transcript under `<sessionsDir>/<id>/`. The
 * caller owns the location policy (project-local vs global). The
 * `FileStateCache`, locks, and pending approvals are runtime-only and are never
 * written; after a restart edits require fresh reads.
 */
export const saveSession = (
  session: SessionState,
  sessionsDir: string,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = sessionPath(sessionsDir, session.sessionId)
    yield* fs.makeDirectory(dir, { recursive: true })

    const metadata: SessionMetadata = {
      sessionId: session.sessionId,
      workingDirectory: session.workingDirectory,
      permissionMode: session.systemContext.permissionMode,
      currentDate: session.systemContext.currentDate,
      model: {
        id: session.systemContext.model.id,
        provider: session.systemContext.model.provider,
      },
      modelRef: session.systemContext.modelRef,
      pastModels: [...session.systemContext.pastModels],
      counters: { ...session.counters },
      compaction: { ...session.compaction },
    }
    yield* writeFileAtomic(
      fs,
      NodePath.join(dir, "session.json"),
      JSON.stringify(metadata, null, 2),
    )

    const transcript = session.messages.map((message) => JSON.stringify(message)).join("\n")
    yield* writeFileAtomic(
      fs,
      NodePath.join(dir, "messages.jsonl"),
      transcript.length > 0 ? `${transcript}\n` : "",
    )

    if (session.toolResults.length > 0) {
      yield* writeFileAtomic(
        fs,
        NodePath.join(dir, "tool-results.json"),
        JSON.stringify(session.toolResults, null, 2),
      )
    }
  })

export interface LoadSessionInput {
  readonly sessionId: string
  readonly model: Model
  /** The persisted target this live `model` was built from; overrides the file. */
  readonly modelRef?: SessionModelRef
  /** Live request options for the resolved target; not persisted separately. */
  readonly requestOptions?: RequestOptions
  readonly sessionsDir: string
}

const readMetadata = (
  sessionsDir: string,
  sessionId: string,
): Effect.Effect<SessionMetadata, PlatformError | ParseResult.ParseError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = sessionPath(sessionsDir, sessionId)
    return yield* fs
      .readFileString(NodePath.join(dir, "session.json"))
      .pipe(Effect.flatMap(Schema.decode(Schema.parseJson(SessionMetadata))))
  })

/**
 * The persisted current-model target for a session, or `undefined` for legacy
 * sessions (and on any read/parse failure). Callers resolve this into a live
 * model before resuming, so resume restores the conversation's own model rather
 * than the global default.
 */
export const readPersistedModelRef = (
  sessionsDir: string,
  sessionId: string,
): Effect.Effect<SessionModelRef | undefined, never, FileSystem.FileSystem> =>
  readMetadata(sessionsDir, sessionId).pipe(
    Effect.map((metadata) => metadata.modelRef),
    Effect.orElseSucceed(() => undefined),
  )

/**
 * Reloads a persisted session into memory. The model carries behavior that
 * cannot be serialized, so the caller supplies it (and the `modelRef` it was
 * resolved from). Legacy sessions without a persisted `modelRef` fall back to
 * the caller's model and an empty past-model history. The file cache starts
 * empty.
 */
export const loadSession = (
  input: LoadSessionInput,
): Effect.Effect<SessionState, PlatformError | ParseResult.ParseError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = sessionPath(input.sessionsDir, input.sessionId)

    const metadata = yield* readMetadata(input.sessionsDir, input.sessionId)

    const transcript = yield* fs
      .readFileString(NodePath.join(dir, "messages.jsonl"))
      .pipe(Effect.orElseSucceed(() => ""))
    const lines = transcript.split("\n").filter((line) => line.length > 0)
    const messages = yield* Effect.forEach(lines, (line) =>
      Schema.decode(Schema.parseJson(Message))(line),
    )

    // A missing or unreadable sidecar degrades to no replacement metadata; the
    // transcript still carries the preview/path wrapper, so the model is intact.
    const toolResults = yield* fs.readFileString(NodePath.join(dir, "tool-results.json")).pipe(
      Effect.flatMap(Schema.decode(Schema.parseJson(ToolResultSidecar))),
      Effect.orElseSucceed(() => []),
    )

    const modelRef = input.modelRef ?? metadata.modelRef
    const state = createSessionState({
      sessionId: metadata.sessionId,
      workingDirectory: metadata.workingDirectory,
      model: input.model,
      ...(modelRef !== undefined && { modelRef }),
      ...(input.requestOptions !== undefined && { requestOptions: input.requestOptions }),
      pastModels: metadata.pastModels,
      permissionMode: metadata.permissionMode,
      currentDate: metadata.currentDate,
      messages,
      compaction: metadata.compaction,
      toolResults,
    })
    state.counters.turns = metadata.counters.turns
    state.counters.inputTokens = metadata.counters.inputTokens
    state.counters.outputTokens = metadata.counters.outputTokens
    return state
  })
