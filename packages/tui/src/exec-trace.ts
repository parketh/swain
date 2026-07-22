import { randomUUID } from "node:crypto"
import { renameSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join as pathJoin } from "node:path"
import {
  type ChildTraceEvent,
  type NativeTrace,
  projectTrace,
  type SessionState,
  TRACE_SCHEMA_VERSION,
  type TraceIdentity,
  type TraceOutcome,
  type TraceToolDescriptor,
} from "@swain/core"

/** One child entry in the manifest, linking an agent id to its trace file. */
interface ManifestChild {
  readonly agentId: string
  readonly taskId: string
  readonly file: string
}

/** Top-level index of the native trace bundle. */
interface TraceManifest {
  readonly schemaVersion: typeof TRACE_SCHEMA_VERSION
  readonly swainVersion: string
  readonly rootAgentId: string
  readonly root: string
  readonly children: ReadonlyArray<ManifestChild>
}

export interface TraceRecorderOptions {
  readonly dir: string
  readonly swainVersion: string
  readonly rootAgentId: string
  readonly nonInteractive?: boolean
  /** Redacts known credentials from trace values before they are written. */
  readonly redact?: <T>(value: T) => T
}

export interface RootFinalizeInput {
  readonly session: SessionState
  readonly tools: ReadonlyArray<TraceToolDescriptor>
  readonly outcome: TraceOutcome
}

const ROOT_FILE = "root.json"
const SUBAGENTS_DIR = "subagents"

/** UUID-derived agent ids are filename-safe; sanitize defensively regardless. */
const safeName = (agentId: string): string => agentId.replace(/[^A-Za-z0-9_-]/g, "_")

/**
 * Owns the on-disk native trace bundle for one headless exec run: creates the
 * directory up front (so a bad path fails before any tokens are spent), writes
 * each child snapshot as it completes, and finalizes the root plus manifest at
 * the end. Writes are atomic (sibling temp file + rename). The recorder never
 * throws from `recordChild`; it captures the first write error so the caller can
 * fail the run after the graph is idle.
 */
export interface TraceRecorder {
  /** Child sink for the orchestrator; projects and writes one child trace. */
  readonly recordChild: (event: ChildTraceEvent) => Promise<void>
  /** Writes `root.json` and `manifest.json`. Surfaces the first recorder error. */
  readonly finalizeRoot: (input: RootFinalizeInput) => Promise<void>
  /** The first write error observed, if any. */
  readonly firstError: () => Error | undefined
}

/**
 * Serializes a value to a file atomically: write a sibling temp, then rename.
 * Uses synchronous fs because these small, infrequent writes run inside the
 * orchestrator's completion path; a pending async write there can be starved by
 * the Effect runtime and stall the whole run.
 */
const writeAtomic = (path: string, value: unknown): void => {
  const tmp = `${path}.${randomUUID()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error))

/**
 * Creates the trace directory (and its `subagents/` subdirectory) eagerly, so an
 * unwritable requested path fails the exec instead of silently claiming ATIF
 * support. Throws on directory-creation failure.
 */
export const initTraceRecorder = async (options: TraceRecorderOptions): Promise<TraceRecorder> => {
  await mkdir(pathJoin(options.dir, SUBAGENTS_DIR), { recursive: true })

  const redact = options.redact ?? (<T>(value: T): T => value)
  const children: Array<ManifestChild> = []
  let firstError: Error | undefined
  const capture = (error: unknown): void => {
    if (firstError === undefined) firstError = asError(error)
  }

  const recordChild = async (event: ChildTraceEvent): Promise<void> => {
    // Never throw: the orchestrator awaits this before offering completion, so a
    // projection or write failure must be captured, not propagated.
    try {
      const identity: TraceIdentity = {
        agentId: event.agentId,
        agentType: event.agentType,
        taskId: event.taskId,
        parentAgentId: options.rootAgentId,
      }
      const outcome: TraceOutcome = event.outcome.ok
        ? { status: "completed" }
        : { status: "failed", error: event.outcome.error }
      const trace: NativeTrace = projectTrace({
        session: event.session,
        identity,
        tools: event.tools,
        swainVersion: options.swainVersion,
        outcome,
        ...(options.nonInteractive === true && { nonInteractive: true }),
      })
      const file = pathJoin(SUBAGENTS_DIR, `${safeName(event.agentId)}.json`)
      writeAtomic(pathJoin(options.dir, file), redact(trace))
      children.push({ agentId: event.agentId, taskId: event.taskId, file })
    } catch (error) {
      capture(error)
    }
  }

  const finalizeRoot = async (input: RootFinalizeInput): Promise<void> => {
    const trace: NativeTrace = projectTrace({
      session: input.session,
      identity: { agentId: options.rootAgentId, agentType: "root" },
      tools: input.tools,
      swainVersion: options.swainVersion,
      outcome: input.outcome,
      ...(options.nonInteractive === true && { nonInteractive: true }),
    })
    const manifest: TraceManifest = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      swainVersion: options.swainVersion,
      rootAgentId: options.rootAgentId,
      root: ROOT_FILE,
      children,
    }
    try {
      writeAtomic(pathJoin(options.dir, ROOT_FILE), redact(trace))
      writeAtomic(pathJoin(options.dir, "manifest.json"), manifest)
    } catch (error) {
      capture(error)
    }
  }

  return { recordChild, finalizeRoot, firstError: () => firstError }
}
