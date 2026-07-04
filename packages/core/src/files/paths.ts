import * as NodeFs from "node:fs/promises"
import * as NodePath from "node:path"
import { Effect } from "effect"
import { ToolError } from "../errors"

const escapes = (root: string, path: string): boolean =>
  path !== root && !path.startsWith(root + NodePath.sep)

const toError = (tool: string, input: string): ToolError =>
  new ToolError({
    tool,
    reason: "precondition-failed",
    message: `Path escapes the workspace: ${input}`,
  })

const realpath = (tool: string, path: string): Effect.Effect<string, ToolError> =>
  Effect.tryPromise({
    try: () => NodeFs.realpath(path),
    catch: (error) =>
      new ToolError({
        tool,
        reason: "execution-failed",
        message: error instanceof Error ? error.message : String(error),
      }),
  })

const canonicalize = (tool: string, path: string): Effect.Effect<string, ToolError> =>
  Effect.tryPromise({
    try: async () => {
      const missing: Array<string> = []
      let current = path
      while (true) {
        try {
          return NodePath.join(await NodeFs.realpath(current), ...missing)
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
          const parent = NodePath.dirname(current)
          if (parent === current) throw error
          missing.unshift(NodePath.basename(current))
          current = parent
        }
      }
    },
    catch: (error) =>
      new ToolError({
        tool,
        reason: "execution-failed",
        message: error instanceof Error ? error.message : String(error),
      }),
  })

/**
 * Resolves a user- or model-supplied path against the workspace root and
 * rejects anything that escapes it. Returns a normalized absolute path.
 */
export const resolveWorkspacePath = (
  tool: string,
  workingDirectory: string,
  input: string,
): Effect.Effect<string, ToolError> => {
  const root = NodePath.resolve(workingDirectory)
  const absolute = NodePath.isAbsolute(input)
    ? NodePath.normalize(input)
    : NodePath.resolve(root, input)
  if (escapes(root, absolute)) return Effect.fail(toError(tool, input))

  return Effect.gen(function* () {
    const realRoot = yield* realpath(tool, root)
    const realTarget = yield* canonicalize(tool, absolute)
    if (escapes(realRoot, realTarget)) {
      return yield* toError(tool, input)
    }
    return absolute
  })
}
