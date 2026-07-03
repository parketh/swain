import { HttpClient, HttpClientRequest } from "@effect/platform"
import type { HttpClientError, HttpClientResponse } from "@effect/platform"
import { Duration, Effect, Stream } from "effect"
import { LLMError } from "../schema"
import { SSE } from "./sse"
import type { SSEEvent } from "./sse"

export interface PrepareJsonOptions {
  readonly method?: "POST" | "PUT" | "PATCH" | "DELETE"
  readonly url: string
  readonly headers?: Record<string, string>
  readonly body: unknown
}

export interface SseJsonEvent {
  readonly event?: string
  readonly json: unknown
}

/** Builds an HttpClientRequest with method, URL, headers, and JSON body without sending it. */
const prepareJson = (options: PrepareJsonOptions): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.make(options.method ?? "POST")(options.url).pipe(
    HttpClientRequest.setHeaders(options.headers ?? {}),
    HttpClientRequest.bodyUnsafeJson(options.body),
  )

const fromHttpClientError = (error: HttpClientError.HttpClientError): LLMError =>
  new LLMError({
    reason: "network-error",
    message: `${error._tag === "RequestError" ? "request failed" : "response failed"}: ${String(error)}`,
    retryable: true,
  })

const parseRetryAfter = (value: string | undefined): Duration.Duration | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (/^\d+$/.test(value.trim())) {
    return Duration.seconds(Number(value.trim()))
  }
  const date = Date.parse(value)
  if (Number.isNaN(date)) {
    return undefined
  }
  return Duration.millis(Math.max(0, date - Date.now()))
}

const statusToError = (response: HttpClientResponse.HttpClientResponse, body: string): LLMError => {
  const status = response.status
  const detail = body === "" ? "" : `: ${body.slice(0, 500)}`
  const message = `provider returned status ${status}${detail}`
  if (status === 429) {
    const retryAfter = parseRetryAfter(response.headers["retry-after"])
    return new LLMError({
      reason: "rate-limited",
      message,
      retryable: true,
      ...(retryAfter === undefined ? {} : { retryAfter }),
    })
  }
  if (status === 529) {
    return new LLMError({ reason: "overloaded", message, retryable: true })
  }
  if (status === 401 || status === 403) {
    return new LLMError({ reason: "auth-failed", message, retryable: false })
  }
  if (status >= 500) {
    return new LLMError({ reason: "server-error", message, retryable: true })
  }
  return new LLMError({ reason: "invalid-request", message, retryable: false })
}

const parseSseJson = (event: SSEEvent): Effect.Effect<SseJsonEvent, LLMError> =>
  Effect.try({
    try: () => ({
      ...(event.event === undefined ? {} : { event: event.event }),
      json: JSON.parse(event.data) as unknown,
    }),
    catch: () =>
      new LLMError({
        reason: "invalid-provider-output",
        message: `provider sent malformed SSE JSON: ${event.data.slice(0, 200)}`,
        retryable: false,
      }),
  })

/**
 * Executes the request via the `HttpClient.HttpClient` service and streams
 * parsed SSE JSON payloads until the stream ends or a `[DONE]` sentinel is
 * seen. Fatal transport/provider failures fail the stream with `LLMError`.
 * Interruption aborts the in-flight request via `HttpClient`'s own handling.
 */
const streamSseJson = (
  request: HttpClientRequest.HttpClientRequest,
): Stream.Stream<SseJsonEvent, LLMError, HttpClient.HttpClient> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(request).pipe(Effect.mapError(fromHttpClientError))
      if (response.status >= 400) {
        const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
        return yield* Effect.fail(statusToError(response, body))
      }
      return response.stream.pipe(
        Stream.mapError(fromHttpClientError),
        Stream.decodeText(),
        decodeSse,
        Stream.takeWhile((event) => !SSE.isDone(event)),
        Stream.mapEffect(parseSseJson),
      )
    }),
  )

const decodeSse = <E, R>(self: Stream.Stream<string, E, R>): Stream.Stream<SSEEvent, E, R> =>
  Stream.suspend(() => {
    const decoder = SSE.makeDecoder()
    return Stream.mapConcat(self, (chunk) => decoder.feed(chunk))
  })

export const Http = {
  prepareJson,
  streamSseJson,
}
