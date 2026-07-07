import { BunContext } from "@effect/platform-bun"
import { createSessionState, type PermissionMode } from "@swain/core"
import type { Model } from "@swain/llms"
import { ModelId, ProviderId } from "@swain/llms"
import { Effect, Stream } from "effect"
import { startApp } from "./app"
import {
  type ActiveModel,
  defaultConfigPath,
  loadConfig,
  saveConfig,
  type TuiConfig,
} from "./config"
import { makeController, type RequestOptions } from "./controller"
import { availableModels, resolveModelSelection } from "./models"

export { App, type StartOptions, startApp } from "./app"
export type { AppProps } from "./components/App"
export { makeController } from "./controller"

type Env = Record<string, string | undefined>

interface Flags {
  readonly resume?: string
  readonly model?: string
  readonly permissionMode?: PermissionMode
}

const parseFlags = (argv: ReadonlyArray<string>): Flags => {
  const flags: { resume?: string; model?: string; permissionMode?: PermissionMode } = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === "--resume" && next !== undefined) {
      flags.resume = next
      i += 1
    } else if (arg === "--model" && next !== undefined) {
      flags.model = next
      i += 1
    } else if (arg === "--permission-mode" && next !== undefined) {
      if (next === "ask" || next === "auto" || next === "plan") flags.permissionMode = next
      i += 1
    }
  }
  return flags
}

// Rendered when no provider is configured yet; the app prompts the user to run
// /connect instead of crashing on missing credentials.
const placeholderModel: Model = {
  id: ModelId.make("unconfigured"),
  provider: ProviderId.make("none"),
  streamTurn: () => Stream.empty,
}
const placeholderActive: ActiveModel = { provider: "none", modelId: "unconfigured" }

export interface RunOptions {
  readonly argv?: ReadonlyArray<string>
  readonly env?: Env
  readonly cwd?: string
}

/**
 * CLI entrypoint: load global config, resolve the active model (flag → stored
 * `activeModel` → first configured provider default → placeholder), build the
 * controller, optionally resume a session, and mount the Ink app.
 */
export const run = async (options: RunOptions = {}): Promise<void> => {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const flags = parseFlags(options.argv ?? process.argv.slice(2))
  const configPath = defaultConfigPath(env)
  const config = await Effect.runPromise(
    loadConfig(configPath).pipe(Effect.provide(BunContext.layer)),
  )

  const models = availableModels(config)
  const isAvailable = (candidate: ActiveModel): boolean =>
    models.some((m) => m.provider === candidate.provider && m.modelId === candidate.modelId)

  let requested: ActiveModel | undefined
  if (flags.model !== undefined) {
    const [provider, modelId] = flags.model.split(":")
    if (provider !== undefined && modelId !== undefined) requested = { provider, modelId }
  }
  if (
    requested === undefined &&
    config.activeModel !== undefined &&
    isAvailable(config.activeModel)
  ) {
    requested = config.activeModel
  }
  if (requested === undefined && models.length > 0) {
    const first = models[0]
    if (first !== undefined) requested = { provider: first.provider, modelId: first.modelId }
  }

  let model = placeholderModel
  let activeModel = placeholderActive
  let requestOptions: RequestOptions = {}
  if (requested !== undefined) {
    const resolved = resolveModelSelection(
      requested.provider,
      requested.modelId,
      requested.variant,
      config,
    )
    if (resolved.type === "ok") {
      model = resolved.selection.model
      activeModel = requested
      requestOptions = resolved.selection.requestOptions
    }
  }

  // Persist the chosen model as the new default when it differs from config.
  let effectiveConfig: TuiConfig = config
  if (
    activeModel.provider !== "none" &&
    (config.activeModel?.provider !== activeModel.provider ||
      config.activeModel?.modelId !== activeModel.modelId ||
      config.activeModel?.variant !== activeModel.variant)
  ) {
    effectiveConfig = { ...config, activeModel }
    await Effect.runPromise(
      saveConfig(configPath, effectiveConfig).pipe(Effect.provide(BunContext.layer)),
    ).catch(() => undefined)
  }

  const session = createSessionState({
    workingDirectory: cwd,
    model,
    permissionMode: flags.permissionMode ?? "ask",
    currentDate: new Date().toISOString().slice(0, 10),
  })

  const controller = makeController({
    session,
    activeModel,
    config: effectiveConfig,
    configPath,
    requestOptions,
  })

  if (flags.resume !== undefined) await controller.resumeSession(flags.resume)

  startApp({ controller })
}
