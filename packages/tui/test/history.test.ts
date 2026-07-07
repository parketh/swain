import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileSystem } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { Effect } from "effect"
import { appendHistory, historyPath, loadHistory, saveHistory } from "../src/history"

const run = <A>(effect: Effect.Effect<A, never, FileSystem.FileSystem>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, BunContext.layer))

describe("appendHistory", () => {
  test("appends a new entry", () => {
    expect(appendHistory(["a"], "b")).toEqual(["a", "b"])
  })

  test("skips empty text and consecutive duplicates by reference", () => {
    const base = ["a"]
    expect(appendHistory(base, "")).toBe(base)
    expect(appendHistory(base, "a")).toBe(base)
  })

  test("caps at the most recent 100 entries", () => {
    const full = Array.from({ length: 100 }, (_, i) => `p${i}`)
    const next = appendHistory(full, "newest")
    expect(next).toHaveLength(100)
    expect(next[0]).toBe("p1")
    expect(next[99]).toBe("newest")
  })
})

describe("history persistence", () => {
  test("historyPath is anchored beside config.json", () => {
    expect(historyPath("/home/u/.config/swain/config.json")).toBe(
      "/home/u/.config/swain/history.json",
    )
  })

  test("a missing file loads as empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swain-hist-"))
    try {
      expect(await run(loadHistory(join(dir, "history.json")))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("save then load round-trips and writes 0600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swain-hist-"))
    const path = join(dir, "nested", "history.json")
    try {
      await run(saveHistory(path, ["one", "two"]))
      expect(await run(loadHistory(path))).toEqual(["one", "two"])
      expect(readFileSync(path, "utf8")).toBe(JSON.stringify(["one", "two"]))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
