#!/usr/bin/env bun
import { BunContext } from "@effect/platform-bun"
import { createSessionState } from "@swain/core"
import type { Model } from "@swain/llms"
import { ModelId, ProviderId } from "@swain/llms"
import { Effect, Stream } from "effect"
import { startApp } from "../src/app"
import { defaultConfigPath, loadConfig } from "../src/config"
import { makeController } from "../src/controller"

// Minimal startup: full flag parsing, model resolution, and resume land in
// Task 11. This wires enough to render the REPL against loaded config.
const configPath = defaultConfigPath()
const config = await Effect.runPromise(
  loadConfig(configPath).pipe(Effect.provide(BunContext.layer)),
)

const placeholderModel: Model = {
  id: ModelId.make("unconfigured"),
  provider: ProviderId.make("none"),
  streamTurn: () => Stream.empty,
}

const session = createSessionState({
  workingDirectory: process.cwd(),
  model: placeholderModel,
  currentDate: new Date().toISOString().slice(0, 10),
})

const controller = makeController({
  session,
  activeModel: { provider: "none", modelId: "unconfigured" },
  config,
  configPath,
})

startApp({ controller })
