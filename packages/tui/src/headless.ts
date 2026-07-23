import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join as pathJoin } from "node:path"
import { BunContext } from "@effect/platform-bun"
import { createSessionState, type SessionState, type TraceOutcome } from "@swain/core"
import { builtinTools } from "@swain/core/tools"
import { Effect, type Layer } from "effect"
import type { HeadlessOptions } from "./cli"
import { type TuiConfig } from "./config"
import { makeController } from "./controller"
import { initEvent, messageEvent, resultEvent, serialize } from "./exec-events"
import { initTraceRecorder, type TraceRecorder } from "./exec-trace"
import { collectSecrets, makeRedactor } from "./redaction"
import { routerSettings } from "./router"
import type { LLMClientService } from "./runtime"
import { loadStartup, resolveHeadlessModel } from "./startup"
import { version } from "./version"

/** Test-only injection seam; production callers pass nothing. */
export interface HeadlessTestDeps {
  readonly llmLayer?: Layer.Layer<LLMClientService>
}

/** Last committed assistant text — the authority for stdout (never streamed deltas). */
const finalAssistantText = (session: SessionState): string => {
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const message = session.messages[i]
    if (message?.role === "assistant") {
      return message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("")
        .trim()
    }
  }
  return ""
}

/** Forces routing off in the in-memory config; never persisted. */
const withRoutingDisabled = (config: TuiConfig): TuiConfig => ({
  ...config,
  router: { ...routerSettings(config), enabled: false },
})

/**
 * Runs a single prompt to quiescence without a TTY and prints only the final
 * assistant text. Resolves to the process exit code:
 * - `0` the parent/subagent run quiesced (even if the final text is empty);
 * - `1` startup/auth/model/runtime failure (no stdout, one stderr line);
 * - `130`/`143` interrupted by SIGINT/SIGTERM.
 */
export const runHeadless = async (
  options: HeadlessOptions,
  testDeps: HeadlessTestDeps = {},
): Promise<number> => {
  const { env, cwd, stdout, stderr } = options

  // Startup: config/auth with the environment credential overlay, then model.
  let loaded: Awaited<ReturnType<typeof runStartup>>
  try {
    loaded = await runStartup(env)
  } catch (error) {
    stderr(`${describe(error)}\n`)
    return 1
  }
  const model = resolveHeadlessModel(loaded.config, options.model)
  if (!model.ok) {
    stderr(`${model.error}\n`)
    return 1
  }

  // Routing is off by default; --router leaves the saved configuration effective.
  const config = options.router ? loaded.config : withRoutingDisabled(loaded.config)
  // Exact known-value redactor over stdout NDJSON and native trace writes. Built
  // from the loaded provider credentials plus the supported env overlays.
  const redact = makeRedactor(collectSecrets(loaded.config.providers, env))
  const active = model.resolved.activeModel
  const session = createSessionState({
    workingDirectory: cwd,
    model: model.resolved.model,
    modelRef: {
      provider: active.provider,
      modelId: active.modelId,
      ...(active.variant !== undefined && { variant: active.variant }),
    },
    requestOptions: model.resolved.requestOptions,
    permissionMode: options.permissionMode,
    currentDate: new Date().toISOString().slice(0, 10),
  })

  // Opt-in native trace bundle. Initialize the directory before any model request
  // so an unwritable path fails the exec (exit 1) rather than silently claiming
  // ATIF support after spending tokens.
  const execTools = builtinTools.filter((tool) => tool.name !== "Ask")
  // The traced root system prompt must match the loop's: SwitchModel is only
  // offered when routing is active (it is off by default in exec).
  const rootTraceTools = execTools
    .filter((tool) => tool.name !== "SwitchModel" || options.router)
    .map((tool) => ({ name: tool.name, description: tool.description }))
  let recorder: TraceRecorder | undefined
  if (options.traceDir !== undefined) {
    try {
      recorder = await initTraceRecorder({
        dir: options.traceDir,
        swainVersion: version(),
        rootAgentId: session.sessionId,
        nonInteractive: true,
        redact,
      })
    } catch (error) {
      stderr(`${describe(error)}\n`)
      return 1
    }
  }

  // Ephemeral task/tool-result storage removed on every exit path. Setup failures
  // here (e.g. mkdtemp) still owe the caller the documented one-line-stderr, exit-1
  // contract rather than an uncaught rejection escaping to the bun entrypoint.
  let storageRoot: string | undefined
  let controller: ReturnType<typeof makeController>
  try {
    storageRoot = await mkdtemp(pathJoin(tmpdir(), "swain-exec-"))
    controller = makeController({
      session,
      activeModel: active,
      config,
      configPath: loaded.configPath,
      requestOptions: model.resolved.requestOptions,
      persist: false,
      sessionStorageRoot: storageRoot,
      tools: execTools,
      nonInteractive: true,
      ...(recorder !== undefined && { onChildTrace: recorder.recordChild }),
      ...(testDeps.llmLayer !== undefined && { llmLayer: testDeps.llmLayer }),
    })
  } catch (error) {
    stderr(`${describe(error)}\n`)
    if (storageRoot !== undefined)
      await rm(storageRoot, { recursive: true, force: true }).catch(() => {})
    return 1
  }

  // Stream mode: flush each committed message as it lands, keyed by a cursor
  // over session.messages so retries never re-emit. Driven by agent events
  // (which fire per iteration during the turn, unlike notify() which only fires
  // at turn start/end) so committed messages stream out live, not all at the end.
  const streamJson = options.outputFormat === "stream-json"
  const modelRef =
    active.variant !== undefined
      ? `${active.provider}:${active.modelId}:${active.variant}`
      : `${active.provider}:${active.modelId}`
  let cursor = 0
  const flush = (): void => {
    const messages = session.messages
    for (; cursor < messages.length; cursor += 1) {
      const event = messageEvent(messages[cursor]!)
      if (event !== null) stdout(serialize(event, redact))
    }
  }

  // Fatal (non-recoverable) errors suppress the final result and exit 1;
  // recoverable diagnostics go to stderr as they arrive without changing a
  // successful exit, keeping stdout pure NDJSON.
  let fatal = false
  let fatalMessage: string | undefined
  const unsubscribe = controller.onEvent((event) => {
    if (streamJson) flush()
    if (event.type !== "agent-error") return
    if (event.recoverable === true) {
      stderr(`${redact(event.message)}\n`)
    } else if (!fatal) {
      fatal = true
      fatalMessage = event.message
      stderr(`${redact(event.message)}\n`)
    }
  })
  if (streamJson) {
    stdout(
      serialize(
        initEvent({
          model: modelRef,
          permissionMode: options.permissionMode,
          cwd,
          router: options.router,
        }),
        redact,
      ),
    )
  }

  // Signals: resolve the run with the POSIX code and let `finally` interrupt the
  // controller and remove the temporary directory.
  let signalCode: number | undefined
  let resolveSignal: (code: number) => void = () => {}
  const signalled = new Promise<number>((resolve) => {
    resolveSignal = resolve
  })
  const onSigint = (): void => {
    signalCode = 130
    resolveSignal(130)
  }
  const onSigterm = (): void => {
    signalCode = 143
    resolveSignal(143)
  }
  process.on("SIGINT", onSigint)
  process.on("SIGTERM", onSigterm)

  const work = (async (): Promise<number> => {
    await controller.submitPrompt(options.prompt)
    await controller.waitUntilIdle()
    if (signalCode !== undefined) return signalCode
    if (streamJson) {
      flush()
      stdout(
        serialize(
          fatal
            ? resultEvent("error_during_execution", fatalMessage ?? "")
            : resultEvent("success", finalAssistantText(session)),
          redact,
        ),
      )
      return fatal ? 1 : 0
    }
    if (fatal) return 1
    stdout(`${redact(finalAssistantText(session))}\n`)
    return 0
  })().catch(() => 1)

  try {
    const code = await Promise.race([work, signalled])
    if (streamJson && (code === 130 || code === 143)) {
      flush()
      stdout(serialize(resultEvent("interrupted"), redact))
    }
    // Finalize the root snapshot after quiescence (success) or during bounded
    // shutdown on failure/signal. A trace write error fails an otherwise-clean
    // run so the caller never trusts an incomplete bundle.
    if (recorder !== undefined) {
      const outcome: TraceOutcome =
        signalCode !== undefined
          ? { status: "interrupted", signal: signalCode === 130 ? "SIGINT" : "SIGTERM" }
          : fatal
            ? { status: "failed", error: fatalMessage ?? "" }
            : { status: "completed" }
      await recorder.finalizeRoot({ session, tools: rootTraceTools, outcome })
      const traceError = recorder.firstError()
      if (traceError !== undefined) {
        stderr(`Trace write failed: ${redact(traceError.message)}\n`)
        return code === 0 ? 1 : code
      }
    }
    return code
  } finally {
    process.removeListener("SIGINT", onSigint)
    process.removeListener("SIGTERM", onSigterm)
    unsubscribe()
    await controller.shutdown().catch(() => {})
    if (storageRoot !== undefined)
      await rm(storageRoot, { recursive: true, force: true }).catch(() => {})
  }
}

const runStartup = (env: HeadlessOptions["env"]) =>
  Effect.runPromise(
    loadStartup(env, "stored-then-environment").pipe(Effect.provide(BunContext.layer)),
  )

const describe = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error)
