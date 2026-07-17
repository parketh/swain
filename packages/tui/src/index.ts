import { BunContext } from "@effect/platform-bun"
import { createSessionState, type PermissionMode } from "@swain/core"
import { Effect } from "effect"
import { startApp } from "./app"
import { saveConfig, type TuiConfig } from "./config"
import { makeController } from "./controller"
import { historyPath, loadHistory } from "./history"
import { loadStartup, migrateLegacyAuth, resolveInteractiveModel } from "./startup"
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

export interface RunOptions {
  readonly argv?: ReadonlyArray<string>
  readonly env?: Env
  readonly cwd?: string
}

/**
 * Interactive entrypoint: load global config, resolve the active model (flag →
 * stored `activeModel` → first configured provider default → placeholder), build
 * the controller, optionally resume a session, and mount the Ink app.
 */
export const runInteractive = async (options: RunOptions = {}): Promise<void> => {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const flags = parseFlags(options.argv ?? process.argv.slice(2))
  const { configPath, config, needsMigration } = await Effect.runPromise(
    loadStartup(env, "stored-only").pipe(Effect.provide(BunContext.layer)),
  )
  if (needsMigration) {
    await Effect.runPromise(
      migrateLegacyAuth(configPath, config).pipe(Effect.provide(BunContext.layer)),
    )
  }
  const history = await Effect.runPromise(
    loadHistory(historyPath(configPath)).pipe(Effect.provide(BunContext.layer)),
  )

  const { model, activeModel, requestOptions } = resolveInteractiveModel(config, flags.model)

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
