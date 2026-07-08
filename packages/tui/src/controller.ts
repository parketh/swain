import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join as pathJoin } from "node:path"
import type { HttpClient } from "@effect/platform"
import {
  type AgentEvent,
  type Approval,
  submitPrompt as coreSubmitPrompt,
  createSessionState,
  listTasks,
  loadSession,
  loadTaskStore,
  makeOrchestrator,
  makePermissions,
  markParentNotified,
  type Orchestrator,
  OrchestratorService,
  type ParentRunContext,
  type PermissionDecision,
  type PermissionMode,
  pendingParentNotifications,
  runTurn,
  type SessionState,
  saveSession,
  type Task,
  TaskStore,
  type TaskStoreService,
} from "@swain/core"
import {
  type AskHandler,
  type AskInput,
  type AskResult,
  builtinTools,
  makeToolRegistry,
} from "@swain/core/tools"
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
import {
  availableModels,
  connectableProviders,
  freeModel,
  type ModelOption,
  type ProviderOption,
  resolveModelSelection,
} from "./models"
import { type LLMClientService, makeRuntime, toolContextLayer } from "./runtime"
import { type UsageSnapshot, usageSnapshot } from "./usage"

export interface RequestOptions {
  readonly providerOptions?: ProviderOptions
  readonly generation?: GenerationOptions
}

export interface TuiState {
  readonly session: SessionState
  readonly permissionMode: PermissionMode
  readonly activeModel: ActiveModel
  readonly connectableProviders: ReadonlyArray<ProviderOption>
  readonly availableModels: ReadonlyArray<ModelOption>
  readonly running: boolean
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
   * Cancels the running turn and retracts it: the in-flight prompt and any
   * partial assistant/tool messages are removed from the session, and the
   * original prompt text is returned so the UI can restore it for editing.
   * Resolves to `undefined` when nothing was running.
   */
  cancelTurn(): Promise<string | undefined>
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
  let activeModel = deps.activeModel
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

  const parentTools = makeToolRegistry(builtinTools)

  const parentRunContext = (): ParentRunContext => ({
    session,
    tools: parentTools,
    permission: makePermissions(session.systemContext.permissionMode, approval),
  })

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

  const buildSessionEnv = async (s: SessionState): Promise<SessionEnv> => {
    const taskStore = await runtime.runPromise(loadTaskStore(sessionDirFor(s)))
    const orchestrator = await runtime.runPromise(
      makeOrchestrator({
        onEvent: (event) =>
          Effect.sync(() => {
            emitEvent(event)
            void refreshTasks()
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
  const maybeDrainCompletions = async (): Promise<void> => {
    if (running || draining || disposed) {
      if (!disposed) drainPending = true
      return
    }
    draining = true
    let injected = false
    try {
      const env = await ensureSessionEnv()
      if (disposed) return
      const pending = await runtime.runPromise(
        pendingParentNotifications().pipe(Effect.provide(env.layers)),
      )
      if (pending.length === 0 || disposed) return
      const block = pending.map(renderNotification).join("\n\n")
      coreSubmitPrompt(session, `<task-notification>\n${block}\n</task-notification>`)
      await runtime.runPromise(
        markParentNotified(pending.map((t) => t.id)).pipe(Effect.provide(env.layers)),
      )
      notify()
      injected = true
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

  const startSession = async (): Promise<void> => {
    if (disposed) return
    try {
      const env = await ensureSessionEnv()
      if (disposed) return
      await runtime.runPromise(
        env.orchestrator.recoverDangling(parentRunContext()).pipe(Effect.provide(env.layers)),
      )
    } catch {
      // Recovery is best-effort; a dangling task stays reset for the next start.
    }
    await refreshTasks()
    await maybeDrainCompletions()
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
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const sdir = pathJoin(dir, entry.name)
          const modifiedMs = statSync(pathJoin(sdir, "session.json")).mtimeMs
          const summary = readSummary(sdir)
          const firstPrompt = readFirstPrompt(sdir)
          return {
            sessionId: entry.name,
            modifiedMs,
            ...(summary !== undefined && { summary }),
            ...(firstPrompt !== undefined && { firstPrompt }),
          }
        })
        .sort((a, b) => b.modifiedMs - a.modifiedMs)
    } catch {
      return []
    }
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
  // Snapshot of `session.messages.length` before the running prompt was pushed,
  // plus the prompt text, so a cancel can retract the turn and restore the text.
  let pendingPrompt: { readonly text: string; readonly retractAt: number } | undefined

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
      onEvent: (event) => Effect.sync(() => emitEvent(event)),
      ...requestOptions,
    }).pipe(Effect.provide(ctxLayer), Effect.provide(env.layers))
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
    Object.assign(session.systemContext, { model: result.selection.model })
    activeModel = { provider, modelId, ...(variant !== undefined && { variant }) }
    requestOptions = result.selection.requestOptions
    await persistConfig({ ...config, activeModel })
    notify()
  }

  const submitPrompt = async (text: string): Promise<void> => {
    const retractAt = session.messages.length
    coreSubmitPrompt(session, text)
    pendingPrompt = { text, retractAt }
    notify()
    await runTurnNow()
    pendingPrompt = undefined
  }

  const clearConversation = (): void => {
    const previous = session
    session = createSessionState({
      workingDirectory: previous.workingDirectory,
      model: previous.systemContext.model,
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
          await applySelection(provider, modelId, variant)
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
      connectableProviders: connectableCache,
      availableModels: availableCache,
      running,
    }),
    getRequestOptions: () => requestOptions,
    getUsage: () => usageSnapshot(session, activeModel),
    getTasks: () => currentTasks,
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

    selectModel: (provider, modelId, variant) => applySelection(provider, modelId, variant),
    setVariant: (variant) => applySelection(activeModel.provider, activeModel.modelId, variant),

    connectProvider: async (provider, creds) => {
      const next: TuiConfig = {
        ...config,
        providers: { ...config.providers, [provider]: creds },
      }
      return persistConfig(next)
    },

    refreshAvailableModels: () => {
      refreshDerived()
      notify()
    },

    clearConversation,

    resumeSession: async (sessionId) => {
      const result = resolveModelSelection(
        activeModel.provider,
        activeModel.modelId,
        activeModel.variant,
        config,
      )
      if (result.type === "error") {
        emitEvent({ type: "agent-error", source: "agent", message: result.error.message })
        return
      }
      const loaded = await runtime.runPromise(
        loadSession({
          sessionId,
          model: result.selection.model,
          sessionsDir: sessionsDirFor(session),
        }),
      )
      await teardownSessionEnv()
      session = loaded
      requestOptions = result.selection.requestOptions
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

    cancelTurn: async () => {
      if (!running) return undefined
      const pending = pendingPrompt
      const fiber = currentFiber
      currentAbort?.abort()
      // Await full interruption before truncating so the loop can't push more
      // messages past the retract point after we've cut it.
      if (fiber !== undefined) await runtime.runPromise(Fiber.interrupt(fiber))
      if (pending === undefined) return undefined
      session.messages.length = pending.retractAt
      notify()
      return pending.text
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
