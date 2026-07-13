import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join as pathJoin } from "node:path"
import type { HttpClient } from "@effect/platform"
import {
  type AgentEvent,
  type AgentType,
  type Approval,
  submitPrompt as coreSubmitPrompt,
  createSessionState,
  listTasks,
  loadSession,
  loadTaskStore,
  makeOrchestrator,
  markParentNotified,
  type Orchestrator,
  OrchestratorService,
  type PermissionDecision,
  type PermissionMode,
  pendingParentNotifications,
  readPersistedModelRef,
  recordInterruption,
  recordModelTransition,
  removeTaskWorktrees,
  resetDanglingTasks,
  runTurn,
  type SessionModelRef,
  type SessionState,
  type SubagentEvent,
  saveSession,
  type Task,
  TaskStore,
  type TaskStoreService,
} from "@swain/core"
import type { AskHandler, AskInput, AskResult } from "@swain/core/tools"
import type { GenerationOptions, ProviderOptions } from "@swain/llms"
import { LLMClient } from "@swain/llms/client"
import { Effect, Fiber, Layer, Queue } from "effect"
import { authPath, saveAuth } from "./auth"
import type { CommandParseResult } from "./commands"
import {
  type ActiveModel,
  type ProviderConfig,
  saveConfig,
  sessionsDir,
  type TuiConfig,
} from "./config"
import { appendHistory, historyPath, saveHistory } from "./history"
import { modelResolverLayer } from "./model-resolver"
import {
  availableModels,
  connectableProviders,
  defaultVariantId,
  freeModel,
  type ModelOption,
  type ProviderOption,
  resolveModelSelection,
} from "./models"
import {
  modelKey,
  type RouterStatus,
  routerPromptTargets,
  routerSettings,
  routerStatus,
} from "./router"
import { type LLMClientService, makeRuntime, toolContextLayer } from "./runtime"
import { type UsageSnapshot, usageSnapshot } from "./usage"

export interface RequestOptions {
  readonly providerOptions?: ProviderOptions
  readonly generation?: GenerationOptions
}

export interface TuiState {
  readonly session: SessionState
  readonly permissionMode: PermissionMode
  /** Global default model (config); seeds new sessions and drives the "connect a provider" check. */
  readonly activeModel: ActiveModel
  /** The conversation's current model, which can diverge from `activeModel` after a router switch. */
  readonly currentModel: ActiveModel
  readonly connectableProviders: ReadonlyArray<ProviderOption>
  readonly availableModels: ReadonlyArray<ModelOption>
  readonly routerStatus: RouterStatus
  readonly running: boolean
}

/** A connected model row for the /router dialog, with per-variant enablement. */
export interface RouterModelView {
  readonly provider: string
  readonly modelId: string
  readonly label: string
  readonly providerLabel: string
  readonly enabled: boolean
  readonly variants: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly enabled: boolean
  }>
}

export interface RouterView {
  readonly enabled: boolean
  readonly status: RouterStatus
  readonly models: ReadonlyArray<RouterModelView>
}

export interface PendingQuestion {
  readonly id: number
  readonly input: AskInput
}

export interface PendingApproval {
  readonly id: number
  readonly request: Parameters<Approval["requestApproval"]>[0]
}

export interface ConnectResult {
  readonly ok: boolean
  readonly error?: string
}

/** A live, still-running subagent, surfaced in the subagent monitor panel. */
export interface SubagentStatus {
  readonly agentId: string
  readonly agentType: AgentType
  readonly description: string
  /** Epoch ms when the spawn event was observed, for the elapsed-time display. */
  readonly startedAt: number
  readonly lastTool?: string
  readonly lastToolInput?: unknown
  readonly toolUseCount: number
}

export interface SavedSession {
  readonly sessionId: string
  readonly modifiedMs: number
  /** Cached one-line summary of the conversation, if one has been generated. */
  readonly summary?: string
  /** First user prompt, used as a label before/without a summary. */
  readonly firstPrompt?: string
}

export interface ControllerDeps {
  readonly session: SessionState
  readonly activeModel: ActiveModel
  readonly config: TuiConfig
  readonly configPath: string
  /** Global prompt history, most recent last; loaded once at startup. */
  readonly history?: ReadonlyArray<string>
  readonly requestOptions?: RequestOptions
  readonly llmLayer?: Layer.Layer<LLMClientService>
  readonly httpLayer?: Layer.Layer<HttpClient.HttpClient>
  /** Persist session/config on mutations. Off in tests that don't assert I/O. */
  readonly persist?: boolean
}

const NEXT_MODE: Record<PermissionMode, PermissionMode> = {
  ask: "auto",
  auto: "plan",
  plan: "ask",
}

export interface Controller {
  getState(): TuiState
  getRequestOptions(): RequestOptions
  getUsage(): UsageSnapshot
  /** Current session task list, refreshed after turns and subagent lifecycle. */
  getTasks(): ReadonlyArray<Task>
  /** Currently running subagents, for the live monitor panel. */
  getSubagents(): ReadonlyArray<SubagentStatus>
  subscribe(listener: () => void): () => void
  onEvent(listener: (event: AgentEvent) => void): () => void
  onQuestion(listener: (request: PendingQuestion) => void): () => void
  onApproval(listener: (request: PendingApproval) => void): () => void
  answerQuestion(id: number, answers: AskResult["answers"]): void
  resolveApproval(id: number, decision: PermissionDecision): void
  submitPrompt(text: string): Promise<void>
  executeCommand(result: CommandParseResult): Promise<void>
  /** Global prompt history, most recent last. */
  getHistory(): ReadonlyArray<string>
  /** Records a submitted prompt to global history and persists it. */
  recordPrompt(text: string): void
  cyclePermissionMode(): void
  selectModel(provider: string, modelId: string, variant?: string): Promise<void>
  setVariant(variant?: string): Promise<void>
  connectProvider(provider: string, creds: ProviderConfig): Promise<ConnectResult>
  /** Connected models with router enablement, for the /router dialog. */
  getRouterView(): RouterView
  /** Toggles the global router master switch. */
  setRouterEnabled(enabled: boolean): Promise<void>
  /** Toggles a whole model in/out of routing (all its variants). */
  toggleRouterModel(provider: string, modelId: string): Promise<void>
  /** Toggles a single variant target in/out of routing. */
  toggleRouterTarget(targetId: string): Promise<void>
  refreshAvailableModels(): void
  clearConversation(): void
  resumeSession(sessionId: string): Promise<void>
  listSessions(): ReadonlyArray<SavedSession>
  /**
   * Generates and caches one-line summaries for any saved sessions that lack
   * one, using a free keyless model. Best-effort and idempotent; notifies
   * subscribers as each summary lands. Safe to call when unconfigured.
   */
  ensureSummaries(): Promise<void>
  interrupt(): void
  /**
   * Cancels the running turn but preserves it (like Claude Code): the partial
   * assistant text (`partialText`) is committed, any orphan tool calls are
   * answered, and an interrupt marker is appended. Tasks the turn created are
   * kept. No-op when nothing is running.
   */
  cancelTurn(partialText?: string): Promise<void>
  dispose(): void
}

/**
 * Bridges UI actions to Effect programs, core sessions, and the model registry.
 * Owns controller state (`TuiState`); transcript/draft display state lives in
 * React. Forwards each `AgentEvent` to subscribers as it arrives.
 */
export const makeController = (deps: ControllerDeps): Controller => {
  const persist = deps.persist ?? true

  let session = deps.session
  // Global default model, used to seed new sessions and persisted to config.
  // The conversation's *current* model can diverge from this after a router
  // SwitchModel, so display/usage read `currentModel()` (the live session ref)
  // rather than this variable.
  let activeModel = deps.activeModel
  const currentModel = (): ActiveModel => {
    const ref = session.systemContext.modelRef
    return {
      provider: ref.provider,
      modelId: ref.modelId,
      ...(ref.variant !== undefined && { variant: ref.variant }),
    }
  }
  let config = deps.config
  let requestOptions: RequestOptions = deps.requestOptions ?? {}
  let history = deps.history ?? []
  let running = false

  let availableCache = availableModels(config)
  let connectableCache = connectableProviders(config)

  const stateListeners = new Set<() => void>()
  const eventListeners = new Set<(event: AgentEvent) => void>()
  const questionListeners = new Set<(request: PendingQuestion) => void>()
  const approvalListeners = new Set<(request: PendingApproval) => void>()
  const pendingQuestions = new Map<number, (result: AskResult) => void>()
  const pendingApprovals = new Map<number, (decision: PermissionDecision) => void>()

  let idCounter = 0
  const nextId = (): number => {
    idCounter += 1
    return idCounter
  }

  const notify = (): void => {
    for (const listener of stateListeners) listener()
  }
  const emitEvent = (event: AgentEvent): void => {
    for (const listener of eventListeners) listener(event)
  }

  const refreshDerived = (): void => {
    availableCache = availableModels(config)
    connectableCache = connectableProviders(config)
  }

  const askHandler: AskHandler = {
    ask: (input) =>
      Effect.async<AskResult>((resume) => {
        const id = nextId()
        pendingQuestions.set(id, (result) => {
          pendingQuestions.delete(id)
          resume(Effect.succeed(result))
        })
        for (const listener of questionListeners) listener({ id, input })
      }),
  }

  const approval: Approval = {
    requestApproval: (request) =>
      Effect.async<PermissionDecision>((resume) => {
        const id = nextId()
        pendingApprovals.set(id, (decision) => {
          pendingApprovals.delete(id)
          resume(Effect.succeed(decision))
        })
        for (const listener of approvalListeners) listener({ id, request })
      }),
  }

  const runtime = makeRuntime({
    askHandler,
    ...(deps.llmLayer !== undefined && { llmLayer: deps.llmLayer }),
    ...(deps.httpLayer !== undefined && { httpLayer: deps.httpLayer }),
  })

  const sessionsDirFor = (s: SessionState): string =>
    sessionsDir(deps.configPath, s.workingDirectory)

  // --- Task store + subagent orchestration (per session) ------------------

  const sessionDirFor = (s: SessionState): string => pathJoin(sessionsDirFor(s), s.sessionId)

  interface SessionEnv {
    readonly taskStore: TaskStoreService
    readonly orchestrator: Orchestrator
    readonly layers: Layer.Layer<TaskStore | OrchestratorService>
    readonly listener: Fiber.RuntimeFiber<void, unknown>
  }

  let sessionEnv: SessionEnv | undefined
  let sessionEnvPromise: Promise<SessionEnv> | undefined
  let drainPending = false
  let draining = false
  let disposed = false
  let currentTasks: ReadonlyArray<Task> = []
  const subagentMap = new Map<string, SubagentStatus>()
  let currentSubagents: ReadonlyArray<SubagentStatus> = []

  // Maintains the live subagent monitor from orchestrator lifecycle events. A
  // finished agent is dropped immediately; its result surfaces via the task
  // notification drain, not this panel.
  const updateSubagents = (event: SubagentEvent): void => {
    if (event.type === "subagent-start") {
      subagentMap.set(event.agentId, {
        agentId: event.agentId,
        agentType: event.agentType,
        description: event.description,
        startedAt: Date.now(),
        toolUseCount: 0,
      })
    } else if (event.type === "subagent-progress") {
      const current = subagentMap.get(event.agentId)
      if (current !== undefined) {
        subagentMap.set(event.agentId, {
          ...current,
          ...(event.lastTool !== undefined && { lastTool: event.lastTool }),
          ...(event.lastToolInput !== undefined && { lastToolInput: event.lastToolInput }),
          toolUseCount: event.toolUseCount,
        })
      }
    } else {
      subagentMap.delete(event.agentId)
    }
    currentSubagents = Array.from(subagentMap.values())
    notify()
  }

  const buildSessionEnv = async (s: SessionState): Promise<SessionEnv> => {
    const taskStore = await runtime.runPromise(loadTaskStore(sessionDirFor(s)))
    const orchestrator = await runtime.runPromise(
      makeOrchestrator({
        onEvent: (event) =>
          Effect.sync(() => {
            emitEvent(event)
            updateSubagents(event)
            // Progress events don't change task state; only lifecycle edges do.
            if (event.type !== "subagent-progress") void refreshTasks()
          }),
      }),
    )
    const layers = Layer.merge(
      Layer.succeed(TaskStore, taskStore),
      Layer.succeed(OrchestratorService, orchestrator),
    )
    // A single parked fiber: blocks on the wake-up queue, drains on each ring.
    const listener = runtime.runFork(
      Effect.forever(
        Queue.take(orchestrator.completions).pipe(
          Effect.flatMap(() => Effect.sync(() => void maybeDrainCompletions())),
        ),
      ),
    )
    return { taskStore, orchestrator, layers, listener }
  }

  const ensureSessionEnv = (): Promise<SessionEnv> => {
    if (sessionEnv !== undefined) return Promise.resolve(sessionEnv)
    if (sessionEnvPromise === undefined) {
      sessionEnvPromise = buildSessionEnv(session).then((env) => {
        sessionEnv = env
        return env
      })
    }
    return sessionEnvPromise
  }

  const teardownSessionEnv = async (): Promise<void> => {
    const env = sessionEnv
    sessionEnv = undefined
    sessionEnvPromise = undefined
    currentTasks = []
    subagentMap.clear()
    currentSubagents = []
    if (env === undefined) return
    await runtime.runPromise(env.orchestrator.interruptAll).catch(() => {})
    await runtime.runPromise(Fiber.interrupt(env.listener)).catch(() => {})
  }

  const renderNotification = (task: Task): string => {
    const failed = task.status === "failed"
    const body = (failed ? task.error : task.result) ?? ""
    const worktree =
      task.worktreePath !== undefined
        ? `\nRetained worktree: ${task.worktreePath}${
            task.worktreeBranch !== undefined ? ` (branch ${task.worktreeBranch})` : ""
          }`
        : ""
    return `Subagent "${task.subject}" [${task.agentType ?? "?"}] ${
      failed ? "failed" : "completed"
    }:\n${body}${worktree}`
  }

  // Decides drain-or-defer right now (not a scheduled timer): the payload is
  // always re-read from the durable TaskStore, never the wake-up queue.
  // Appends finished subagent results as one synthetic `<task-notification>`
  // user message and marks them notified. Injection only — the caller decides
  // whether to run a parent turn. Returns true if anything was injected.
  const injectPendingNotifications = async (): Promise<boolean> => {
    const env = await ensureSessionEnv()
    if (disposed) return false
    const pending = await runtime.runPromise(
      pendingParentNotifications().pipe(Effect.provide(env.layers)),
    )
    if (pending.length === 0 || disposed) return false
    const block = pending.map(renderNotification).join("\n\n")
    // The `<task-notification>` wrapper is payload for the model; the isMeta flag
    // is the typed marker every consumer uses to tell this from real user input.
    coreSubmitPrompt(session, `<task-notification>\n${block}\n</task-notification>`, true)
    await runtime.runPromise(
      markParentNotified(pending.map((t) => t.id)).pipe(Effect.provide(env.layers)),
    )
    notify()
    return true
  }

  const maybeDrainCompletions = async (): Promise<void> => {
    if (running || draining || disposed) {
      if (!disposed) drainPending = true
      return
    }
    draining = true
    let injected = false
    try {
      injected = await injectPendingNotifications()
    } catch {
      // Runtime disposed or a transient store error: drop this drain attempt.
    } finally {
      draining = false
    }
    if (injected && !disposed) await runTurnNow()
  }

  const refreshTasks = async (): Promise<void> => {
    if (disposed) return
    try {
      const env = await ensureSessionEnv()
      const tasks = await runtime.runPromise(listTasks().pipe(Effect.provide(env.layers)))
      currentTasks = tasks
      emitEvent({ type: "task-updated", tasks })
      notify()
    } catch {
      // Store unavailable (disposed/transient): keep the last known task list.
    }
  }

  // On session load (initial/resume/clear): make the session inert. Reset
  // dangling subagent tasks to pending WITHOUT re-spawning — resuming must never
  // auto-run agents; the user (or the next prompt) decides. Surface any results
  // that completed while closed as a notification, but do not run a parent turn.
  const startSession = async (): Promise<void> => {
    if (disposed) return
    try {
      const env = await ensureSessionEnv()
      if (disposed) return
      const reset = await runtime.runPromise(resetDanglingTasks().pipe(Effect.provide(env.layers)))
      // Remove the orphaned worktrees of subagents that died while closed. No
      // re-spawn here (resume must not auto-run agents); just reclaim the disk.
      await runtime.runPromise(
        removeTaskWorktrees(session.workingDirectory, reset).pipe(Effect.provide(env.layers)),
      )
      await injectPendingNotifications()
    } catch {
      // Best-effort: a dangling task simply stays for the next start.
    }
    await refreshTasks()
  }

  // --- Session summaries (resume picker labels) ---------------------------

  // biome-ignore lint/suspicious/noExplicitAny: persisted messages are opaque here
  const textOf = (message: any): string =>
    Array.isArray(message?.content)
      ? message.content
          // biome-ignore lint/suspicious/noExplicitAny: opaque content block
          .filter((b: any) => b?.type === "text" && typeof b.text === "string")
          // biome-ignore lint/suspicious/noExplicitAny: opaque content block
          .map((b: any) => b.text as string)
          .join(" ")
          .trim()
      : ""

  const readMessageLines = (dir: string): ReadonlyArray<string> => {
    try {
      return readFileSync(pathJoin(dir, "messages.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
    } catch {
      return []
    }
  }

  const readFirstPrompt = (dir: string): string | undefined => {
    for (const line of readMessageLines(dir)) {
      try {
        const message = JSON.parse(line)
        if (message.role === "user") {
          const text = textOf(message)
          if (text !== "") return text.replace(/\s+/g, " ").slice(0, 120)
        }
      } catch {}
    }
    return undefined
  }

  const readSummary = (dir: string): string | undefined => {
    try {
      const text = readFileSync(pathJoin(dir, "summary.txt"), "utf8").trim()
      return text.length > 0 ? text : undefined
    } catch {
      return undefined
    }
  }

  const listSessions = (): ReadonlyArray<SavedSession> => {
    const dir = sessionsDirFor(session)
    let names: ReadonlyArray<string>
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return []
    }
    const sessions: Array<SavedSession> = []
    for (const name of names) {
      const sdir = pathJoin(dir, name)
      let modifiedMs: number
      try {
        // A dir holding only tasks.json (a session whose first turn hasn't
        // saved yet) has no session.json — skip it instead of failing the list.
        modifiedMs = statSync(pathJoin(sdir, "session.json")).mtimeMs
      } catch {
        continue
      }
      const summary = readSummary(sdir)
      const firstPrompt = readFirstPrompt(sdir)
      sessions.push({
        sessionId: name,
        modifiedMs,
        ...(summary !== undefined && { summary }),
        ...(firstPrompt !== undefined && { firstPrompt }),
      })
    }
    return sessions.sort((a, b) => b.modifiedMs - a.modifiedMs)
  }

  const SUMMARY_SYSTEM =
    "Write a terse title of at most 8 words describing what this conversation is about. " +
    "Output only the title — no quotes, no trailing punctuation, no preamble."

  // A short transcript excerpt (leading turns) is enough to title a session.
  const summaryExcerpt = (dir: string): string => {
    const parts: Array<string> = []
    for (const line of readMessageLines(dir)) {
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      // biome-ignore lint/suspicious/noExplicitAny: opaque persisted message
      const text = textOf(message as any)
      if (text === "") continue
      // biome-ignore lint/suspicious/noExplicitAny: opaque persisted message
      const role = (message as any).role === "user" ? "User" : "Assistant"
      parts.push(`${role}: ${text}`)
      if (parts.join("\n").length > 1500) break
    }
    return parts.join("\n").slice(0, 2000)
  }

  let summarizing = false
  // Summaries always use the free keyless model: cheap, and never spends the
  // user's paid tokens on a background chore.
  const generateSummary = async (dir: string): Promise<void> => {
    const excerpt = summaryExcerpt(dir)
    if (excerpt === "") return
    const request = LLMClient.request({
      model: freeModel(),
      system: SUMMARY_SYSTEM,
      prompt: excerpt,
      generation: { maxTokens: 32 },
    })
    try {
      const response = await runtime.runPromise(LLMClient.generateTurn(request))
      const text = response.events
        .map((event) => (event.type === "text-delta" ? event.text : ""))
        .join("")
        .trim()
      const line = text
        .split("\n")[0]
        ?.trim()
        .replace(/^["']|["']$/g, "")
        .slice(0, 80)
      if (line !== undefined && line !== "") writeFileSync(pathJoin(dir, "summary.txt"), line)
    } catch {
      // Best-effort: leave the first-prompt fallback label in place.
    }
  }

  const historyFile = historyPath(deps.configPath)
  // Serialize writes so overlapping records can't land out of order and persist
  // a stale snapshot; each queued write re-reads the latest `history`.
  let historyWrite: Promise<void> = Promise.resolve()
  const recordPrompt = (text: string): void => {
    const next = appendHistory(history, text)
    if (next === history) return
    history = next
    if (!persist) return
    historyWrite = historyWrite.then(() =>
      runtime.runPromise(saveHistory(historyFile, history)).catch(() => {}),
    )
  }

  let currentAbort: AbortController | undefined
  let currentFiber: Fiber.RuntimeFiber<void, unknown> | undefined

  const runTurnNow = async (): Promise<void> => {
    const env = await ensureSessionEnv()
    running = true
    notify()
    const abort = new AbortController()
    currentAbort = abort
    const ctxLayer = toolContextLayer(
      session,
      session.systemContext.permissionMode,
      approval,
      abort.signal,
    )
    const effect = runTurn(session, {
      onEvent: (event) =>
        Effect.sync(() => {
          emitEvent(event)
          // Live-refresh the task panel when the model mutates its to-do list
          // mid-turn, instead of waiting for the whole turn to finish.
          if (
            event.type === "tool-execution-end" &&
            (event.name === "TaskCreate" || event.name === "TaskUpdate")
          ) {
            void refreshTasks()
          }
          // A router SwitchModel changes the current model mid-turn; refresh so
          // the status line reflects the new target immediately.
          if (event.type === "model-switch") notify()
        }),
      // Request options now travel through session.systemContext.requestOptions,
      // so a mid-turn SwitchModel can replace them. The router context is passed
      // only when routing is active; its presence exposes SwitchModel.
      ...(routerStatus(config) === "on" && {
        router: { targets: routerPromptTargets(config) },
      }),
    }).pipe(
      Effect.provide(ctxLayer),
      Effect.provide(env.layers),
      Effect.provide(modelResolverLayer(() => config)),
    )
    const fiber = runtime.runFork(effect)
    currentFiber = fiber
    try {
      await runtime.runPromise(Fiber.join(fiber))
      if (persist) await runtime.runPromise(saveSession(session, sessionsDirFor(session)))
    } catch {
      // Fatal LLM/agent failures are surfaced through onEvent as agent-error;
      // interruptions leave the partial draft visible without being persisted.
    } finally {
      running = false
      currentAbort = undefined
      currentFiber = undefined
      notify()
      // The turn may have created or updated tasks (its own to-do list).
      void refreshTasks()
      // A subagent that completed mid-turn deferred its drain; flush it now.
      if (drainPending) {
        drainPending = false
        void maybeDrainCompletions()
      }
    }
  }

  const setActiveMode = (mode: PermissionMode): void => {
    Object.assign(session.systemContext, { permissionMode: mode })
  }

  const persistConfig = async (next: TuiConfig): Promise<ConnectResult> => {
    if (!persist) {
      config = next
      refreshDerived()
      return { ok: true }
    }
    try {
      await runtime.runPromise(saveConfig(deps.configPath, next))
      await runtime.runPromise(saveAuth(authPath(deps.configPath), next.providers))
      config = next
      refreshDerived()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  }

  const applySelection = async (
    provider: string,
    modelId: string,
    variant: string | undefined,
  ): Promise<void> => {
    const result = resolveModelSelection(provider, modelId, variant, config)
    if (result.type === "error") {
      emitEvent({ type: "agent-error", source: "agent", message: result.error.message })
      return
    }
    const modelRef: SessionModelRef = {
      provider,
      modelId,
      ...(variant !== undefined && { variant }),
    }
    // Record a session-local transition so /model "steers" the conversation:
    // the previous target moves into pastModels and this becomes current.
    recordModelTransition(session, {
      model: result.selection.model,
      modelRef,
      requestOptions: result.selection.requestOptions,
    })
    activeModel = { provider, modelId, ...(variant !== undefined && { variant }) }
    requestOptions = result.selection.requestOptions
    await persistConfig({ ...config, activeModel })
    notify()
  }

  const submitPrompt = async (text: string): Promise<void> => {
    coreSubmitPrompt(session, text)
    notify()
    await runTurnNow()
  }

  const clearConversation = (): void => {
    const previous = session
    // A new conversation starts from the global default (activeModel), not the
    // previous session's possibly auto-routed current model. Resolve it fresh so
    // the model and request options match the default rather than a routed target.
    const resolved = resolveModelSelection(
      activeModel.provider,
      activeModel.modelId,
      activeModel.variant,
      config,
    )
    const model = resolved.type === "ok" ? resolved.selection.model : previous.systemContext.model
    if (resolved.type === "ok") requestOptions = resolved.selection.requestOptions
    session = createSessionState({
      workingDirectory: previous.workingDirectory,
      model,
      modelRef: {
        provider: activeModel.provider,
        modelId: activeModel.modelId,
        ...(activeModel.variant !== undefined && { variant: activeModel.variant }),
      },
      requestOptions,
      permissionMode: previous.systemContext.permissionMode,
      currentDate: previous.systemContext.currentDate,
    })
    notify()
    if (persist && previous.messages.length > 0) {
      void runtime
        .runPromise(saveSession(previous, sessionsDirFor(previous)))
        .catch(() => undefined)
    }
    void teardownSessionEnv().then(startSession)
  }

  // Runs the "terminal" commands directly; interactive commands (model/variants
  // with no args, connect, resume, usage, help) are opened as overlays by the
  // UI, which then calls the specific controller action.
  const executeCommand = async (result: CommandParseResult): Promise<void> => {
    if (result.type === "prompt") {
      await submitPrompt(result.text)
      return
    }
    if (result.type === "unknown-command") return
    switch (result.name) {
      case "clear":
        clearConversation()
        return
      case "plan": {
        setActiveMode("plan")
        notify()
        if (result.args.trim() !== "") await submitPrompt(result.args)
        return
      }
      case "model": {
        const [provider, modelId, variant] = result.args.trim().split(/\s+/)
        if (provider !== undefined && provider !== "" && modelId !== undefined && modelId !== "") {
          await applySelection(provider, modelId, variant ?? defaultVariantId(provider, modelId))
        }
        return
      }
      case "variants": {
        const variant = result.args.trim()
        if (variant !== "") await applySelection(activeModel.provider, activeModel.modelId, variant)
        return
      }
      default:
        return
    }
  }

  const controller: Controller = {
    getState: () => ({
      session,
      permissionMode: session.systemContext.permissionMode,
      activeModel,
      currentModel: currentModel(),
      connectableProviders: connectableCache,
      availableModels: availableCache,
      routerStatus: routerStatus(config),
      running,
    }),
    getRequestOptions: () => requestOptions,
    getUsage: () => usageSnapshot(session, currentModel()),
    getTasks: () => currentTasks,
    getSubagents: () => currentSubagents,
    getHistory: () => history,
    recordPrompt,

    subscribe: (listener) => {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    onEvent: (listener) => {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    onQuestion: (listener) => {
      questionListeners.add(listener)
      return () => questionListeners.delete(listener)
    },
    onApproval: (listener) => {
      approvalListeners.add(listener)
      return () => approvalListeners.delete(listener)
    },
    answerQuestion: (id, answers) => {
      pendingQuestions.get(id)?.({ answers })
    },
    resolveApproval: (id, decision) => {
      pendingApprovals.get(id)?.(decision)
    },

    submitPrompt,
    executeCommand,

    cyclePermissionMode: () => {
      setActiveMode(NEXT_MODE[session.systemContext.permissionMode])
      notify()
    },

    // No explicit variant → apply the provider-recommended default rather than
    // sending no reasoning override (`setVariant(undefined)` still opts out).
    selectModel: (provider, modelId, variant) =>
      applySelection(provider, modelId, variant ?? defaultVariantId(provider, modelId)),
    setVariant: (variant) => applySelection(activeModel.provider, activeModel.modelId, variant),

    connectProvider: async (provider, creds) => {
      const next: TuiConfig = {
        ...config,
        providers: { ...config.providers, [provider]: creds },
      }
      return persistConfig(next)
    },

    getRouterView: () => {
      const settings = routerSettings(config)
      const disabledModels = new Set(settings.disabledModels)
      const disabledTargets = new Set(settings.disabledTargets)
      const models: ReadonlyArray<RouterModelView> = availableCache.map((model) => ({
        provider: model.provider,
        modelId: model.modelId,
        label: model.label,
        providerLabel: model.providerLabel,
        enabled: !disabledModels.has(modelKey(model)),
        variants: model.variants.map((variant) => ({
          id: variant.id,
          label: variant.label,
          enabled: !disabledTargets.has(`${modelKey(model)}:${variant.id}`),
        })),
      }))
      return { enabled: settings.enabled, status: routerStatus(config), models }
    },

    setRouterEnabled: async (enabled) => {
      const settings = routerSettings(config)
      await persistConfig({ ...config, router: { ...settings, enabled } })
      notify()
    },

    toggleRouterModel: async (provider, modelId) => {
      const settings = routerSettings(config)
      const key = modelKey({ provider, modelId })
      const disabled = settings.disabledModels.includes(key)
      const disabledModels = disabled
        ? settings.disabledModels.filter((m) => m !== key)
        : [...settings.disabledModels, key]
      await persistConfig({ ...config, router: { ...settings, disabledModels } })
      notify()
    },

    toggleRouterTarget: async (targetId) => {
      const settings = routerSettings(config)
      const disabled = settings.disabledTargets.includes(targetId)
      const disabledTargets = disabled
        ? settings.disabledTargets.filter((t) => t !== targetId)
        : [...settings.disabledTargets, targetId]
      await persistConfig({ ...config, router: { ...settings, disabledTargets } })
      notify()
    },

    refreshAvailableModels: () => {
      refreshDerived()
      notify()
    },

    clearConversation,

    resumeSession: async (sessionId) => {
      const dir = sessionsDirFor(session)
      // Resume on the conversation's own persisted model, not the global default.
      // Fall back to activeModel for legacy sessions or if the target no longer
      // resolves (e.g. its provider was disconnected).
      const persistedRef = await runtime.runPromise(readPersistedModelRef(dir, sessionId))
      const target = persistedRef ?? {
        provider: activeModel.provider,
        modelId: activeModel.modelId,
        ...(activeModel.variant !== undefined && { variant: activeModel.variant }),
      }
      let result = resolveModelSelection(target.provider, target.modelId, target.variant, config)
      if (result.type === "error" && persistedRef !== undefined) {
        result = resolveModelSelection(
          activeModel.provider,
          activeModel.modelId,
          activeModel.variant,
          config,
        )
      }
      if (result.type === "error") {
        emitEvent({ type: "agent-error", source: "agent", message: result.error.message })
        return
      }
      const selection = result.selection
      const modelRef: SessionModelRef = {
        provider: selection.provider,
        modelId: selection.modelId,
        ...(selection.variant !== undefined && { variant: selection.variant }),
      }
      const loaded = await runtime.runPromise(
        loadSession({
          sessionId,
          model: selection.model,
          modelRef,
          requestOptions: selection.requestOptions,
          sessionsDir: dir,
        }),
      )
      await teardownSessionEnv()
      session = loaded
      requestOptions = selection.requestOptions
      notify()
      await startSession()
    },

    listSessions,

    ensureSummaries: async () => {
      if (summarizing) return
      summarizing = true
      try {
        const dir = sessionsDirFor(session)
        for (const saved of listSessions()) {
          if (saved.summary !== undefined) continue
          await generateSummary(pathJoin(dir, saved.sessionId))
          notify()
        }
      } finally {
        summarizing = false
      }
    },

    interrupt: () => {
      currentAbort?.abort()
      if (currentFiber !== undefined) runtime.runFork(Fiber.interrupt(currentFiber))
    },

    cancelTurn: async (partialText?: string) => {
      if (!running) return
      const fiber = currentFiber
      currentAbort?.abort()
      // Await full interruption before repairing history so the loop can't push
      // more messages after we've recorded the interruption.
      if (fiber !== undefined) await runtime.runPromise(Fiber.interrupt(fiber))
      // Preserve the interrupted turn (and any tasks it created), like Claude
      // Code: keep the partial output and append an interrupt marker rather than
      // retracting the turn.
      recordInterruption(session, partialText)
      notify()
    },

    dispose: () => {
      disposed = true
      void teardownSessionEnv().finally(() => {
        void runtime.dispose()
      })
    },
  }

  void startSession()
  return controller
}
