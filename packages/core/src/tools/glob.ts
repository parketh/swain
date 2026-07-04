import { Command } from "@effect/platform"
import { Effect, Schema } from "effect"
import { ToolError } from "../errors"
import { resolveWorkspacePath } from "../files/paths"
import { defineTool, ToolContext } from "../tool"

const NAME = "Glob"
const MAX_MATCHES = 1000

export const GlobInput = Schema.Struct({
  pattern: Schema.String,
  path: Schema.optional(Schema.String),
})

export const GlobResult = Schema.Struct({
  matches: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
})

export const Glob = defineTool({
  name: NAME,
  description: "List files matching a glob pattern using ripgrep.",
  inputSchema: GlobInput,
  outputSchema: GlobResult,
  readOnly: true,
  call: (input) =>
    Effect.gen(function* () {
      const { session } = yield* ToolContext
      const searchDir =
        input.path === undefined
          ? session.workingDirectory
          : yield* resolveWorkspacePath(NAME, session.workingDirectory, input.path)

      const command = Command.make("rg", "--files", "--glob", input.pattern).pipe(
        Command.workingDirectory(searchDir),
      )
      const lines = yield* Command.lines(command).pipe(
        Effect.mapError(
          (error) =>
            new ToolError({
              tool: NAME,
              reason: "execution-failed",
              message: `ripgrep failed: ${error.message}`,
            }),
        ),
      )
      const matches = lines.filter((line) => line.length > 0)
      return {
        matches: matches.slice(0, MAX_MATCHES),
        truncated: matches.length > MAX_MATCHES,
      }
    }),
})
