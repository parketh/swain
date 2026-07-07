import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunContext } from "@effect/platform-bun"
import { Effect } from "effect"
import {
  ConfigError,
  defaultConfigPath,
  loadConfig,
  redactKey,
  saveConfig,
  type TuiConfig,
} from "../src/config"
import { availableModels, connectableProviders, resolveModelSelection } from "../src/models"

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)
const withFs = <A, E>(effect: Effect.Effect<A, E, BunContext.BunContext>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunContext.layer)))

describe("config paths", () => {
  test("default path resolves under ~/.config with HOME set and no XDG override", () => {
    expect(defaultConfigPath({ HOME: "/home/alice" })).toBe("/home/alice/.config/swain/config.json")
  })

  test("XDG_CONFIG_HOME overrides the default location", () => {
    expect(defaultConfigPath({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/alice" })).toBe(
      "/xdg/swain/config.json",
    )
  })
})

describe("config load/save", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swain-config-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("missing config loads as empty defaults", async () => {
    const config = await withFs(loadConfig(join(dir, "nope", "config.json")))
    expect(config).toEqual({ providers: {} })
  })

  test("saving persists the active model but never provider secrets", async () => {
    const path = join(dir, "sub", "config.json")
    const config: TuiConfig = {
      activeModel: { provider: "anthropic", modelId: "claude-sonnet-5" },
      providers: { anthropic: { apiKey: "sk-abc" } },
    }
    await withFs(saveConfig(path, config))
    // config.json holds the active model...
    const reloaded = await withFs(loadConfig(path))
    expect(reloaded.activeModel?.modelId).toBe("claude-sonnet-5")
    // ...but not the credentials, and the raw file contains no key.
    expect(reloaded.providers).toEqual({})
    expect(readFileSync(path, "utf8")).not.toContain("sk-abc")
  })

  test("saved file is owner read/write only where modes are exposed", async () => {
    if (process.platform === "win32") return
    const path = join(dir, "config.json")
    await withFs(saveConfig(path, { providers: {} }))
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test("invalid JSON fails with a typed config error", async () => {
    const path = join(dir, "config.json")
    writeFileSync(path, "{ not json")
    const error = await withFs(loadConfig(path).pipe(Effect.flip))
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).reason).toBe("invalid")
  })

  test("a failed write fails with a typed error and leaves no partial file", async () => {
    // A file where a directory is expected forces makeDirectory to fail.
    const blocker = join(dir, "blocker")
    writeFileSync(blocker, "x")
    const path = join(blocker, "config.json")
    const error = await withFs(saveConfig(path, { providers: {} }).pipe(Effect.flip))
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).reason).toBe("write-failed")
    expect(() => statSync(path)).toThrow()
  })
})

describe("redaction", () => {
  test("never returns the raw key", () => {
    const key = "sk-super-secret-1234"
    expect(redactKey(key)).not.toBe(key)
    expect(redactKey(key)).toContain("1234")
  })
})

describe("provider catalog", () => {
  test("connectable providers include every static provider, unconfigured by default", () => {
    const providers = connectableProviders({ providers: {} })
    const ids = providers.map((p) => p.id)
    expect(ids).toEqual(
      expect.arrayContaining(["anthropic", "openai", "deepseek", "zai", "openai-codex"]),
    )
    expect(providers.every((p) => p.configured === false)).toBe(true)
  })

  test("availableModels excludes providers without stored creds", () => {
    const models = availableModels({ providers: {} })
    expect(models).toHaveLength(0)
  })

  test("availableModels includes a provider once its API key is saved", () => {
    const models = availableModels({ providers: { anthropic: { apiKey: "sk-1" } } })
    expect(models.some((m) => m.provider === "anthropic")).toBe(true)
    expect(models.every((m) => m.provider === "anthropic")).toBe(true)
  })

  test("availableModels ignores provider env vars", () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "sk-env"
    try {
      expect(availableModels({ providers: {} })).toHaveLength(0)
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prev
    }
  })
})

describe("resolveModelSelection", () => {
  const config: TuiConfig = {
    providers: {
      anthropic: { apiKey: "sk-anthropic" },
      openai: { apiKey: "sk-openai" },
      "openai-codex": { accessToken: "tok", accountId: "acct" },
    },
  }

  test("rejects an unconfigured provider", () => {
    const result = resolveModelSelection("zai", "glm-5.2", undefined, config)
    expect(result.type).toBe("error")
    if (result.type === "error") expect(result.error.reason).toBe("provider-not-configured")
  })

  test("rejects an unknown variant", () => {
    const result = resolveModelSelection("anthropic", "claude-sonnet-5", "nope", config)
    expect(result.type).toBe("error")
    if (result.type === "error") expect(result.error.reason).toBe("unknown-variant")
  })

  test("returns a Model whose provider/id match the selection", () => {
    const result = resolveModelSelection("anthropic", "claude-sonnet-5", undefined, config)
    expect(result.type).toBe("ok")
    if (result.type === "ok") {
      expect(result.selection.model.provider as string).toBe("anthropic")
      expect(result.selection.model.id as string).toBe("claude-sonnet-5")
    }
  })

  test("lowers a codex effort variant to reasoning providerOptions", () => {
    const result = resolveModelSelection("openai-codex", "gpt-5-codex", "high", config)
    expect(result.type).toBe("ok")
    if (result.type === "ok") {
      expect(result.selection.requestOptions.providerOptions).toEqual({
        openaiCodex: { reasoning: { effort: "high" } },
      })
    }
  })

  test("lowers an anthropic thinking variant to providerOptions.anthropic.thinking", () => {
    const result = resolveModelSelection("anthropic", "claude-sonnet-5", "thinking", config)
    expect(result.type).toBe("ok")
    if (result.type === "ok") {
      const opts = result.selection.requestOptions.providerOptions as {
        anthropic?: { thinking?: unknown }
      }
      expect(opts.anthropic?.thinking).toBeDefined()
    }
  })

  test("a chat-compatible provider with no reasoning variants yields no reasoning options", () => {
    const result = resolveModelSelection("openai", "gpt-5.5", undefined, config)
    expect(result.type).toBe("ok")
    if (result.type === "ok") {
      expect(result.selection.requestOptions.providerOptions).toBeUndefined()
    }
  })
})
