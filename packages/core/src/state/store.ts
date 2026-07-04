import * as NodePath from "node:path"
import { FileSystem } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import type { Model } from "@swain/llms"
import { Message } from "@swain/llms"
import { Effect, ParseResult, Schema } from "effect"
import { createSessionState, type SessionState } from "./session"

const SessionMetadata = Schema.Struct({
  sessionId: Schema.String,
  workingDirectory: Schema.String,
  permissionMode: Schema.Literal("plan", "ask", "auto"),
  currentDate: Schema.String,
  model: Schema.Struct({ id: Schema.String, provider: Schema.String }),
  counters: Schema.Struct({
    turns: Schema.Number,
    inputTokens: Schema.Number,
    outputTokens: Schema.Number,
  }),
})
type SessionMetadata = typeof SessionMetadata.Type

const sessionDir = (root: string, sessionId: string): string =>
  NodePath.join(root, ".swain", "sessions", sessionId)

/**
 * Persists session metadata and transcript under `.swain/sessions/<id>/`. The
 * `FileStateCache`, locks, and pending approvals are runtime-only and are never
 * written; after a restart edits require fresh reads.
 */
export const saveSession = (
  session: SessionState,
  rootDir: string = session.workingDirectory,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = sessionDir(rootDir, session.sessionId)
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
      counters: { ...session.counters },
    }
    yield* fs.writeFileString(NodePath.join(dir, "session.json"), JSON.stringify(metadata, null, 2))

    const transcript = session.messages.map((message) => JSON.stringify(message)).join("\n")
    yield* fs.writeFileString(
      NodePath.join(dir, "messages.jsonl"),
      transcript.length > 0 ? `${transcript}\n` : "",
    )
  })

export interface LoadSessionInput {
  readonly sessionId: string
  readonly model: Model
  readonly rootDir: string
}

/**
 * Reloads a persisted session into memory. The model carries behavior that
 * cannot be serialized, so the caller supplies it. The file cache starts empty.
 */
export const loadSession = (
  input: LoadSessionInput,
): Effect.Effect<SessionState, PlatformError | ParseResult.ParseError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = sessionDir(input.rootDir, input.sessionId)

    const metadata = yield* fs
      .readFileString(NodePath.join(dir, "session.json"))
      .pipe(Effect.flatMap(Schema.decode(Schema.parseJson(SessionMetadata))))

    const transcript = yield* fs
      .readFileString(NodePath.join(dir, "messages.jsonl"))
      .pipe(Effect.orElseSucceed(() => ""))
    const lines = transcript.split("\n").filter((line) => line.length > 0)
    const messages = yield* Effect.forEach(lines, (line) =>
      Schema.decode(Schema.parseJson(Message))(line),
    )

    const state = createSessionState({
      sessionId: metadata.sessionId,
      workingDirectory: metadata.workingDirectory,
      model: input.model,
      permissionMode: metadata.permissionMode,
      currentDate: metadata.currentDate,
      messages,
    })
    state.counters.turns = metadata.counters.turns
    state.counters.inputTokens = metadata.counters.inputTokens
    state.counters.outputTokens = metadata.counters.outputTokens
    return state
  })
