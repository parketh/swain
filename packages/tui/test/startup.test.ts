import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileSystem } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { Effect } from "effect"
import type { TuiConfig } from "../src/config"
import {
  type CredentialPolicy,
  type LoadedStartup,
  loadStartup,
  resolveHeadlessModel,
  resolveInteractiveModel,
} from "../src/startup"

type Env = Record<string, string | undefined>

const run = <A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, BunContext.layer) as Effect.Effect<A, never, never>)

// XDG_CONFIG_HOME=dir → the config dir is dir/swain. Isolating HOME too keeps a
// real ~/.codex store from leaking Codex credentials into a test.
const withConfigDir = async (
  setup: (configDir: string) => void,
  policy: CredentialPolicy,
  extraEnv: Env = {},
): Promise<LoadedStartup> => {
  const dir = mkdtempSync(join(tmpdir(), "swain-startup-"))
  const configDir = join(dir, "swain")
  mkdirSync(configDir, { recursive: true })
  setup(configDir)
  const env: Env = { HOME: dir, XDG_CONFIG_HOME: dir, ...extraEnv }
  try {
    return await run(loadStartup(env, policy))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const seedAuth = (configDir: string, store: Record<string, unknown>): void =>
  writeFileSync(join(configDir, "auth.json"), JSON.stringify(store))

const seedConfig = (configDir: string, config: Record<string, unknown>): void =>
  writeFileSync(join(configDir, "config.json"), JSON.stringify(config))

describe("loadStartup credential policy", () => {
  const providerEnv: Array<[string, string, string]> = [
    ["ANTHROPIC_API_KEY", "anthropic", "apiKey"],
    ["OPENAI_API_KEY", "openai", "apiKey"],
    ["DEEPSEEK_API_KEY", "deepseek", "apiKey"],
    ["ZAI_API_KEY", "zai", "apiKey"],
  ]

  test.each(providerEnv)(
    "%s makes its provider resolvable under exec policy and is ignored under interactive",
    async (envVar, provider, field) => {
      const exec = await withConfigDir(() => {}, "stored-then-environment", { [envVar]: "secret" })
      expect((exec.config.providers[provider] as Record<string, string>)?.[field]).toBe("secret")

      const interactive = await withConfigDir(() => {}, "stored-only", { [envVar]: "secret" })
      expect(interactive.config.providers[provider]).toBeUndefined()
    },
  )

  test("stored credentials win over environment credentials", async () => {
    const loaded = await withConfigDir(
      (configDir) => seedAuth(configDir, { anthropic: { apiKey: "stored-key" } }),
      "stored-then-environment",
      { ANTHROPIC_API_KEY: "env-key" },
    )
    expect((loaded.config.providers.anthropic as Record<string, string>).apiKey).toBe("stored-key")
  })

  test("environment credentials are absent from files after resolution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swain-startup-"))
    const env: Env = { HOME: dir, XDG_CONFIG_HOME: dir, ANTHROPIC_API_KEY: "env-key" }
    try {
      await run(loadStartup(env, "stored-then-environment"))
      // No config/auth file should have been written, and if one exists it must
      // not contain the injected secret.
      const configPath = join(dir, "swain", "config.json")
      const authPath = join(dir, "swain", "auth.json")
      for (const path of [configPath, authPath]) {
        let contents = ""
        try {
          contents = readFileSync(path, "utf8")
        } catch {
          contents = ""
        }
        expect(contents).not.toContain("env-key")
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("legacy plaintext keys in config.json flag a migration; a clean config does not", async () => {
    const legacy = await withConfigDir(
      (configDir) => seedConfig(configDir, { providers: { anthropic: { apiKey: "legacy" } } }),
      "stored-only",
    )
    expect(legacy.needsMigration).toBe(true)

    const clean = await withConfigDir(() => {}, "stored-only")
    expect(clean.needsMigration).toBe(false)
  })
})

describe("model resolution", () => {
  const configWith = (
    providers: TuiConfig["providers"],
    activeModel?: TuiConfig["activeModel"],
  ): TuiConfig => ({
    providers,
    ...(activeModel !== undefined && { activeModel }),
  })

  test("headless resolves the --model flag with its recommended default variant", () => {
    const result = resolveHeadlessModel(configWith({ anthropic: { apiKey: "k" } }), {
      provider: "anthropic",
      modelId: "claude-opus-4-8",
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.resolved.activeModel.variant).toBe("high")
  })

  test("headless preserves an explicit variant on the flag", () => {
    const result = resolveHeadlessModel(configWith({ anthropic: { apiKey: "k" } }), {
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      variant: "max",
    })
    expect(result.ok && result.resolved.activeModel.variant).toBe("max")
  })

  test("headless fails clearly without a flag or saved active model", () => {
    const result = resolveHeadlessModel(configWith({ anthropic: { apiKey: "k" } }), undefined)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("No model")
  })

  test("headless falls back to a saved active model", () => {
    const result = resolveHeadlessModel(
      configWith(
        { anthropic: { apiKey: "k" } },
        { provider: "anthropic", modelId: "claude-opus-4-8" },
      ),
      undefined,
    )
    expect(result.ok && result.resolved.activeModel.provider).toBe("anthropic")
  })

  test("a saved active model resolves once an environment credential fills its provider", async () => {
    const loaded = await withConfigDir(
      (configDir) =>
        seedConfig(configDir, {
          activeModel: { provider: "anthropic", modelId: "claude-opus-4-8" },
        }),
      "stored-then-environment",
      { ANTHROPIC_API_KEY: "env-key" },
    )
    const result = resolveHeadlessModel(loaded.config, undefined)
    expect(result.ok).toBe(true)
  })

  test("interactive falls back to a placeholder when nothing is configured", () => {
    const result = resolveInteractiveModel(configWith({}), undefined)
    expect(result.activeModel).toEqual({ provider: "none", modelId: "unconfigured" })
  })
})
