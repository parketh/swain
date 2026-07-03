import * as NodePath from "node:path"
import { Effect } from "effect"
import { ToolError } from "../errors"

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
  if (absolute !== root && !absolute.startsWith(root + NodePath.sep)) {
    return Effect.fail(
      new ToolError({
        tool,
        reason: "precondition-failed",
        message: `Path escapes the workspace: ${input}`,
      }),
    )
  }
  return Effect.succeed(absolute)
}
