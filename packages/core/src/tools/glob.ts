import { Effect, Schema } from "effect"
import { resolveWorkspacePath } from "../files/paths"
import { defineTool, ToolContext } from "../tool"
import { runRipgrep } from "./ripgrep"

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

      // --hidden surfaces dotfiles (e.g. .github/); .git stays excluded.
      // .gitignore is still respected, so build/vendor noise is filtered.
      const matches = yield* runRipgrep(
        NAME,
        ["--files", "--hidden", "--glob", "!.git", "--glob", input.pattern],
        searchDir,
      )
      return {
        matches: matches.slice(0, MAX_MATCHES),
        truncated: matches.length > MAX_MATCHES,
      }
    }),
})
