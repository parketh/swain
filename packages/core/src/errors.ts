import { Data } from "effect"

export type ToolErrorReason =
  | "unknown-tool"
  | "invalid-input"
  | "invalid-output"
  | "denied"
  | "not-found"
  | "precondition-failed"
  | "unsupported"
  | "execution-failed"

export class ToolError extends Data.TaggedError("ToolError")<{
  readonly tool: string
  readonly reason: ToolErrorReason
  readonly message: string
}> {}
