import { describe, expect, test } from "bun:test"
import { formatToolUse, summarizeResult } from "../src/components/toolFormat"

describe("formatToolUse", () => {
  test("shows the path for file tools and the command for Bash", () => {
    expect(formatToolUse("Edit", { path: "/x/README.md" })).toBe("/x/README.md")
    expect(formatToolUse("Bash", { command: "ls -la" })).toBe("ls -la")
    expect(formatToolUse("Grep", { pattern: "foo", glob: "*.ts" })).toBe('"foo" *.ts')
  })
})

describe("summarizeResult", () => {
  test("Read reports line count, not raw JSON", () => {
    expect(summarizeResult("Read", { totalLines: 122, content: "…" }, false)).toBe("122 lines")
    expect(summarizeResult("Read", { supported: false, kind: "image" }, false)).toBe("image file")
  })

  test("Edit reports git-style added/removed lines from its diff", () => {
    const value = {
      path: "/x/README.md",
      replacements: 1,
      diffs: [
        {
          format: "unified",
          text: "--- a\n+++ b\n@@\n-bun install  \n+bun install\n+extra\n",
          truncated: false,
        },
      ],
    }
    expect(summarizeResult("Edit", value, false)).toBe("+2 -1")
  })

  test("Edit falls back to replacement count with no diff data", () => {
    expect(summarizeResult("Edit", { path: "/x", replacements: 3, diffs: [] }, false)).toBe(
      "3 replacements",
    )
  })

  test("Grep and Glob report match/file counts", () => {
    expect(summarizeResult("Grep", { matches: [{}, {}] }, false)).toBe("Found 2 matches")
    expect(summarizeResult("Glob", { matches: ["a"] }, false)).toBe("Found 1 file")
  })

  test("Agent reports the spawned agent type instead of raw JSON", () => {
    expect(
      summarizeResult(
        "Agent",
        { agentId: "x", taskId: "t", agentType: "Explore", status: "spawned" },
        false,
      ),
    ).toBe("Spawned Explore")
  })

  test("errors are shown as trimmed text", () => {
    expect(summarizeResult("Edit", "no match found for oldText", true)).toBe(
      "no match found for oldText",
    )
  })
})
