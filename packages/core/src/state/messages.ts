import {
  type AssistantContent,
  type AssistantMessage,
  Message,
  type MessageTiming,
  type UserContent,
  type UserMessage,
} from "@swain/llms"

/** Wall-clock UTC commit timestamp for a persisted transcript message. */
export const messageTimestamp = (): string => new Date().toISOString()

export interface UserMessageOptions extends MessageTiming {
  readonly isMeta?: boolean
}

/**
 * Core-owned constructor that stamps a user message with a commit `createdAt`
 * (defaulting to now) plus any supplied duration metadata, then delegates to the
 * `@swain/llms` constructor. Every persisted user message flows through here so
 * the transcript is uniformly timestamped; deterministic call sites/tests pass an
 * explicit `createdAt`.
 */
export const userMessage = (
  input: string | ReadonlyArray<UserContent>,
  options: UserMessageOptions = {},
): UserMessage => {
  const { isMeta = false, createdAt, ...durations } = options
  return Message.user(input, isMeta, { createdAt: createdAt ?? messageTimestamp(), ...durations })
}

/** Core-owned assistant-message constructor mirroring {@link userMessage}. */
export const assistantMessage = (
  input: string | ReadonlyArray<AssistantContent>,
  options: MessageTiming = {},
): AssistantMessage => {
  const { createdAt, ...durations } = options
  return Message.assistant(input, { createdAt: createdAt ?? messageTimestamp(), ...durations })
}
