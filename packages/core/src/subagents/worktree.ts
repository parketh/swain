import * as NodePath from "node:path"
import { Command, type CommandExecutor } from "@effect/platform"
import { Effect } from "effect"
import { ToolError } from "../errors"

export interface AgentWorktree {
  readonly path: string
  readonly branch: string
  readonly headCommit: string
  readonly gitRoot: string
}

export interface WorktreeCleanupResult {
  readonly retained: boolean
  readonly path?: string
  readonly branch?: string
}

const gitString = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, unknown, CommandExecutor.CommandExecutor> =>
  Command.string(Command.make("git", ...args).pipe(Command.workingDirectory(cwd)))

const gitExit = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<number, unknown, CommandExecutor.CommandExecutor> =>
  Command.exitCode(Command.make("git", ...args).pipe(Command.workingDirectory(cwd))).pipe(
    Effect.map(Number),
  )

const worktreeError = (message: string): ToolError =>
  new ToolError({ tool: "Agent", reason: "execution-failed", message })

/**
 * Creates an isolated git worktree for a write-capable child under the
 * canonical git root (`<git-root>/.swain/worktrees/<agent-id>`), on a fresh
 * branch derived from the agent id, checked out at the parent's current HEAD.
 * Fails with a recoverable tool error when the repository cannot create one.
 */
export const createAgentWorktree = (
  parentWorkingDir: string,
  agentId: string,
): Effect.Effect<AgentWorktree, ToolError, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const short = agentId.replace(/[^a-z0-9]/gi, "").slice(0, 8)
    const commonDir = yield* gitString(parentWorkingDir, ["rev-parse", "--git-common-dir"]).pipe(
      Effect.mapError(() =>
        worktreeError("Not a git repository; cannot create an isolated worktree."),
      ),
    )
    // The common dir points at the main repo's `.git`; its parent is the
    // canonical root even when the parent session is itself inside a worktree.
    const gitRoot = NodePath.dirname(NodePath.resolve(parentWorkingDir, commonDir.trim()))
    const headCommit = yield* gitString(parentWorkingDir, ["rev-parse", "HEAD"]).pipe(
      Effect.map((s) => s.trim()),
      Effect.mapError(() => worktreeError("Cannot resolve HEAD; repository has no commits.")),
    )
    const branch = `swain-agent-${short}`
    const path = NodePath.join(gitRoot, ".swain", "worktrees", agentId)
    const exit = yield* gitExit(gitRoot, ["worktree", "add", "-b", branch, path, headCommit]).pipe(
      Effect.mapError(() => worktreeError("Failed to run git worktree add.")),
    )
    if (exit !== 0) {
      return yield* worktreeError(`git worktree add failed (exit ${exit}).`)
    }
    return { path, branch, headCommit, gitRoot }
  })

/**
 * Removes a child worktree and its branch when nothing changed; keeps them when
 * there are uncommitted changes, new commits, or change detection fails.
 * Never fails: an uncertain outcome always retains the worktree.
 */
export const cleanupAgentWorktree = (
  worktree: AgentWorktree,
): Effect.Effect<WorktreeCleanupResult, never, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const retain: WorktreeCleanupResult = {
      retained: true,
      path: worktree.path,
      branch: worktree.branch,
    }
    const status = yield* gitString(worktree.path, ["status", "--porcelain"]).pipe(
      Effect.map((value) => ({ ok: true, value })),
      Effect.catchAll(() => Effect.succeed({ ok: false, value: "" })),
    )
    const revList = yield* gitString(worktree.path, [
      "rev-list",
      "--count",
      `${worktree.headCommit}..HEAD`,
    ]).pipe(
      Effect.map((value) => ({ ok: true, value })),
      Effect.catchAll(() => Effect.succeed({ ok: false, value: "" })),
    )
    if (!status.ok || !revList.ok) return retain
    const commits = Number.parseInt(revList.value.trim(), 10)
    if (Number.isNaN(commits)) return retain
    if (status.value.trim() !== "" || commits > 0) return retain

    const removeExit = yield* gitExit(worktree.gitRoot, [
      "worktree",
      "remove",
      "--force",
      worktree.path,
    ]).pipe(Effect.catchAll(() => Effect.succeed(1)))
    if (removeExit !== 0) return retain
    yield* gitExit(worktree.gitRoot, ["branch", "-D", worktree.branch]).pipe(
      Effect.catchAll(() => Effect.succeed(0)),
    )
    return { retained: false }
  })
