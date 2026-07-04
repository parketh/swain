import { Command } from "@effect/platform"
import { Effect } from "effect"
import { ToolError } from "../errors"
import { collectCapped } from "./collect"

// Backstop against a runaway match set flooding memory; callers additionally
// cap the returned line count. Wide enough that the count cap fires first in
// normal use.
const MAX_STDOUT = 20_000_000

/**
 * Runs ripgrep and returns its stdout lines. Exit code 1 (no matches) is
 * success with no lines; exit code >= 2 (usage/regex error) surfaces as a
 * ToolError so malformed patterns aren't silently reported as "no results".
 */
export const runRipgrep = (tool: string, args: ReadonlyArray<string>, cwd: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const command = Command.make("rg", ...args).pipe(Command.workingDirectory(cwd))
      const process = yield* Command.start(command).pipe(
        Effect.mapError(
          (error) =>
            new ToolError({
              tool,
              reason: "execution-failed",
              message: `ripgrep failed to start (is it installed?): ${error.message}`,
            }),
        ),
      )
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [
          process.exitCode,
          collectCapped(process.stdout, MAX_STDOUT),
          collectCapped(process.stderr, MAX_STDOUT),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          (error) => new ToolError({ tool, reason: "execution-failed", message: error.message }),
        ),
      )
      if (Number(exitCode) >= 2) {
        return yield* new ToolError({
          tool,
          reason: "execution-failed",
          message: `ripgrep failed: ${stderr.text.trim() || `exit ${exitCode}`}`,
        })
      }
      return stdout.text.split("\n").filter((line) => line.length > 0)
    }),
  )
