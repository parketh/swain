import { describe, expect, test } from "bun:test"
import { ModelResolveError } from "@swain/core"
import { Effect } from "effect"
import type { TuiConfig } from "../src/config"
import { makeModelResolver } from "../src/model-resolver"

const resolve = (config: TuiConfig, id: string) =>
  Effect.runPromise(
    makeModelResolver(() => config)
      .resolve(id)
      .pipe(Effect.either),
  )

const enabledConfig: TuiConfig = {
  providers: { anthropic: { apiKey: "sk-a" }, deepseek: { apiKey: "sk-d" } },
  router: { enabled: true, disabledModels: [], disabledTargets: [] },
}

describe("makeModelResolver", () => {
  test("resolves an enabled target to a live model, request options, and ref", async () => {
    const result = await resolve(enabledConfig, "anthropic:claude-opus-4-8:high")
    expect(result._tag).toBe("Right")
    if (result._tag === "Right") {
      expect(result.right.model.id as string).toBe("claude-opus-4-8")
      expect(result.right.modelRef).toEqual({
        provider: "anthropic",
        modelId: "claude-opus-4-8",
        variant: "high",
      })
      expect(result.right.requestOptions.providerOptions).toEqual({
        anthropic: { thinking: { type: "adaptive", effort: "high" } },
      })
    }
  })

  test("resolves the Kimi K3 target to a live model with reasoning options and the loss flag", async () => {
    const config: TuiConfig = {
      providers: { kimi: { apiKey: "sk-kimi" } },
      router: { enabled: true, disabledModels: [], disabledTargets: [] },
    }
    const result = await resolve(config, "kimi:kimi-k3:max")
    expect(result._tag).toBe("Right")
    if (result._tag === "Right") {
      expect(result.right.model.id as string).toBe("kimi-k3")
      expect(result.right.modelRef).toEqual({
        provider: "kimi",
        modelId: "kimi-k3",
        variant: "max",
      })
      expect(result.right.requestOptions.providerOptions).toEqual({
        kimi: { reasoningEffort: "max" },
      })
      expect(result.right.model.warnOnReasoningLoss).toBe(true)
    }
  })

  test("a malformed or unknown target id is unknown-target", async () => {
    const malformed = await resolve(enabledConfig, "not-a-target")
    const unknown = await resolve(enabledConfig, "anthropic:no-such-model")
    for (const result of [malformed, unknown]) {
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect((result.left as ModelResolveError).reason).toBe("unknown-target")
      }
    }
  })

  test("an opted-out target is not-enabled", async () => {
    const config: TuiConfig = {
      ...enabledConfig,
      router: {
        enabled: true,
        disabledModels: [],
        disabledTargets: ["anthropic:claude-opus-4-8:high"],
      },
    }
    const result = await resolve(config, "anthropic:claude-opus-4-8:high")
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect((result.left as ModelResolveError).reason).toBe("not-enabled")
    }
  })

  test("a target whose credentials vanished after prompt assembly is unavailable", async () => {
    // Router still lists deepseek as enabled, but its credentials are gone.
    const config: TuiConfig = {
      providers: { anthropic: { apiKey: "sk-a" } },
      router: { enabled: true, disabledModels: [], disabledTargets: [] },
    }
    const result = await resolve(config, "deepseek:deepseek-v4-pro:high")
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect((result.left as ModelResolveError).reason).toBe("unavailable")
    }
  })
})
