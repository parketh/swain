import { Data, Schema } from "effect"
import type { Duration } from "effect"
import type { LLMEvent } from "./events"

export const LLMErrorReason = Schema.Literal(
  "rate-limited",
  "overloaded",
  "context-length-exceeded",
  "auth-failed",
  "invalid-request",
  "server-error",
  "network-error",
  "invalid-provider-output",
  "unsupported-feature",
)
export type LLMErrorReason = typeof LLMErrorReason.Type

export class LLMError extends Data.TaggedError("LLMError")<{
  readonly reason: LLMErrorReason
  readonly message: string
  readonly retryable: boolean
  readonly retryAfter?: Duration.Duration
  readonly eventsSoFar?: ReadonlyArray<LLMEvent>
}> {}
