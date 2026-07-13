import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detectFileToken, replaceToken, searchFiles } from "../src/fs"

describe("detectFileToken", () => {
  test("detects @src/ag in a sentence", () => {
    const text = "please inspect @src/ag"
    const token = detectFileToken(text)
    expect(token?.query).toBe("src/ag")
    expect(text.slice(token?.start, token?.end)).toBe("@src/ag")
  })

  test("detects an outside-working-directory token", () => {
    const token = detectFileToken("look at @../other")
    expect(token?.query).toBe("../other")
  })

  test("does not detect an email address", () => {
    expect(detectFileToken("mail me@example.com now", 22)).toBeUndefined()
  })
})

describe("searchFiles", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swain-fs-"))
    mkdirSync(join(dir, "project"))
    mkdirSync(join(dir, "project", "src"))
    writeFileSync(join(dir, "project", "src", "agent.ts"), "")
    writeFileSync(join(dir, "project", "src", "manager.ts"), "") // substring match for "ag"
    mkdirSync(join(dir, "project", "node_modules"))
    writeFileSync(join(dir, "project", "node_modules", "agent-lib.js"), "")
    mkdirSync(join(dir, "other"))
    writeFileSync(join(dir, "other", "notes.txt"), "")
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const project = () => join(dir, "project")

  test("filters ignored directories", () => {
    const results = searchFiles(project(), "")
    expect(results.some((r) => r.path === "node_modules")).toBe(false)
    expect(results.some((r) => r.path === "src")).toBe(true)
  })

  test("ranks prefix matches before substring matches", () => {
    const results = searchFiles(project(), "src/ag")
    expect(results.map((r) => r.path)).toEqual(["src/agent.ts", "src/manager.ts"])
  })

  test("searches outside the working directory for a ../ token", () => {
    // Listing outside the working directory requires no approval.
    const results = searchFiles(project(), "../")
    expect(results.some((r) => r.path === "../other")).toBe(true)
    expect(results.every((r) => r.path.startsWith("../"))).toBe(true)
  })

  test("finds files nested in subfolders for a bare query", () => {
    const results = searchFiles(project(), "agent")
    expect(results.some((r) => r.path === "src/agent.ts")).toBe(true)
  })

  test("does not descend into ignored directories when searching", () => {
    const results = searchFiles(project(), "agent")
    expect(results.every((r) => !r.path.includes("node_modules"))).toBe(true)
  })

  test("an empty query browses one level rather than recursing", () => {
    const results = searchFiles(project(), "")
    expect(results.some((r) => r.path === "src")).toBe(true)
    expect(results.some((r) => r.path === "src/agent.ts")).toBe(false)
  })
})

describe("replaceToken", () => {
  test("replaces only the active token", () => {
    const text = "please inspect @src/ag more"
    const token = detectFileToken(text, "please inspect @src/ag".length)
    expect(token).toBeDefined()
    const next = replaceToken(text, token!, "src/agent.ts")
    expect(next.text).toBe("please inspect @src/agent.ts more")
  })
})
