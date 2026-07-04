import { HttpClient } from "@effect/platform"
import { Context, Effect, Layer, Stream } from "effect"
import { LLM } from "./llm"
import type { LLMError } from "./schema/errors"
import type { LLMEvent } from "./schema/events"
import type { LLMRequest, LLMResponse } from "./schema/options"

export interface LLMClient {
  readonly request: typeof LLM.request
  readonly streamTurn: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  readonly generateTurn: (request: LLMRequest) => Effect.Effect<LLMResponse, LLMError>
}

export class Service extends Context.Tag("@swain/LLMClient")<Service, LLMClient>() {}

export const layer: Layer.Layer<Service, never, HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.map(HttpClient.HttpClient, (httpClient) => ({
    request: LLM.request,
    streamTurn: (request: LLMRequest) =>
      LLM.streamTurn(request).pipe(Stream.provideService(HttpClient.HttpClient, httpClient)),
    generateTurn: (request: LLMRequest) =>
      LLM.generateTurn(request).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
  })),
)

const streamTurn = (request: LLMRequest): Stream.Stream<LLMEvent, LLMError, Service> =>
  Stream.unwrap(Effect.map(Service, (client) => client.streamTurn(request)))

const generateTurn = (request: LLMRequest): Effect.Effect<LLMResponse, LLMError, Service> =>
  Effect.flatMap(Service, (client) => client.generateTurn(request))

export const LLMClient = {
  Service,
  layer,
  request: LLM.request,
  streamTurn,
  generateTurn,
}
