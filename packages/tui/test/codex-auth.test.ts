import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FileSystem } from "@effect/platform"
import { BunContext } from "@effect/platform-bun"
import { Effect } from "effect"
import { authPath, loadAuth } from "../src/auth"
import { loadCodexCliCredentials, persistCodexCredentials } from "../src/codex-auth"

const run = <A>(effect: Effect.Effect<A, unknown, FileSystem.FileSystem>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunContext.layer)))

describe("loadCodexCliCredentials", () => {
  test("maps the Codex CLI auth.json into swain credentials", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"))
    await mkdir(join(home, ".codex"), { recursive: true })
    await writeFile(
      join(home, ".codex", "auth.json"),
      JSON.stringify({
        tokens: { access_token: "at_1", refresh_token: "rt_1", account_id: "acct_1" },
        last_refresh: "2026-07-07T09:59:23Z",
      }),
    )
    const creds = await run(loadCodexCliCredentials({ HOME: home }))
    expect(creds).toEqual({ accessToken: "at_1", refreshToken: "rt_1", accountId: "acct_1" })
  })

  test("returns undefined when the file is absent", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"))
    const creds = await run(loadCodexCliCredentials({ HOME: home }))
    expect(creds).toBeUndefined()
  })

  test("returns undefined when there is no access token", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"))
    await mkdir(join(home, ".codex"), { recursive: true })
    await writeFile(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: {} }))
    const creds = await run(loadCodexCliCredentials({ HOME: home }))
    expect(creds).toBeUndefined()
  })
})

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
