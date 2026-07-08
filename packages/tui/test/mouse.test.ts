import { describe, expect, test } from "bun:test"
import { isMouseEvent, parseMouseEvents } from "../src/mouse"

describe("mouse", () => {
  test("parses click press and release (ESC stripped by Ink)", () => {
    expect(parseMouseEvents("[<0;79;21M")).toEqual([{ button: 0, release: false }])
    expect(parseMouseEvents("[<0;79;21m")).toEqual([{ button: 0, release: true }])
  })

  test("parses reports with an omitted button number", () => {
    expect(parseMouseEvents("[<;79;21M")).toEqual([{ button: 0, release: false }])
  })

  test("parses multiple reports in one chunk, ESC embedded", () => {
    expect(parseMouseEvents("[<64;10;5M\x1b[<65;10;5M")).toEqual([
      { button: 64, release: false },
      { button: 65, release: false },
    ])
  })

  test("ignores ordinary text", () => {
    expect(isMouseEvent("a")).toBe(false)
    expect(isMouseEvent("sk-ant-key<1>")).toBe(false)
    expect(isMouseEvent("[<0;79;21M")).toBe(true)
  })
})
