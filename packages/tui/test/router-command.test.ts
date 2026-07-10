import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionState } from "@swain/core"
import { type Model, ModelId, ProviderId } from "@swain/llms"
import { Stream } from "effect"
import type { TuiConfig } from "../src/config"
import { type Controller, makeController } from "../src/controller"

const testModel: Model = {
  id: ModelId.make("claude-sonnet-5"),
  provider: ProviderId.make("anthropic"),
  streamTurn: () => Stream.empty,
}

const twoProviders: TuiConfig["providers"] = {
  anthropic: { apiKey: "sk-a" },
  deepseek: { apiKey: "sk-d" },
}

describe("controller router actions", () => {
  let dir: string
  let controller: Controller
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swain-router-cmd-"))
  })
  afterEach(() => {
    controller?.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  const build = (config: TuiConfig): Controller => {
    controller = makeController({
      session: createSessionState({
        workingDirectory: dir,
        model: testModel,
        permissionMode: "auto",
        currentDate: "2026-07-05",
      }),
      activeModel: { provider: "anthropic", modelId: "claude-sonnet-5" },
      config,
      configPath: join(dir, "config.json"),
      persist: false,
    })
    return controller
  }

  test("the master toggle flips router status between off and on", async () => {
    const c = build({ providers: twoProviders })
    expect(c.getState().routerStatus).toBe("off")
    await c.setRouterEnabled(true)
    expect(c.getState().routerStatus).toBe("on")
    await c.setRouterEnabled(false)
    expect(c.getState().routerStatus).toBe("off")
  })

  test("toggling a model opts every variant out and back in", async () => {
    const c = build({
      providers: twoProviders,
      router: { enabled: true, disabledModels: [], disabledTargets: [] },
    })
    const opusEnabled = () =>
      c.getRouterView().models.find((m) => m.modelId === "claude-opus-4-8")?.enabled
    expect(opusEnabled()).toBe(true)
    await c.toggleRouterModel("anthropic", "claude-opus-4-8")
    expect(opusEnabled()).toBe(false)
    await c.toggleRouterModel("anthropic", "claude-opus-4-8")
    expect(opusEnabled()).toBe(true)
  })

  test("toggling a target opts a single variant out", async () => {
    const c = build({
      providers: twoProviders,
      router: { enabled: true, disabledModels: [], disabledTargets: [] },
    })
    const lowEnabled = () =>
      c
        .getRouterView()
        .models.find((m) => m.modelId === "claude-opus-4-8")
        ?.variants.find((v) => v.id === "low")?.enabled
    expect(lowEnabled()).toBe(true)
    await c.toggleRouterTarget("anthropic:claude-opus-4-8:low")
    expect(lowEnabled()).toBe(false)
    // Other variants stay enabled.
    const highEnabled = c
      .getRouterView()
      .models.find((m) => m.modelId === "claude-opus-4-8")
      ?.variants.find((v) => v.id === "high")?.enabled
    expect(highEnabled).toBe(true)
  })

  test("getRouterView lists connected models with their variants", () => {
    const c = build({ providers: { anthropic: { apiKey: "sk-a" } } })
    const view = c.getRouterView()
    expect(view.models.every((m) => m.provider === "anthropic")).toBe(true)
    const opus = view.models.find((m) => m.modelId === "claude-opus-4-8")
    expect(opus?.variants.map((v) => v.id)).toEqual(["low", "medium", "high", "xhigh", "max"])
  })
})
