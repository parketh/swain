import { createHash } from "node:crypto"
import type { Message, Model } from "@swain/llms"
import { Effect } from "effect"
import type { PermissionMode } from "../permission"

export type FileStateEntry = {
  readonly path: string
  readonly kind: "text"
  readonly lastModifiedMs: number
  readonly digest: string
  readonly content: string
}

/**
 * In-memory cache of local file contents the model has seen, keyed by
 * normalized absolute path. Enforces read-before-write and staleness detection
 * for `Edit`. Never persisted: restarts force fresh reads.
 */
export type FileStateCache = Map<string, FileStateEntry>

export interface SystemContext {
  readonly model: Model
  readonly permissionMode: PermissionMode
  readonly currentDate: string
}

export interface SessionCounters {
  turns: number
  inputTokens: number
  outputTokens: number
}

export interface SessionState {
  readonly sessionId: string
  readonly workingDirectory: string
  readonly systemContext: SystemContext
  readonly fileState: FileStateCache
  readonly locks: Map<string, Effect.Semaphore>
  readonly messages: Array<Message>
  readonly counters: SessionCounters
}

export interface CreateSessionInput {
  readonly sessionId?: string
  readonly workingDirectory: string
  readonly model: Model
  readonly permissionMode?: PermissionMode
  readonly currentDate: string
  readonly messages?: ReadonlyArray<Message>
}

export const createSessionState = (input: CreateSessionInput): SessionState => ({
  sessionId: input.sessionId ?? crypto.randomUUID(),
  workingDirectory: input.workingDirectory,
  systemContext: {
    model: input.model,
    permissionMode: input.permissionMode ?? "ask",
    currentDate: input.currentDate,
  },
  fileState: new Map(),
  locks: new Map(),
  messages: [...(input.messages ?? [])],
  counters: { turns: 0, inputTokens: 0, outputTokens: 0 },
})

export const digestContent = (content: string): string =>
  createHash("sha256").update(content).digest("hex")

/**
 * Serializes an effect against the given absolute path within this process.
 * Semaphores are created synchronously to avoid a create-time interleaving gap.
 */
export const withFileLock = <A, E, R>(
  session: SessionState,
  absolutePath: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  let lock = session.locks.get(absolutePath)
  if (lock === undefined) {
    lock = Effect.unsafeMakeSemaphore(1)
    session.locks.set(absolutePath, lock)
  }
  return lock.withPermits(1)(effect)
}

export const cacheEntry = (input: {
  readonly path: string
  readonly lastModifiedMs: number
  readonly content: string
}): FileStateEntry => ({
  path: input.path,
  kind: "text",
  lastModifiedMs: input.lastModifiedMs,
  digest: digestContent(input.content),
  content: input.content,
})

/** A cached text entry is fresh when both its mtime and content digest match. */
export const isFresh = (entry: FileStateEntry, lastModifiedMs: number, content: string): boolean =>
  entry.lastModifiedMs === lastModifiedMs && entry.digest === digestContent(content)
