import type { HttpClient } from "@effect/platform"
import { Duration, Effect, Stream } from "effect"
import { LLMError } from "./schema/errors"
import type { LLMEvent } from "./schema/events"
import type { ToolChoice, UserContent } from "./schema/messages"
import { Message, SystemContent, Tool } from "./schema/messages"
import type { LLMRequest, LLMResponse, Model, ProviderOptions } from "./schema/options"
import { GenerationOptions } from "./schema/options"

export interface LLMRequestInput {
  readonly model: Model
  readonly system?: string | SystemContent
  readonly prompt?: string | ReadonlyArray<UserContent>
  readonly messages?: ReadonlyArray<Message>
  readonly tools?: ReadonlyArray<Tool>
  readonly toolChoice?: ToolChoice
  readonly generation?: GenerationOptions
  readonly providerOptions?: ProviderOptions
}

const request = (input: LLMRequestInput): LLMRequest => {
  const messages = [...(input.messages ?? [])]
  if (input.prompt !== undefined) {
    messages.push(Message.user(input.prompt))
  }
  return {
    model: input.model,
    ...(input.system !== undefined && {
      system: typeof input.system === "string" ? SystemContent.text(input.system) : input.system,
    }),
    messages,
    ...(input.tools !== undefined && { tools: input.tools.map((tool) => Tool.define(tool)) }),
    ...(input.toolChoice !== undefined && { toolChoice: input.toolChoice }),
    ...(input.generation !== undefined && { generation: GenerationOptions.make(input.generation) }),
    ...(input.providerOptions !== undefined && { providerOptions: input.providerOptions }),
  }
}

/**
 * Fail a turn whose provider stream goes silent for this long instead of hanging
 * the whole loop indefinitely. Idle-based (resets on every event), so it catches
 * a stream that stalls mid-response, not just one that never starts. Healthy
 * streams emit within ~1s and never gap more than ~10s, so 60s is ample headroom
 * while still failing fast enough for the agent's bounded retry to recover.
 */
const STREAM_IDLE_TIMEOUT = Duration.seconds(60)

const streamTurn = (
  request: LLMRequest,
): Stream.Stream<LLMEvent, LLMError, HttpClient.HttpClient> =>
  request.model.streamTurn(request).pipe(
    // Debug-level trace of each event so a stall is diagnosable (last event
    // before silence). Filtered out unless the min log level is Debug.
    Stream.tap((event) => Effect.logDebug(`llm.stream ${event.type}`)),
    Stream.timeoutFail(
      () =>
        new LLMError({
          reason: "network-error",
          message: `Provider stream stalled: no data for ${Duration.toSeconds(STREAM_IDLE_TIMEOUT)}s.`,
          retryable: true,
        }),
      STREAM_IDLE_TIMEOUT,
    ),
  )

/**
 * Convenience wrapper over `LLM.streamTurn`: collects the streamed events of
 * one model turn into a single `LLMResponse`. When the stream fails after
 * partial events, the failure carries them in `LLMError.eventsSoFar`.
 */
const generateTurn = (
  request: LLMRequest,
): Effect.Effect<LLMResponse, LLMError, HttpClient.HttpClient> =>
  Effect.suspend(() => {
    const collected: Array<LLMEvent> = []
    return streamTurn(request).pipe(
      Stream.runForEach((event) => Effect.sync(() => collected.push(event))),
      Effect.map(() => ({ events: [...collected] })),
      Effect.mapError((error) =>
        error.eventsSoFar !== undefined
          ? error
          : new LLMError({
              reason: error.reason,
              message: error.message,
              retryable: error.retryable,
              ...(error.retryAfter !== undefined && { retryAfter: error.retryAfter }),
              eventsSoFar: [...collected],
            }),
      ),
    )
  })

export const LLM = {
  request,
  streamTurn,
  generateTurn,
}
