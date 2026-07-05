import type { HttpClient } from "@effect/platform"
import {
  type AgentEvent,
  type Approval,
  submitPrompt as coreSubmitPrompt,
  createSessionState,
  loadSession,
  type PermissionDecision,
  type PermissionMode,
  runTurn,
  type SessionState,
  saveSession,
} from "@swain/core"
import type { AskHandler, AskInput, AskResult } from "@swain/core/tools"
import type { GenerationOptions, ProviderOptions } from "@swain/llms"
import { Effect, Fiber, type Layer } from "effect"
import type { CommandParseResult } from "./commands"
import { type ActiveModel, type ProviderConfig, saveConfig, type TuiConfig } from "./config"
import {
  availableModels,
  connectableProviders,
  type ModelOption,
  type ProviderOption,
  resolveModelSelection,
} from "./models"
import { type LLMClientService, makeRuntime, toolContextLayer } from "./runtime"
import { type UsageSnapshot, usageSnapshot } from "./usage"

type Env = Record<string, string | undefined>

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

export interface ControllerDeps {
  readonly session: SessionState
  readonly activeModel: ActiveModel
  readonly config: TuiConfig
  readonly configPath: string
  readonly requestOptions?: RequestOptions
  readonly env?: Env
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
  subscribe(listener: () => void): () => void
  onEvent(listener: (event: AgentEvent) => void): () => void
  onQuestion(listener: (request: PendingQuestion) => void): () => void
  onApproval(listener: (request: PendingApproval) => void): () => void
  answerQuestion(id: number, answers: AskResult["answers"]): void
  resolveApproval(id: number, decision: PermissionDecision): void
  submitPrompt(text: string): Promise<void>
  executeCommand(result: CommandParseResult): Promise<void>
  cyclePermissionMode(): void
  selectModel(provider: string, modelId: string, variant?: string): Promise<void>
  setVariant(variant?: string): Promise<void>
  connectProvider(provider: string, creds: ProviderConfig): Promise<ConnectResult>
  refreshAvailableModels(): void
  clearConversation(): void
  resumeSession(sessionId: string): Promise<void>
  interrupt(): void
  dispose(): void
}

/**
 * Bridges UI actions to Effect programs, core sessions, and the model registry.
 * Owns controller state (`TuiState`); transcript/draft display state lives in
 * React. Forwards each `AgentEvent` to subscribers as it arrives.
 */
export const makeController = (deps: ControllerDeps): Controller => {
  const env = deps.env ?? process.env
  const persist = deps.persist ?? true

  let session = deps.session
  let activeModel = deps.activeModel
  let config = deps.config
  let requestOptions: RequestOptions = deps.requestOptions ?? {}
  let running = false

  let availableCache = availableModels(config, env)
  let connectableCache = connectableProviders(config, env)

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
    availableCache = availableModels(config, env)
    connectableCache = connectableProviders(config, env)
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

  let currentAbort: AbortController | undefined
  let currentFiber: Fiber.RuntimeFiber<void, unknown> | undefined

  const runTurnNow = async (): Promise<void> => {
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
    }).pipe(Effect.provide(ctxLayer))
    const fiber = runtime.runFork(effect)
    currentFiber = fiber
    try {
      await runtime.runPromise(Fiber.join(fiber))
      if (persist) await runtime.runPromise(saveSession(session))
    } catch {
      // Fatal LLM/agent failures are surfaced through onEvent as agent-error;
      // interruptions leave the partial draft visible without being persisted.
    } finally {
      running = false
      currentAbort = undefined
      currentFiber = undefined
      notify()
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
    const result = resolveModelSelection(provider, modelId, variant, config, env)
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
    coreSubmitPrompt(session, text)
    notify()
    await runTurnNow()
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
      void runtime.runPromise(saveSession(previous)).catch(() => undefined)
    }
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

  return {
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
        env,
      )
      if (result.type === "error") {
        emitEvent({ type: "agent-error", source: "agent", message: result.error.message })
        return
      }
      const loaded = await runtime.runPromise(
        loadSession({
          sessionId,
          model: result.selection.model,
          rootDir: session.workingDirectory,
        }),
      )
      session = loaded
      requestOptions = result.selection.requestOptions
      notify()
    },

    interrupt: () => {
      currentAbort?.abort()
      if (currentFiber !== undefined) runtime.runFork(Fiber.interrupt(currentFiber))
    },

    dispose: () => {
      void runtime.dispose()
    },
  }
}
