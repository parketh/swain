import { HttpClient } from "@effect/platform"
import { Effect, Schema } from "effect"
import { ToolError } from "../errors"
import { defineTool } from "../tool"

const NAME = "WebFetch"
const MAX_TEXT = 100_000

export const WebFetchInput = Schema.Struct({
  url: Schema.String,
})

export const WebFetchResult = Schema.Struct({
  url: Schema.String,
  contentType: Schema.String,
  supported: Schema.Boolean,
  text: Schema.optional(Schema.String),
  truncated: Schema.Boolean,
})

const isTextLike = (contentType: string): boolean =>
  /text\/html|text\/plain|application\/(json|xml)|text\//.test(contentType)

export const WebFetch = defineTool({
  name: NAME,
  description: "Fetch a URL over HTTP and return extracted text for text-like responses.",
  inputSchema: WebFetchInput,
  outputSchema: WebFetchResult,
  readOnly: true,
  call: (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client
          .get(input.url)
          .pipe(
            Effect.mapError(
              (error) =>
                new ToolError({ tool: NAME, reason: "execution-failed", message: error.message }),
            ),
          )
        const contentType = response.headers["content-type"] ?? ""
        if (!isTextLike(contentType)) {
          return { url: input.url, contentType, supported: false, truncated: false }
        }
        const body = yield* response.text.pipe(
          Effect.mapError(
            (error) =>
              new ToolError({ tool: NAME, reason: "execution-failed", message: error.message }),
          ),
        )
        const truncated = body.length > MAX_TEXT
        return {
          url: input.url,
          contentType,
          supported: true,
          text: truncated ? body.slice(0, MAX_TEXT) : body,
          truncated,
        }
      }),
    ),
})
