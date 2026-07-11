import { describe, expect, test } from "bun:test"
import { modelRoutableTargets, parseTargetId, targetId } from "../src/router"

describe("targetId", () => {
  test("encodes provider:modelId without a variant", () => {
    expect(targetId({ provider: "anthropic", modelId: "claude-opus-4-8" })).toBe(
      "anthropic:claude-opus-4-8",
    )
  })

  test("encodes provider:modelId:variant with a variant", () => {
    expect(targetId({ provider: "anthropic", modelId: "claude-opus-4-8", variant: "high" })).toBe(
      "anthropic:claude-opus-4-8:high",
    )
  })

  test("treats an empty-string variant as absent", () => {
    expect(targetId({ provider: "p", modelId: "m", variant: "" })).toBe("p:m")
  })
})

describe("parseTargetId", () => {
  test("round-trips a two-segment id", () => {
    expect(parseTargetId("anthropic:claude-opus-4-8")).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
    })
  })

  test("round-trips a three-segment id", () => {
    expect(parseTargetId("deepseek:deepseek-v4-pro:max")).toEqual({
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
      variant: "max",
    })
  })

  test.each(["", "solo", "a:b:c:d", "a::c", ":b", "a:"])("rejects malformed id %p", (id) => {
    expect(parseTargetId(id)).toBeUndefined()
  })
})

describe("modelRoutableTargets", () => {
  test("a model with no variants yields a single default target", () => {
    const targets = modelRoutableTargets({
      provider: "openai",
      providerLabel: "OpenAI",
      lab: "openai",
      modelId: "gpt-5.5",
      label: "ChatGPT 5.5",
      variants: [],
    })
    expect(targets).toHaveLength(1)
    expect(targets[0]?.id).toBe("openai:gpt-5.5")
  })

  test("a model with variants yields one target per variant", () => {
    const targets = modelRoutableTargets({
      provider: "anthropic",
      providerLabel: "Anthropic",
      lab: "anthropic",
      modelId: "claude-opus-4-8",
      label: "Claude Opus 4.8",
      variants: [
        { id: "low", label: "low" },
        { id: "high", label: "high" },
      ],
    })
    expect(targets.map((t) => t.id)).toEqual([
      "anthropic:claude-opus-4-8:low",
      "anthropic:claude-opus-4-8:high",
    ])
  })
})
