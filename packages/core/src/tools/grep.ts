import { Effect, Schema } from "effect"
import { resolveWorkspacePath } from "../files/paths"
import { defineTool, ToolContext } from "../tool"
import { runRipgrep } from "./ripgrep"

const NAME = "Grep"
const MAX_MATCHES = 1000

export const GrepInput = Schema.Struct({
  pattern: Schema.String,
  path: Schema.optional(Schema.String),
  glob: Schema.optional(Schema.String),
})

export const GrepResult = Schema.Struct({
  matches: Schema.Array(
    Schema.Struct({
      file: Schema.String,
      line: Schema.Number,
      text: Schema.String,
    }),
  ),
  truncated: Schema.Boolean,
})

const parseLine = (line: string): { file: string; line: number; text: string } | undefined => {
  const first = line.indexOf(":")
  const second = line.indexOf(":", first + 1)
  if (first === -1 || second === -1) return undefined
  const lineNumber = Number(line.slice(first + 1, second))
  if (!Number.isInteger(lineNumber)) return undefined
  return { file: line.slice(0, first), line: lineNumber, text: line.slice(second + 1) }
}

export const Grep = defineTool({
  name: NAME,
  description: "Search file contents for a pattern using ripgrep.",
  inputSchema: GrepInput,
  outputSchema: GrepResult,
  readOnly: true,
  call: (input) =>
    Effect.gen(function* () {
      const { session } = yield* ToolContext
      const searchDir =
        input.path === undefined
          ? session.workingDirectory
          : yield* resolveWorkspacePath(NAME, session.workingDirectory, input.path)

      const args = [
        "--line-number",
        "--no-heading",
        "--color",
        "never",
        "--hidden",
        "--glob",
        "!.git",
        // Cap runaway minified/generated lines instead of flooding context.
        "--max-columns",
        "500",
      ]
      if (input.glob !== undefined) args.push("--glob", input.glob)
      // `-e` guards patterns starting with `-` from being parsed as flags.
      // Explicit "." search path; without it rg reads (and blocks on) stdin.
      args.push("-e", input.pattern, ".")

      const lines = yield* runRipgrep(NAME, args, searchDir)
      const matches = lines
        .map(parseLine)
        .filter((match): match is NonNullable<typeof match> => match !== undefined)
      return {
        matches: matches.slice(0, MAX_MATCHES),
        truncated: matches.length > MAX_MATCHES,
      }
    }),
})
