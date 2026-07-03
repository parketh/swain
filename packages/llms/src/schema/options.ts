import type { HttpClient } from "@effect/platform"
import type { Stream } from "effect"
import { Schema } from "effect"
import type { LLMError } from "./errors"
import type { LLMEvent } from "./events"
import type { ModelId, ProviderId } from "./ids"
import type { Message, SystemContent, Tool, ToolChoice } from "./messages"

export const GenerationOptions = Schema.Struct({
  maxTokens: Schema.optional(Schema.Number),
  stop: Schema.optional(Schema.Array(Schema.String)),
})
export type GenerationOptions = typeof GenerationOptions.Type

export type ProviderOptions = {
  readonly [providerId: string]: unknown
}

export interface ModelLimits {
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
}

export interface Model {
  readonly id: ModelId
  readonly provider: ProviderId
  readonly limits?: ModelLimits
  streamTurn(request: LLMRequest): Stream.Stream<LLMEvent, LLMError, HttpClient.HttpClient>
}

export interface LLMRequest {
  readonly model: Model
  readonly system?: SystemContent
  readonly messages: ReadonlyArray<Message>
  readonly tools?: ReadonlyArray<Tool>
  readonly toolChoice?: ToolChoice
  readonly generation?: GenerationOptions
  readonly providerOptions?: ProviderOptions
}

export interface LLMResponse {
  readonly events: ReadonlyArray<LLMEvent>
}
