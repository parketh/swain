import type { HttpClient } from "@effect/platform"
import type { Effect } from "effect"
import { Schema } from "effect"
import type { ToolError } from "../../errors"
import { defineTool, type Tool } from "../../tool"
import { ExaSearchOptions } from "./exa"

export const WebSearchInput = Schema.Struct({
  query: Schema.String,
  numResults: Schema.optional(Schema.Number),
  providerOptions: Schema.optional(
    Schema.Struct({
      exa: Schema.optional(ExaSearchOptions),
    }),
  ),
})
export type WebSearchInput = typeof WebSearchInput.Type

export const WebSearchResult = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  text: Schema.optional(Schema.String),
  publishedDate: Schema.optional(Schema.String),
  author: Schema.optional(Schema.String),
})
export type WebSearchResult = typeof WebSearchResult.Type

export const WebSearchOutput = Schema.Struct({
  results: Schema.Array(WebSearchResult),
})
export type WebSearchOutput = typeof WebSearchOutput.Type

/**
 * Provider-neutral web search. Concrete providers (Exa) live behind this
 * interface so provider contract changes stay isolated to their own module.
 */
export interface SearchProvider {
  readonly search: (
    input: WebSearchInput,
  ) => Effect.Effect<WebSearchOutput, ToolError, HttpClient.HttpClient>
}

export const makeWebSearch = (
  provider: SearchProvider,
): Tool<WebSearchInput, WebSearchOutput, HttpClient.HttpClient> =>
  defineTool({
    name: "WebSearch",
    description: "Search the web for a query and return ranked results.",
    inputSchema: WebSearchInput,
    outputSchema: WebSearchOutput,
    readOnly: true,
    recordDuration: true,
    call: (input) => provider.search(input),
  })
