import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configureSidecarRg, resolveSidecarRg } from "../src/sidecars"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "swain-sidecar-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Lays out a compiled-style tree (`bin/swain` beside `libexec/rg`). */
const layout = (withRg: boolean): string => {
  mkdirSync(join(root, "bin"), { recursive: true })
  writeFileSync(join(root, "bin", "swain"), "")
  if (withRg) {
    mkdirSync(join(root, "libexec"), { recursive: true })
    const rg = join(root, "libexec", "rg")
    writeFileSync(rg, "#!/bin/sh\n")
    chmodSync(rg, 0o755)
  }
  return join(root, "bin", "swain")
}

describe("resolveSidecarRg", () => {
  test("finds rg in the compiled bin/libexec layout", () => {
    const execPath = layout(true)
    expect(resolveSidecarRg(execPath)).toBe(join(root, "libexec", "rg"))
  })

  test("returns undefined when no sidecar is staged", () => {
    const execPath = layout(false)
    expect(resolveSidecarRg(execPath)).toBeUndefined()
  })
})

describe("configureSidecarRg", () => {
  test("sets SWAIN_RG_PATH to the sidecar when present", () => {
    const execPath = layout(true)
    const env: Record<string, string | undefined> = {}
    configureSidecarRg(env, execPath)
    expect(env.SWAIN_RG_PATH).toBe(join(root, "libexec", "rg"))
  })

  test("leaves SWAIN_RG_PATH unset when no sidecar exists", () => {
    const execPath = layout(false)
    const env: Record<string, string | undefined> = {}
    configureSidecarRg(env, execPath)
    expect(env.SWAIN_RG_PATH).toBeUndefined()
  })

  test("never overwrites a caller-provided SWAIN_RG_PATH", () => {
    const execPath = layout(true)
    const env: Record<string, string | undefined> = { SWAIN_RG_PATH: "/custom/rg" }
    configureSidecarRg(env, execPath)
    expect(env.SWAIN_RG_PATH).toBe("/custom/rg")
  })
})
