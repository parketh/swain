import { BunContext } from "@effect/platform-bun"
import { createSessionState, type PermissionMode } from "@swain/core"
import type { Model } from "@swain/llms"
import { ModelId, ProviderId } from "@swain/llms"
import { OPENAI_CODEX_PROVIDER_ID } from "@swain/llms/providers"
import { Effect, Stream } from "effect"
import { startApp } from "./app"
import { authPath, loadAuth, saveAuth } from "./auth"
import { loadCodexCliCredentials } from "./codex-auth"
import {
  type ActiveModel,
  defaultConfigPath,
  loadConfig,
  saveConfig,
  type TuiConfig,
} from "./config"
import { makeController, type RequestOptions } from "./controller"
import { historyPath, loadHistory } from "./history"
import { availableModels, resolveModelSelection } from "./models"
import { queryTerminalBackground } from "./terminalBackground"
import { applyTerminalBackground } from "./theme"

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
  const stored = await Effect.runPromise(
    loadConfig(configPath).pipe(Effect.provide(BunContext.layer)),
  )
  const auth = await Effect.runPromise(
    loadAuth(authPath(configPath)).pipe(Effect.provide(BunContext.layer)),
  )
  // Credentials live in auth.json; auth.json wins over any legacy plaintext keys
  // still sitting in config.json.
  const providers = { ...stored.providers, ...auth }
  // Bootstrap Codex credentials from the Codex CLI's own store
  // (~/.codex/auth.json) when swain has no refresh token of its own, so users who
  // logged in with `codex` never paste a token and swain can refresh expired
  // access tokens automatically. Adopt the CLI pair when it carries a refresh
  // token, or when swain has no Codex access token at all.
  if (providers[OPENAI_CODEX_PROVIDER_ID]?.refreshToken === undefined) {
    const cli = await Effect.runPromise(
      loadCodexCliCredentials(env).pipe(Effect.provide(BunContext.layer)),
    ).catch(() => undefined)
    if (
      cli !== undefined &&
      (cli.refreshToken !== undefined ||
        providers[OPENAI_CODEX_PROVIDER_ID]?.accessToken === undefined)
    ) {
      providers[OPENAI_CODEX_PROVIDER_ID] = {
        accessToken: cli.accessToken,
        ...(cli.refreshToken !== undefined && { refreshToken: cli.refreshToken }),
        ...(cli.accountId !== undefined && { accountId: cli.accountId }),
      }
    }
  }
  const config: TuiConfig = { ...stored, providers }
  // One-time migration: move legacy plaintext keys out of config.json and into
  // auth.json (saveConfig strips providers, so this also cleans config.json).
  if (Object.keys(stored.providers).length > 0) {
    await Effect.runPromise(
      saveAuth(authPath(configPath), providers).pipe(Effect.provide(BunContext.layer)),
    ).catch(() => undefined)
    await Effect.runPromise(
      saveConfig(configPath, config).pipe(Effect.provide(BunContext.layer)),
    ).catch(() => undefined)
  }
  const history = await Effect.runPromise(
    loadHistory(historyPath(configPath)).pipe(Effect.provide(BunContext.layer)),
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
    modelRef: {
      provider: activeModel.provider,
      modelId: activeModel.modelId,
      ...(activeModel.variant !== undefined && { variant: activeModel.variant }),
    },
    requestOptions,
    permissionMode: flags.permissionMode ?? "ask",
    currentDate: new Date().toISOString().slice(0, 10),
  })

  const controller = makeController({
    session,
    activeModel,
    config: effectiveConfig,
    configPath,
    history,
    requestOptions,
  })

  if (flags.resume !== undefined) await controller.resumeSession(flags.resume)

  const background = await queryTerminalBackground()
  if (background !== undefined) applyTerminalBackground(background)

  startApp({ controller })
}
