import type { Message } from "@swain/llms"
import { assembleSystemPrompt } from "./prompt"
import type { SessionCounters, SessionState } from "./state"

/**
 * The native trace schema is versioned independently of any framework format.
 * Bump this only when the serialized shape below changes incompatibly; the
 * downstream ATIF converter keys off it.
 */
export const TRACE_SCHEMA_VERSION = 1

/** Terminal disposition of a traced session. */
export type TraceOutcome =
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "interrupted"; readonly signal?: string }

/** Serializable model target of a traced session (routing is off; one model). */
export interface TraceModelRef {
  readonly provider: string
  readonly modelId: string
  readonly variant?: string
}

/** Name/description pair for a tool the traced session could call. */
export interface TraceToolDescriptor {
  readonly name: string
  readonly description: string
}

/**
 * Identity of a traced session within the run graph. The root omits `taskId`
 * and `parentAgentId`; a child carries both plus its spawning agent type.
 */
export interface TraceIdentity {
  readonly agentId: string
  /** `"root"` for the top session; the subagent type for a child. */
  readonly agentType: string
  readonly taskId?: string
  readonly parentAgentId?: string
}

/**
 * A single self-contained native trace file: the root snapshot or one child
 * snapshot. Holds only serializable facts the ATIF converter needs — never the
 * live model functions, file caches, or lock semaphores on `SessionState`.
 */
export interface NativeTrace {
  readonly schemaVersion: typeof TRACE_SCHEMA_VERSION
  readonly swainVersion: string
  readonly sessionId: string
  readonly agentId: string
  readonly agentType: string
  readonly taskId?: string
  readonly parentAgentId?: string
  readonly model: TraceModelRef
  readonly permissionMode: string
  readonly workingDirectory: string
  /** The exact system prompt assembled from this session and its tool registry. */
  readonly systemPrompt: string
  readonly messages: ReadonlyArray<Message>
  readonly counters: SessionCounters
  readonly outcome: TraceOutcome
}

export interface ProjectTraceInput {
  readonly session: SessionState
  readonly identity: TraceIdentity
  /** The effective tool registry the session ran with (names/descriptions only). */
  readonly tools: ReadonlyArray<TraceToolDescriptor>
  readonly swainVersion: string
  readonly outcome: TraceOutcome
  /** True for headless exec runs; folds the non-interactive guidance into the prompt. */
  readonly nonInteractive?: boolean
}

/**
 * Pure projection of a live session into a serializable native trace. Reassembles
 * the exact system prompt from the same inputs the agent loop uses (routing is
 * off, so no router block), and copies committed messages and counters verbatim.
 */
export const projectTrace = (input: ProjectTraceInput): NativeTrace => {
  const { session, identity } = input
  const modelRef = session.systemContext.modelRef
  const systemPrompt = assembleSystemPrompt({
    workingDirectory: session.workingDirectory,
    currentDate: session.systemContext.currentDate,
    model: session.systemContext.model.id,
    permissionMode: session.systemContext.permissionMode,
    tools: input.tools,
    ...(input.nonInteractive === true && { nonInteractive: true }),
  })
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    swainVersion: input.swainVersion,
    sessionId: session.sessionId,
    agentId: identity.agentId,
    agentType: identity.agentType,
    ...(identity.taskId !== undefined && { taskId: identity.taskId }),
    ...(identity.parentAgentId !== undefined && { parentAgentId: identity.parentAgentId }),
    model: {
      provider: modelRef.provider,
      modelId: modelRef.modelId,
      ...(modelRef.variant !== undefined && { variant: modelRef.variant }),
    },
    permissionMode: session.systemContext.permissionMode,
    workingDirectory: session.workingDirectory,
    systemPrompt,
    messages: session.messages,
    counters: { ...session.counters },
    outcome: input.outcome,
  }
}
