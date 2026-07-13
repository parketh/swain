import { describe, expect, test } from "bun:test"
import type { Message } from "@swain/llms"
import { buildItems, emptyDraft } from "../src/components/Transcript"

const switchMessage: Message = {
  role: "user",
  isMeta: true,
  content: [
    {
      type: "model-switch",
      from: { provider: "anthropic", modelId: "claude-sonnet-5" },
      to: { provider: "anthropic", modelId: "claude-opus-4-8", variant: "high" },
      reason: "escalating for a tricky refactor",
      requestedBy: "router",
    },
  ],
  // biome-ignore lint/suspicious/noExplicitAny: model-switch content isn't in the narrow Message helper types
} as any

describe("Transcript model-switch rendering", () => {
  test("a model-switch block becomes a switch item, not a user text prompt", () => {
    const items = buildItems([switchMessage], emptyDraft)
    expect(items).toHaveLength(1)
    const item = items[0]!
    expect(item.kind).toBe("switch")
    if (item.kind === "switch") {
      expect(item.from).toBe("anthropic:claude-sonnet-5")
      expect(item.to).toBe("anthropic:claude-opus-4-8:high")
      expect(item.reason).toBe("escalating for a tricky refactor")
      expect(item.requestedBy).toBe("router")
    }
    // It must never render as a plain user prompt.
    expect(items.some((i) => i.kind === "text" && i.role === "user")).toBe(false)
  })
})
