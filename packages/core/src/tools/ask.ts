import { Context, Effect, Schema } from "effect"
import { defineTool } from "../tool"

export const AskOption = Schema.Struct({
  label: Schema.String,
  description: Schema.String,
})

export const AskQuestion = Schema.Struct({
  question: Schema.String,
  options: Schema.Array(AskOption).pipe(Schema.minItems(2), Schema.maxItems(4)),
  multiSelect: Schema.optional(Schema.Boolean),
})

export const AskInput = Schema.Struct({
  questions: Schema.Array(AskQuestion).pipe(
    Schema.minItems(1),
    Schema.maxItems(4),
    Schema.filter(
      (questions) =>
        new Set(questions.map((q) => q.question)).size === questions.length ||
        "question texts must be unique",
    ),
  ),
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
  description:
    "Ask the user 1-4 multiple-choice questions to clarify intent. Each question " +
    "takes 2-4 options; give every option a short label and a description of its " +
    "trade-offs. `selected` echoes back the chosen option labels.",
  inputSchema: AskInput,
  outputSchema: AskResult,
  readOnly: true,
  call: (input) => Effect.flatMap(AskService, (handler) => handler.ask(input)),
})
