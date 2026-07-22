import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunContext } from "@effect/platform-bun"
import type { Model, ToolCall, ToolResultContent } from "@swain/llms"
import { ModelId, ProviderId, ToolCallId } from "@swain/llms"
import { Effect, Layer, Stream } from "effect"
import { autoApproval, makePermissions } from "../src/permission"
import { createSessionState, type SessionState } from "../src/state"
import {
  callTool,
  Edit,
  Glob,
  Grep,
  Read,
  ToolContext,
  toolRegistryLayer,
  Write,
} from "../src/tools"

const model: Model = {
  id: ModelId.make("test-model"),
  provider: ProviderId.make("test"),
  streamTurn: () => Stream.empty,
}

const tools = [Read, Write, Edit, Glob, Grep]

let dir: string
let session: SessionState

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "swain-fs-"))
  session = createSessionState({
    workingDirectory: dir,
    model,
    permissionMode: "auto",
    currentDate: "2026-07-04",
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const call = (name: string, input: unknown, state: SessionState = session): ToolCall => ({
  type: "tool-call",
  toolCallId: ToolCallId.make(`call-${name}`),
  name,
  input,
})

const run = (toolCall: ToolCall, state: SessionState = session): Promise<ToolResultContent> =>
  Effect.runPromise(
    callTool(toolCall).pipe(
      Effect.provide(
        Layer.succeed(ToolContext, {
          session: state,
          abortSignal: new AbortController().signal,
          permission: makePermissions(() => state.systemContext.permissionMode, autoApproval),
        }),
      ),
      Effect.provide(toolRegistryLayer(tools)),
      Effect.provide(BunContext.layer),
    ),
  )

describe("Read", () => {
  test("caches full contents and returns them with line numbers", async () => {
    writeFileSync(join(dir, "a.txt"), "hello")
    const result = await run(call("Read", { path: "a.txt" }))
    expect(result.isError).toBeUndefined()
    expect(result.result).toEqual({
      type: "json",
      value: {
        path: join(dir, "a.txt"),
        kind: "text",
        supported: true,
        bytes: 5,
        content: "     1\thello",
        totalLines: 1,
        truncated: false,
      },
    })
    // The cache holds the raw content (not the numbered view) so Edit matches.
    expect(session.fileState.get(join(dir, "a.txt"))?.content).toBe("hello")
  })

  test("offset/limit page through a file and flag truncation", async () => {
    writeFileSync(join(dir, "big.txt"), "l1\nl2\nl3\nl4\nl5")
    const result = await run(call("Read", { path: "big.txt", offset: 2, limit: 2 }))
    const value = (
      result.result as { value: { content: string; totalLines: number; truncated: boolean } }
    ).value
    expect(value.content).toBe("     2\tl2\n     3\tl3")
    expect(value.totalLines).toBe(5)
    expect(value.truncated).toBe(true)
  })

  test("rejects files above the size cap", async () => {
    writeFileSync(join(dir, "huge.txt"), "x".repeat(11 * 1024 * 1024))
    const result = await run(call("Read", { path: "huge.txt" }))
    expect(result.isError).toBe(true)
  })

  test("missing file returns an error result", async () => {
    const result = await run(call("Read", { path: "missing.txt" }))
    expect(result.isError).toBe(true)
  })

  test("non-text file reports supported: false without content", async () => {
    writeFileSync(join(dir, "bin"), Buffer.from([0x00, 0x01, 0x02, 0x00]))
    const result = await run(call("Read", { path: "bin" }))
    const value = (result.result as { value: { supported: boolean; content?: string } }).value
    expect(value.supported).toBe(false)
    expect(value.content).toBeUndefined()
    expect(session.fileState.has(join(dir, "bin"))).toBe(false)
  })

  test("rejects symlinks that escape the workspace", async () => {
    const external = mkdtempSync(join(tmpdir(), "swain-fs-external-"))
    try {
      writeFileSync(join(external, "secret.txt"), "secret")
      symlinkSync(external, join(dir, "link"), "dir")

      const read = await run(call("Read", { path: "link/secret.txt" }))
      expect(read.isError).toBe(true)

      const write = await run(call("Write", { path: "link/missing/new.txt", content: "x" }))
      expect(write.isError).toBe(true)
      expect(await Bun.file(join(external, "missing", "new.txt")).exists()).toBe(false)
    } finally {
      rmSync(external, { recursive: true, force: true })
    }
  })
})

describe("Write", () => {
  test("creates a new file", async () => {
    const result = await run(call("Write", { path: "new.txt", content: "fresh" }))
    expect(result.isError).toBeUndefined()
    expect(await Bun.file(join(dir, "new.txt")).text()).toBe("fresh")
    expect(session.fileState.has(join(dir, "new.txt"))).toBe(true)
  })

  test("fails when the file already exists", async () => {
    writeFileSync(join(dir, "exists.txt"), "old")
    const result = await run(call("Write", { path: "exists.txt", content: "new" }))
    expect(result.isError).toBe(true)
  })
})

describe("Edit", () => {
  test("requires a read before editing", async () => {
    writeFileSync(join(dir, "a.txt"), "hello world")
    const result = await run(call("Edit", { path: "a.txt", oldText: "world", newText: "there" }))
    expect(result.isError).toBe(true)
  })

  test("edits after a read and refreshes the cache", async () => {
    writeFileSync(join(dir, "a.txt"), "hello world")
    await run(call("Read", { path: "a.txt" }))
    const result = await run(call("Edit", { path: "a.txt", oldText: "world", newText: "there" }))
    expect(result.isError).toBeUndefined()
    expect(await Bun.file(join(dir, "a.txt")).text()).toBe("hello there")
    expect(session.fileState.get(join(dir, "a.txt"))?.content).toBe("hello there")

    const again = await run(call("Edit", { path: "a.txt", oldText: "there", newText: "again" }))
    expect(again.isError).toBeUndefined()
  })

  test("fails when the file changed after the last read", async () => {
    writeFileSync(join(dir, "a.txt"), "hello world")
    await run(call("Read", { path: "a.txt" }))
    writeFileSync(join(dir, "a.txt"), "changed externally")
    const result = await run(call("Edit", { path: "a.txt", oldText: "hello", newText: "hi" }))
    expect(result.isError).toBe(true)
  })

  test("non-unique oldText fails without replaceAll and succeeds with it", async () => {
    writeFileSync(join(dir, "a.txt"), "x x x")
    await run(call("Read", { path: "a.txt" }))
    const nonUnique = await run(call("Edit", { path: "a.txt", oldText: "x", newText: "y" }))
    expect(nonUnique.isError).toBe(true)

    const all = await run(
      call("Edit", { path: "a.txt", oldText: "x", newText: "y", replaceAll: true }),
    )
    expect(all.isError).toBeUndefined()
    expect(await Bun.file(join(dir, "a.txt")).text()).toBe("y y y")
  })

  test("serializes concurrent edits to the same path without corruption", async () => {
    writeFileSync(join(dir, "a.txt"), "TOKEN")
    await run(call("Read", { path: "a.txt" }))
    const [first, second] = await Promise.all([
      run(call("Edit", { path: "a.txt", oldText: "TOKEN", newText: "ONE" })),
      run(call("Edit", { path: "a.txt", oldText: "TOKEN", newText: "TWO" })),
    ])
    const errors = [first, second].filter((r) => r.isError === true)
    expect(errors).toHaveLength(1)
    expect(await Bun.file(join(dir, "a.txt")).text()).toBeOneOf(["ONE", "TWO"])
  })
})

describe("Glob and Grep", () => {
  test("Glob lists files matching a pattern", async () => {
    writeFileSync(join(dir, "a.ts"), "export const a = 1")
    writeFileSync(join(dir, "b.js"), "const b = 2")
    const result = await run(call("Glob", { pattern: "*.ts" }))
    const value = (result.result as { value: { matches: ReadonlyArray<string> } }).value
    expect(value.matches).toContain("a.ts")
    expect(value.matches).not.toContain("b.js")
  })

  test("Grep finds matching lines with file and line number", async () => {
    writeFileSync(join(dir, "a.ts"), "const needle = 1\nconst other = 2")
    const result = await run(call("Grep", { pattern: "needle" }))
    const value = (
      result.result as { value: { matches: ReadonlyArray<{ file: string; line: number }> } }
    ).value
    expect(value.matches).toHaveLength(1)
    expect(value.matches[0]?.line).toBe(1)
  })
})

describe("SWAIN_RG_PATH override", () => {
  let originalRgPath: string | undefined
  beforeEach(() => {
    originalRgPath = process.env.SWAIN_RG_PATH
  })
  afterEach(() => {
    if (originalRgPath === undefined) delete process.env.SWAIN_RG_PATH
    else process.env.SWAIN_RG_PATH = originalRgPath
  })

  test("Glob runs the configured rg instead of the system one", async () => {
    // A fake `rg` that ignores its args and prints a sentinel the real rg
    // could never emit, proving the override is honored.
    const fakeRg = join(dir, "fake-rg")
    writeFileSync(fakeRg, "#!/bin/sh\necho 'sentinel-from-fake.ts'\n")
    chmodSync(fakeRg, 0o755)
    process.env.SWAIN_RG_PATH = fakeRg

    const result = await run(call("Glob", { pattern: "*.ts" }))
    const value = (result.result as { value: { matches: ReadonlyArray<string> } }).value
    expect(value.matches).toEqual(["sentinel-from-fake.ts"])
  })

  test("unset SWAIN_RG_PATH falls back to the system rg", async () => {
    writeFileSync(join(dir, "a.ts"), "export const a = 1")
    writeFileSync(join(dir, "b.js"), "const b = 2")
    const result = await run(call("Glob", { pattern: "*.ts" }))
    const value = (result.result as { value: { matches: ReadonlyArray<string> } }).value
    expect(value.matches).toContain("a.ts")
    expect(value.matches).not.toContain("b.js")
  })
})
