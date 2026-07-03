import type { Message, Model } from "@swain/llms"
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
  messages: [...(input.messages ?? [])],
  counters: { turns: 0, inputTokens: 0, outputTokens: 0 },
})
