import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileSystem } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { Effect } from "effect"
import { type AuthStore, authPath, loadAuth, saveAuth } from "../src/auth"
import { loadConfig, saveConfig, type TuiConfig } from "../src/config"

const run = <A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, BunContext.layer) as Effect.Effect<A, never, never>)

describe("auth store", () => {
  test("authPath sits beside config.json", () => {
    expect(authPath("/home/u/.config/swain/config.json")).toBe("/home/u/.config/swain/auth.json")
  })

  test("a missing file loads as empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swain-auth-"))
    try {
      expect(await run(loadAuth(join(dir, "auth.json")))).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("save then load round-trips and writes 0600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swain-auth-"))
    const path = join(dir, "nested", "auth.json")
    const store: AuthStore = { anthropic: { apiKey: "sk-secret" } }
    try {
      await run(saveAuth(path, store))
      expect(await run(loadAuth(path))).toEqual(store)
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(readFileSync(path, "utf8")).toContain("sk-secret")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// Mirrors the one-time migration performed by `run()` in index.ts: legacy
// plaintext keys in config.json are moved into auth.json and scrubbed from
// config.json, while the active model is preserved.
const migrate = async (configPath: string): Promise<TuiConfig> => {
  const stored = await run(loadConfig(configPath))
  const auth = await run(loadAuth(authPath(configPath)))
  const providers = { ...stored.providers, ...auth }
  const config: TuiConfig = { ...stored, providers }
  if (Object.keys(stored.providers).length > 0) {
    await run(saveAuth(authPath(configPath), providers))
    await run(saveConfig(configPath, config))
  }
  return config
}

describe("legacy migration", () => {
  test("moves plaintext keys from config.json into auth.json, keeps active model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swain-mig-"))
    const configPath = join(dir, "config.json")
    writeFileSync(
      configPath,
      JSON.stringify({
        activeModel: { provider: "anthropic", modelId: "claude-sonnet-5" },
        providers: { anthropic: { apiKey: "sk-LEGACY-9999" } },
      }),
    )
    try {
      const config = await migrate(configPath)
      expect(config.providers.anthropic?.apiKey).toBe("sk-LEGACY-9999") // usable in memory
      expect(readFileSync(authPath(configPath), "utf8")).toContain("sk-LEGACY-9999")
      const configRaw = readFileSync(configPath, "utf8")
      expect(configRaw).not.toContain("sk-LEGACY-9999") // scrubbed
      expect(configRaw).toContain("claude-sonnet-5") // active model kept
      // Idempotent: a second pass sees no legacy providers to migrate.
      expect((await run(loadConfig(configPath))).providers).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
