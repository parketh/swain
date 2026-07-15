import { describe, expect, test } from "bun:test"
import type { Message } from "@swain/llms"
import { buildItems, emptyDraft, type ToolRow } from "../src/components/Transcript"

const diffText = "@@ -1,1 +1,1 @@\n-const b = 2\n+const b = 3\n"

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

describe("Transcript inline Edit diffs", () => {
  test("a completed Edit carries its diff from the persisted result", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "t1", name: "Edit", input: { path: "a.ts" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool-result",
            toolCallId: "t1",
            isError: false,
            result: { value: { diffs: [{ format: "unified", text: diffText, truncated: false }] } },
          },
        ],
      },
      // biome-ignore lint/suspicious/noExplicitAny: opaque persisted content blocks
    ] as any as ReadonlyArray<Message>
    const item = buildItems(messages, emptyDraft).find((i) => i.kind === "tool")
    expect(item?.kind === "tool" && item.diff).toBe(diffText)
  })

  test("a still-running Edit takes the pending approval diff", () => {
    const row: ToolRow = {
      toolCallId: "t2",
      name: "Edit",
      input: { path: "b.ts" },
      output: "",
      done: false,
      isError: false,
    }
    const draft = { ...emptyDraft, tools: [row] }
    const item = buildItems([], draft, diffText).find((i) => i.kind === "tool")
    expect(item?.kind === "tool" && item.diff).toBe(diffText)
  })

  test("a non-Edit pending tool gets no diff", () => {
    const row: ToolRow = {
      toolCallId: "t3",
      name: "Bash",
      input: { command: "ls" },
      output: "",
      done: false,
      isError: false,
    }
    const item = buildItems([], { ...emptyDraft, tools: [row] }, diffText).find(
      (i) => i.kind === "tool",
    )
    expect(item?.kind === "tool" && item.diff).toBeUndefined()
  })
})
