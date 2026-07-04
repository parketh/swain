import { Command } from "@effect/platform"
import { Effect, Stream } from "effect"
import { ToolError } from "../errors"

const collect = (stream: Stream.Stream<Uint8Array, unknown>): Effect.Effect<string, never> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold("", (accumulator, chunk) => accumulator + chunk),
    Effect.orElseSucceed(() => ""),
  )

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
        [process.exitCode, collect(process.stdout), collect(process.stderr)],
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
          message: `ripgrep failed: ${stderr.trim() || `exit ${exitCode}`}`,
        })
      }
      return stdout.split("\n").filter((line) => line.length > 0)
    }),
  )
