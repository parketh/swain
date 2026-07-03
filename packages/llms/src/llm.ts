import type { HttpClient } from "@effect/platform"
import { Effect, Stream } from "effect"
import { LLMError } from "./schema/errors"
import type { LLMEvent } from "./schema/events"
import { Message, SystemContent, Tool } from "./schema/messages"
import type { ToolChoice, UserContent } from "./schema/messages"
import { GenerationOptions } from "./schema/options"
import type { LLMRequest, LLMResponse, Model, ProviderOptions } from "./schema/options"

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

const streamTurn = (
  request: LLMRequest,
): Stream.Stream<LLMEvent, LLMError, HttpClient.HttpClient> => request.model.streamTurn(request)

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
