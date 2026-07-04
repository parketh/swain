import { HttpClient, HttpClientRequest } from "@effect/platform"
import { Effect, Schema } from "effect"
import { ToolError } from "../../errors"
import type { SearchProvider, WebSearchInput, WebSearchOutput } from "./tool"

const NAME = "WebSearch"
const ENDPOINT = "https://api.exa.ai/search"

/** Exa-specific search knobs threaded through `providerOptions.exa`. */
export const ExaSearchOptions = Schema.Struct({
  type: Schema.optional(Schema.Literal("auto", "neural", "keyword", "fast")),
})

const ExaResult = Schema.Struct({
  title: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.String,
  text: Schema.optional(Schema.NullOr(Schema.String)),
  publishedDate: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.optional(Schema.NullOr(Schema.String)),
  id: Schema.optional(Schema.String),
})

const ExaResponse = Schema.Struct({
  requestId: Schema.optional(Schema.String),
  results: Schema.Array(ExaResult),
  costDollars: Schema.optional(Schema.Unknown),
})

const fail = (reason: ToolError["reason"], message: string): ToolError =>
  new ToolError({ tool: NAME, reason, message })

/**
 * Exa search over a direct HTTP call. Exa-specific knobs travel through
 * `providerOptions.exa`; the neutral `WebSearchInput`/`WebSearchOutput` shapes
 * stay provider-agnostic so only this module changes if Exa's contract does.
 */
export const exaSearch = (
  input: WebSearchInput,
): Effect.Effect<WebSearchOutput, ToolError, HttpClient.HttpClient> =>
  Effect.scoped(
    Effect.gen(function* () {
      const apiKey = process.env.EXA_API_KEY
      if (apiKey === undefined || apiKey.length === 0) {
        return yield* fail("precondition-failed", "EXA_API_KEY is not set.")
      }

      const client = yield* HttpClient.HttpClient
      const body = {
        query: input.query,
        ...(input.numResults !== undefined && { numResults: input.numResults }),
        ...(input.providerOptions?.exa ?? {}),
      }

      const request = yield* HttpClientRequest.post(ENDPOINT)
        .pipe(HttpClientRequest.setHeader("x-api-key", apiKey), HttpClientRequest.bodyJson(body))
        .pipe(Effect.mapError((error) => fail("execution-failed", String(error))))

      const response = yield* client
        .execute(request)
        .pipe(Effect.mapError((error) => fail("execution-failed", error.message)))
      const json = yield* response.json.pipe(
        Effect.mapError((error) => fail("invalid-output", error.message)),
      )
      const decoded = yield* Schema.decodeUnknown(ExaResponse)(json).pipe(
        Effect.mapError((error) => fail("invalid-output", String(error))),
      )

      return {
        results: decoded.results.map((result) => ({
          title: result.title ?? "",
          url: result.url,
          ...(result.text != null && { text: result.text }),
          ...(result.publishedDate != null && { publishedDate: result.publishedDate }),
          ...(result.author != null && { author: result.author }),
        })),
      }
    }),
  )

export const ExaSearchProvider: SearchProvider = { search: exaSearch }
