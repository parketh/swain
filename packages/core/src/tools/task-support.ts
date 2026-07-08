import { ToolError } from "../errors"
import { TaskError } from "../tasks"

/** Maps store/logical failures onto the model-facing `ToolError` reasons. */
export const toToolError = (tool: string, error: unknown): ToolError => {
  if (error instanceof ToolError) return error
  if (error instanceof TaskError) {
    return new ToolError({
      tool,
      reason: error.reason === "not-found" ? "not-found" : "precondition-failed",
      message: error.message,
    })
  }
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error)
  return new ToolError({ tool, reason: "execution-failed", message })
}
