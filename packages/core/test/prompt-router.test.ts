import { describe, expect, test } from "bun:test"
import {
  assembleSystemPrompt,
  type RouterPromptTarget,
  type SystemPromptInput,
} from "../src/prompt"

const base: SystemPromptInput = {
  workingDirectory: "/w",
  currentDate: "2026-07-10",
  model: "claude-sonnet-5",
  permissionMode: "ask",
  tools: [{ name: "Read", description: "read a file" }],
}

const targets: ReadonlyArray<RouterPromptTarget> = [
  {
    id: "anthropic:claude-sonnet-5:high",
    label: "Claude Sonnet 5 (high)",
    capability: 88,
    relCostEstimate: 3,
    aggregateCost: 90,
    relCostBasis: "manual-estimate",
    hasBenchmarks: false,
  },
  {
    id: "anthropic:claude-opus-4-8:max",
    label: "Claude Opus 4.8 (max)",
    capability: 95,
    relCostEstimate: 5,
    aggregateCost: 300,
    relCostBasis: "manual-estimate",
    hasBenchmarks: false,
  },
]

describe("assembleSystemPrompt router block", () => {
  test("output matches the baseline when no router context is present", () => {
    expect(assembleSystemPrompt(base)).toBe(assembleSystemPrompt({ ...base }))
    expect(assembleSystemPrompt(base)).not.toContain("Routable model targets")
  })

  test("renders only the provided targets and marks the current one", () => {
    const prompt = assembleSystemPrompt({
      ...base,
      router: { targets, currentId: "anthropic:claude-sonnet-5:high" },
    })
    expect(prompt).toContain("Routable model targets")
    expect(prompt).toContain("anthropic:claude-sonnet-5:high")
    expect(prompt).toContain("anthropic:claude-opus-4-8:max")
    // The current target row carries the marker; the other does not.
    const currentLine = prompt.split("\n").find((l) => l.includes("anthropic:claude-sonnet-5:high"))
    expect(currentLine).toContain("[current]")
    const otherLine = prompt.split("\n").find((l) => l.includes("anthropic:claude-opus-4-8:max"))
    expect(otherLine).not.toContain("[current]")
  })

  test("a disabled target is absent because it is not in the targets list", () => {
    const prompt = assembleSystemPrompt({
      ...base,
      router: { targets: [targets[0]!], currentId: "anthropic:claude-sonnet-5:high" },
    })
    expect(prompt).not.toContain("anthropic:claude-opus-4-8:max")
  })

  test("unknown metadata is rendered explicitly, never invented", () => {
    const prompt = assembleSystemPrompt({
      ...base,
      router: {
        targets: [{ id: "p:m", label: "Bare model", hasBenchmarks: false }],
        currentId: "other",
      },
    })
    expect(prompt).toContain("capability unknown")
    expect(prompt).toContain("benchmarks unmeasured")
    expect(prompt).toContain("cost unknown")
  })

  test("guidance covers no-op, one-switch, escalation, sole-tool-call, and Agent.model", () => {
    const prompt = assembleSystemPrompt({
      ...base,
      router: { targets, currentId: "anthropic:claude-sonnet-5:high" },
    })
    expect(prompt).toContain("no-op")
    expect(prompt).toContain("ONE switch")
    expect(prompt).toContain("START")
    expect(prompt.toLowerCase()).toContain("escalation")
    expect(prompt).toContain("ONLY tool call")
    expect(prompt).toContain("dropped")
    expect(prompt).toContain("Agent")
    expect(prompt).toContain("inherit the current model")
  })
})
