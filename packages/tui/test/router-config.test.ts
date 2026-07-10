import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunContext } from "@effect/platform-bun"
import { Effect } from "effect"
import { loadConfig, saveConfig, type TuiConfig } from "../src/config"
import { enabledRouterTargets, routerSettings, routerStatus } from "../src/router"

const withFs = <A, E>(effect: Effect.Effect<A, E, BunContext.BunContext>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunContext.layer)))

const twoProviders: TuiConfig["providers"] = {
  anthropic: { apiKey: "sk-a" },
  deepseek: { apiKey: "sk-d" },
}

describe("router config load/save", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swain-router-cfg-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("missing router loads as off with empty opt-outs", async () => {
    const config = await withFs(loadConfig(join(dir, "config.json")))
    expect(routerSettings(config)).toEqual({
      enabled: false,
      disabledModels: [],
      disabledTargets: [],
    })
  })

  test("saveConfig persists router and never writes credentials", async () => {
    const path = join(dir, "config.json")
    const config: TuiConfig = {
      providers: { anthropic: { apiKey: "sk-secret" } },
      router: { enabled: true, disabledModels: ["anthropic:claude-opus-4-8"], disabledTargets: [] },
    }
    await withFs(saveConfig(path, config))
    const reloaded = await withFs(loadConfig(path))
    expect(reloaded.router?.enabled).toBe(true)
    expect(reloaded.router?.disabledModels).toEqual(["anthropic:claude-opus-4-8"])
    expect(readFileSync(path, "utf8")).not.toContain("sk-secret")
  })
})

describe("enabledRouterTargets", () => {
  test("includes only configured providers", () => {
    const config: TuiConfig = {
      providers: { anthropic: { apiKey: "sk-a" } },
      router: { enabled: true, disabledModels: [], disabledTargets: [] },
    }
    const targets = enabledRouterTargets(config)
    expect(targets.length).toBeGreaterThan(0)
    expect(targets.every((t) => t.ref.provider === "anthropic")).toBe(true)
  })

  test("a disabled model removes all its variants", () => {
    const config: TuiConfig = {
      providers: twoProviders,
      router: {
        enabled: true,
        disabledModels: ["anthropic:claude-opus-4-8"],
        disabledTargets: [],
      },
    }
    const targets = enabledRouterTargets(config)
    expect(targets.some((t) => t.ref.modelId === "claude-opus-4-8")).toBe(false)
    expect(targets.some((t) => t.ref.modelId === "claude-sonnet-5")).toBe(true)
  })

  test("a disabled target removes only that variant", () => {
    const config: TuiConfig = {
      providers: twoProviders,
      router: {
        enabled: true,
        disabledModels: [],
        disabledTargets: ["anthropic:claude-opus-4-8:low"],
      },
    }
    const ids = enabledRouterTargets(config).map((t) => t.id)
    expect(ids).not.toContain("anthropic:claude-opus-4-8:low")
    expect(ids).toContain("anthropic:claude-opus-4-8:high")
  })
})

describe("routerStatus", () => {
  test("off when the master toggle is disabled", () => {
    expect(routerStatus({ providers: twoProviders })).toBe("off")
    expect(
      routerStatus({
        providers: twoProviders,
        router: { enabled: false, disabledModels: [], disabledTargets: [] },
      }),
    ).toBe("off")
  })

  test("inactive when on but fewer than two enabled connected targets", () => {
    const config: TuiConfig = {
      providers: { openai: { apiKey: "sk-o" } },
      router: {
        enabled: true,
        // Disable every openai model except a single no-variant one.
        disabledModels: ["openai:gpt-5.5-pro", "openai:gpt-5.4-nano", "openai:gpt-5.4-mini"],
        disabledTargets: [],
      },
    }
    expect(enabledRouterTargets(config).length).toBe(1)
    expect(routerStatus(config)).toBe("inactive")
  })

  test("on when two or more enabled connected targets exist", () => {
    const config: TuiConfig = {
      providers: twoProviders,
      router: { enabled: true, disabledModels: [], disabledTargets: [] },
    }
    expect(routerStatus(config)).toBe("on")
  })
})
