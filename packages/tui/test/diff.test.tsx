import { describe, expect, test } from "bun:test"
import { render } from "ink-testing-library"
import { DiffView, parseDiff } from "../src/components/Diff"

const patch = [
  "Index: foo.ts",
  "===================================================================",
  "--- foo.ts",
  "+++ foo.ts",
  "@@ -1,3 +1,3 @@",
  " const a = 1",
  "-const b = 2",
  "+const b = 3",
  " const c = 4",
].join("\n")

describe("parseDiff", () => {
  test("drops the file-header preamble", () => {
    const lines = parseDiff(patch)
    expect(lines.some((l) => l.text.includes("Index:"))).toBe(false)
    expect(lines.some((l) => l.text.startsWith("---"))).toBe(false)
    expect(lines[0]?.kind).toBe("hunk")
  })

  test("classifies lines and tracks line numbers", () => {
    const lines = parseDiff(patch).filter((l) => l.kind !== "hunk")
    expect(lines).toEqual([
      { kind: "context", text: "const a = 1", lineNo: 1 },
      { kind: "del", text: "const b = 2", lineNo: 2 },
      { kind: "add", text: "const b = 3", lineNo: 2 },
      { kind: "context", text: "const c = 4", lineNo: 3 },
    ])
  })

  test("drops the trailing empty line that createPatch's newline leaves", () => {
    // createPatch output ends in "\n", so split("\n") yields a trailing "".
    const lines = parseDiff(`${patch}\n`)
    expect(lines.at(-1)).toEqual({ kind: "context", text: "const c = 4", lineNo: 3 })
  })

  test("shows the truncation footer verbatim with no gutter number", () => {
    const lines = parseDiff(`${patch}\n… diff truncated`)
    expect(lines.at(-1)).toEqual({ kind: "context", text: "… diff truncated" })
  })
})

describe("DiffView", () => {
  test("renders diff content within the line budget", () => {
    const { lastFrame } = render(<DiffView diff={patch} width={60} maxLines={20} />)
    expect(lastFrame()).toContain("const b = 3")
    expect(lastFrame()).not.toContain("more line")
  })

  test("caps to maxLines and footers the remainder", () => {
    const { lastFrame } = render(<DiffView diff={patch} width={60} maxLines={2} />)
    // 5 parsed lines (1 hunk + 4 body), 2 shown → 3 hidden.
    expect(lastFrame()).toContain("… +3 more lines")
  })

  test("renders every line and no footer when maxLines is omitted", () => {
    const { lastFrame } = render(<DiffView diff={patch} width={60} />)
    expect(lastFrame()).toContain("const a = 1")
    expect(lastFrame()).toContain("const c = 4")
    expect(lastFrame()).not.toContain("more line")
  })
})
