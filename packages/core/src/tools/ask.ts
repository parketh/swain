import { Context, Effect, Schema } from "effect"
import { defineTool } from "../tool"

export const AskQuestion = Schema.Struct({
  question: Schema.String,
  options: Schema.Array(Schema.String),
  multiSelect: Schema.optional(Schema.Boolean),
})

export const AskInput = Schema.Struct({
  questions: Schema.Array(AskQuestion),
})
export type AskInput = typeof AskInput.Type

export const AskAnswer = Schema.Struct({
  question: Schema.String,
  selected: Schema.Array(Schema.String),
})

export const AskResult = Schema.Struct({
  answers: Schema.Array(AskAnswer),
})
export type AskResult = typeof AskResult.Type

/** Injectable interaction source. The runtime wires a real prompt; tests inject fixed answers. */
export interface AskHandler {
  readonly ask: (input: AskInput) => Effect.Effect<AskResult>
}

export class AskService extends Context.Tag("@swain/core/AskService")<AskService, AskHandler>() {}

export const Ask = defineTool({
  name: "Ask",
  description: "Ask the user one or more multiple-choice questions to clarify intent.",
  inputSchema: AskInput,
  outputSchema: AskResult,
  readOnly: true,
  call: (input) => Effect.flatMap(AskService, (handler) => handler.ask(input)),
})
