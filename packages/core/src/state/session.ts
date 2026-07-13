import { createHash } from "node:crypto"
import type { GenerationOptions, Message, Model, ProviderOptions } from "@swain/llms"
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

/** Portable request options for the current model target; not persisted directly. */
export interface RequestOptions {
  readonly providerOptions?: ProviderOptions
  readonly generation?: GenerationOptions
}

/** Serializable identity of a model target, TUI-catalog-agnostic. */
export interface SessionModelRef {
  readonly provider: string
  readonly modelId: string
  readonly variant?: string
}

export interface SystemContext {
  readonly model: Model
  readonly requestOptions: RequestOptions
  readonly modelRef: SessionModelRef
  /**
   * Targets that were current earlier in the conversation but no longer are.
   * Deduped by target id, ordered by the first time each stopped being current.
   * Write-only in v1: persisted for inspection, with no runtime reader.
   */
  readonly pastModels: ReadonlyArray<SessionModelRef>
  readonly permissionMode: PermissionMode
  readonly currentDate: string
}

/** Canonical `provider:modelId[:variant]` key for a model ref. */
export const modelRefKey = (ref: SessionModelRef): string =>
  ref.variant !== undefined && ref.variant !== ""
    ? `${ref.provider}:${ref.modelId}:${ref.variant}`
    : `${ref.provider}:${ref.modelId}`

const deriveModelRef = (model: Model): SessionModelRef => ({
  provider: model.provider,
  modelId: model.id,
})

export interface SessionCounters {
  turns: number
  inputTokens: number
  outputTokens: number
}

/**
 * Context accounting derived from the last provider usage snapshot. Local
 * transcript added after `measuredAtMessageIndex` is estimated and added on top
 * before each request. A mutation to an older message invalidates the snapshot.
 */
export interface ContextUsageState {
  readonly activeContextTokens: number
  readonly measuredAtMessageIndex: number
}

/**
 * Bounded compaction policy for a session. Exactly one compound summary is kept
 * and updated on each later compaction. `autoEnabled` starts true and is
 * disabled after the first automatic compaction failure; manual `/compact`
 * ignores it.
 */
export interface SessionCompactionState {
  readonly autoEnabled: boolean
  readonly failureReason?: string
  readonly lastCompactedAt?: string
  readonly summary?: string
}

export interface SessionState {
  readonly sessionId: string
  readonly workingDirectory: string
  readonly systemContext: SystemContext
  readonly fileState: FileStateCache
  readonly locks: Map<string, Effect.Semaphore>
  readonly messages: Array<Message>
  readonly counters: SessionCounters
  readonly compaction: SessionCompactionState
  /** Undefined until the first provider usage is recorded. */
  contextUsage?: ContextUsageState
}

export interface CreateSessionInput {
  readonly sessionId?: string
  readonly workingDirectory: string
  readonly model: Model
  /** Defaults to `{ provider, modelId }` derived from `model` when omitted. */
  readonly modelRef?: SessionModelRef
  readonly requestOptions?: RequestOptions
  readonly pastModels?: ReadonlyArray<SessionModelRef>
  readonly permissionMode?: PermissionMode
  readonly currentDate: string
  readonly messages?: ReadonlyArray<Message>
  readonly compaction?: SessionCompactionState
}

export const createSessionState = (input: CreateSessionInput): SessionState => ({
  sessionId: input.sessionId ?? crypto.randomUUID(),
  workingDirectory: input.workingDirectory,
  systemContext: {
    model: input.model,
    requestOptions: input.requestOptions ?? {},
    modelRef: input.modelRef ?? deriveModelRef(input.model),
    pastModels: input.pastModels ?? [],
    permissionMode: input.permissionMode ?? "ask",
    currentDate: input.currentDate,
  },
  fileState: new Map(),
  locks: new Map(),
  messages: [...(input.messages ?? [])],
  counters: { turns: 0, inputTokens: 0, outputTokens: 0 },
  compaction: input.compaction ?? { autoEnabled: true },
})

export interface ModelTransition {
  readonly model: Model
  readonly modelRef: SessionModelRef
  readonly requestOptions: RequestOptions
}

/**
 * Switches the session's current model to `next`. A same-target transition only
 * refreshes the live model and request options. Otherwise the previous
 * `modelRef` moves into `pastModels` (deduped by target id, keeping the first
 * time it stopped being current), and the new target becomes current. Returns
 * the previous ref when the target actually changed, else `undefined` — callers
 * use it to record a transcript switch event.
 */
export const recordModelTransition = (
  session: SessionState,
  next: ModelTransition,
): SessionModelRef | undefined => {
  const previous = session.systemContext.modelRef
  if (modelRefKey(previous) === modelRefKey(next.modelRef)) {
    Object.assign(session.systemContext, {
      model: next.model,
      requestOptions: next.requestOptions,
    })
    return undefined
  }
  const past = session.systemContext.pastModels
  const pastModels = past.some((ref) => modelRefKey(ref) === modelRefKey(previous))
    ? past
    : [...past, previous]
  Object.assign(session.systemContext, {
    model: next.model,
    modelRef: next.modelRef,
    requestOptions: next.requestOptions,
    pastModels,
  })
  return previous
}

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
