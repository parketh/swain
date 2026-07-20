import { describe, expect, test } from "bun:test"
import type { TuiConfig } from "../src/config"
import {
  availableModels,
  configuredProviders,
  mergeModelsByProvider,
  resolveModelSelection,
} from "../src/models"

describe("mergeModelsByProvider", () => {
  test("collapses a model served by multiple providers into one entry", () => {
    // OpenAI and OpenAI Codex both serve gpt-5.5 / gpt-5.6-sol / gpt-5.6-terra.
    const config: TuiConfig = {
      providers: {
        openai: { apiKey: "x" },
        "openai-codex": { accessToken: "t", refreshToken: "rt" },
      },
    }
    const merged = mergeModelsByProvider(availableModels(config))

    const gpt55 = merged.find((m) => m.modelId === "gpt-5.5")
    expect(gpt55).toBeDefined()
    expect(gpt55?.providers.map((p) => p.provider).sort()).toEqual(["openai", "openai-codex"])

    // Every modelId appears at most once after merging.
    const ids = merged.map((m) => m.modelId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("keeps single-provider models as a lone entry", () => {
    const config: TuiConfig = { providers: { openai: { apiKey: "x" } } }
    const merged = mergeModelsByProvider(availableModels(config))

    // gpt-5.6-luna is OpenAI-only.
    const luna = merged.find((m) => m.modelId === "gpt-5.6-luna")
    expect(luna?.providers).toHaveLength(1)
    expect(luna?.providers[0]?.provider).toBe("openai")
  })

  test("preserves first-seen catalog order", () => {
    const config: TuiConfig = {
      providers: {
        openai: { apiKey: "x" },
        "openai-codex": { accessToken: "t", refreshToken: "rt" },
      },
    }
    const source = availableModels(config)
    const merged = mergeModelsByProvider(source)
    const firstSeen: string[] = []
    for (const m of source) if (!firstSeen.includes(m.modelId)) firstSeen.push(m.modelId)
    expect(merged.map((m) => m.modelId)).toEqual(firstSeen)
  })
})

describe("oauth provider configuration", () => {
  test("oauth provider is configured when a refresh token is stored", () => {
    const cfg: TuiConfig = {
      providers: { "openai-codex": { refreshToken: "rt", accessToken: "at" } },
    }
    expect(configuredProviders(cfg).some((p) => p.id === "openai-codex")).toBe(true)
  })
  test("oauth provider without a refresh token is not configured", () => {
    const cfg: TuiConfig = { providers: { "openai-codex": { accessToken: "at" } } }
    expect(configuredProviders(cfg).some((p) => p.id === "openai-codex")).toBe(false)
  })
})

describe("resolveModelSelection limits", () => {
  test("every configured catalog model resolves with context-window limits", () => {
    const config: TuiConfig = {
      providers: {
        anthropic: { apiKey: "x" },
        openai: { apiKey: "x" },
        kimi: { apiKey: "x" },
        deepseek: { apiKey: "x" },
        zai: { apiKey: "x" },
        "openai-codex": { accessToken: "t", refreshToken: "rt" },
      },
    }
    for (const model of availableModels(config)) {
      const result = resolveModelSelection(model.provider, model.modelId, undefined, config)
      expect(result.type).toBe("ok")
      if (result.type === "ok") {
        expect(result.selection.model.limits?.contextWindow).toBeGreaterThan(0)
        expect(result.selection.model.limits?.maxOutputTokens).toBeGreaterThan(0)
      }
    }
  })

  test("Codex caps the context window below the raw OpenAI API limit", () => {
    const config: TuiConfig = {
      providers: {
        openai: { apiKey: "x" },
        "openai-codex": { accessToken: "t", refreshToken: "rt" },
      },
    }
    const viaOpenAI = resolveModelSelection("openai", "gpt-5.5", undefined, config)
    const viaCodex = resolveModelSelection("openai-codex", "gpt-5.5", undefined, config)
    expect(viaOpenAI.type).toBe("ok")
    expect(viaCodex.type).toBe("ok")
    if (viaOpenAI.type === "ok" && viaCodex.type === "ok") {
      expect(viaOpenAI.selection.model.limits?.contextWindow).toBe(1_050_000)
      expect(viaCodex.selection.model.limits?.contextWindow).toBe(400_000)
      // The output cap is unaffected by the Codex surface.
      expect(viaCodex.selection.model.limits?.maxOutputTokens).toBe(128_000)
    }
  })
})
