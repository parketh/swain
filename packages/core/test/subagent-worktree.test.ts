import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunContext } from "@effect/platform-bun"
import { Effect } from "effect"
import {
  type AgentWorktree,
  cleanupAgentWorktree,
  createAgentWorktree,
  removeTaskWorktrees,
} from "../src/subagents/worktree"

// biome-ignore lint/suspicious/noExplicitAny: git effects require CommandExecutor from BunContext
const run = <A, E>(eff: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provide(BunContext.layer)) as Effect.Effect<A, E, never>)
// biome-ignore lint/suspicious/noExplicitAny: identity wrapper preserving requirements
const provide = <A, E>(eff: Effect.Effect<A, E, any>): Effect.Effect<A, E, any> => eff

describe("agent worktree", () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "swain-wt-"))
    execSync("git init -q", { cwd: repo })
    execSync("git config user.email t@t.com && git config user.name t", { cwd: repo })
    writeFileSync(join(repo, "file.txt"), "hello\n")
    execSync("git add -A && git commit -q -m init", { cwd: repo })
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  test("creates a worktree at the canonical root and cleans up when unchanged", async () => {
    const result = await run(
      provide(
        Effect.gen(function* () {
          const wt = yield* createAgentWorktree(repo, "abcd1234ef")
          const existedBefore = existsSync(wt.path)
          const cleanup = yield* cleanupAgentWorktree(wt)
          return { wt, existedBefore, cleanup }
        }),
      ),
    )
    expect(result.wt.path).toContain(join(".swain", "worktrees", "abcd1234ef"))
    expect(result.wt.branch).toBe("swain-agent-abcd1234")
    expect(result.existedBefore).toBe(true)
    expect(result.cleanup.retained).toBe(false)
    expect(existsSync(result.wt.path)).toBe(false)
  })

  test("keeps the worktree when it has uncommitted changes", async () => {
    const result = await run(
      provide(
        Effect.gen(function* () {
          const wt = yield* createAgentWorktree(repo, "changed01")
          yield* Effect.sync(() => writeFileSync(join(wt.path, "new.txt"), "dirty\n"))
          const cleanup = yield* cleanupAgentWorktree(wt)
          return { wt, cleanup }
        }),
      ),
    )
    expect(result.cleanup.retained).toBe(true)
    expect(result.cleanup.path).toBe(result.wt.path)
    expect(existsSync(result.wt.path)).toBe(true)
  })

  test("keeps the worktree when change detection fails", async () => {
    const result = await run(
      provide(
        Effect.gen(function* () {
          const wt = yield* createAgentWorktree(repo, "detectfail")
          const broken: AgentWorktree = {
            ...wt,
            headCommit: "0000000000000000000000000000000000000000",
          }
          return yield* cleanupAgentWorktree(broken)
        }),
      ),
    )
    expect(result.retained).toBe(true)
  })

  test("removeTaskWorktrees force-removes recorded worktrees and prunes", async () => {
    const result = await run(
      provide(
        Effect.gen(function* () {
          const wt = yield* createAgentWorktree(repo, "dangling01")
          // Leave uncommitted work so a normal cleanup would retain it — recovery
          // must remove it regardless.
          yield* Effect.sync(() => writeFileSync(join(wt.path, "new.txt"), "dirty\n"))
          const existedBefore = existsSync(wt.path)
          yield* removeTaskWorktrees(repo, [{ worktreePath: wt.path, worktreeBranch: wt.branch }])
          return { wt, existedBefore }
        }),
      ),
    )
    expect(result.existedBefore).toBe(true)
    expect(existsSync(result.wt.path)).toBe(false)
    const branches = execSync("git branch --list swain-agent-dangling01", { cwd: repo }).toString()
    expect(branches.trim()).toBe("")
  })

  test("removeTaskWorktrees ignores tasks with no recorded worktree", async () => {
    await run(provide(removeTaskWorktrees(repo, [{}, { worktreePath: undefined }])))
  })

  test("fails with a recoverable tool error outside a git repository", async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "swain-norepo-"))
    const error = await run(provide(createAgentWorktree(nonRepo, "x").pipe(Effect.flip)))
    rmSync(nonRepo, { recursive: true, force: true })
    expect((error as { reason: string }).reason).toBe("execution-failed")
  })
})
