import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FileSystem } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { Effect } from "effect"
import { authPath, loadAuth } from "../src/auth"
import { loadStoredCodexCredentials, persistCodexCredentials } from "../src/codex-auth"

const run = <A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunContext.layer)))

describe("persistCodexCredentials", () => {
  test("writes the codex entry into swain auth.json, preserving other providers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swain-cfg-"))
    const configPath = join(dir, "config.json")
    // Seed an existing provider that must survive the write.
    await writeFile(authPath(configPath), JSON.stringify({ zai: { apiKey: "zk" } }))

    await run(
      persistCodexCredentials(configPath, {
        accessToken: "at_2",
        refreshToken: "rt_2",
        accountId: "acct_2",
      }),
    )

    const store = await run(loadAuth(authPath(configPath)))
    expect(store).toEqual({
      zai: { apiKey: "zk" },
      "openai-codex": { accessToken: "at_2", refreshToken: "rt_2", accountId: "acct_2" },
    })
  })
})

describe("loadStoredCodexCredentials", () => {
  test("returns undefined when auth.json has no codex entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swain-cfg-"))
    const configPath = join(dir, "config.json")
    await writeFile(authPath(configPath), JSON.stringify({ zai: { apiKey: "zk" } }))
    expect(await run(loadStoredCodexCredentials(configPath))).toBeUndefined()
  })

  test("reads back the freshest persisted token after a refresh rotation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swain-cfg-"))
    const configPath = join(dir, "config.json")
    // A prior turn rotated the refresh token and persisted it. The resolver must
    // see the rotated token, not the stale one it started with.
    await run(
      persistCodexCredentials(configPath, {
        accessToken: "at_new",
        refreshToken: "rt_new",
        accountId: "acct_1",
      }),
    )
    expect(await run(loadStoredCodexCredentials(configPath))).toEqual({
      accessToken: "at_new",
      refreshToken: "rt_new",
      accountId: "acct_1",
    })
  })
})
