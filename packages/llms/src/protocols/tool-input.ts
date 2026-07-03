import { Effect } from "effect"
import type { ToolCall, ToolCallId, ToolInputDelta, ToolInputEnd, ToolInputStart } from "../schema"
import { LLMError } from "../schema"

interface Entry {
  readonly toolCallId: ToolCallId
  readonly name: string
  args: string
}

/**
 * Assembles streamed tool-call input: collects raw argument chunks by
 * `toolCallId`, emits lifecycle events, and parses the final JSON input.
 */
export interface ToolInputAssembler {
  start(toolCallId: ToolCallId, name: string): ToolInputStart
  append(toolCallId: ToolCallId, text: string): ToolInputDelta
  started(toolCallId: ToolCallId): boolean
  finish(toolCallId: ToolCallId): Effect.Effect<Array<ToolInputEnd | ToolCall>, LLMError>
  /** Ends every open tool call in start order: `tool-input-end` then the parsed `tool-call`. */
  finishAll(): Effect.Effect<Array<ToolInputEnd | ToolCall>, LLMError>
}

const parseArgs = (entry: Entry): Effect.Effect<unknown, LLMError> => {
  const raw = entry.args.trim()
  if (raw === "") {
    return Effect.succeed({})
  }
  return Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: () =>
      new LLMError({
        reason: "invalid-provider-output",
        message: `tool call "${entry.name}" arguments are not valid JSON: ${raw.slice(0, 200)}`,
        retryable: false,
      }),
  })
}

const finishEntry = (entry: Entry): Effect.Effect<Array<ToolInputEnd | ToolCall>, LLMError> =>
  Effect.gen(function* () {
    const input = yield* parseArgs(entry)
    return [
      { type: "tool-input-end", toolCallId: entry.toolCallId, name: entry.name },
      {
        type: "tool-call",
        toolCallId: entry.toolCallId,
        name: entry.name,
        input,
      },
    ]
  })

const makeAssembler = (): ToolInputAssembler => {
  const entries = new Map<ToolCallId, Entry>()
  return {
    start(toolCallId, name) {
      entries.set(toolCallId, { toolCallId, name, args: "" })
      return { type: "tool-input-start", toolCallId, name }
    },
    append(toolCallId, text) {
      const entry = entries.get(toolCallId)
      if (entry !== undefined) {
        entry.args += text
      }
      return { type: "tool-input-delta", toolCallId, text }
    },
    started: (toolCallId) => entries.has(toolCallId),
    finish: (toolCallId) =>
      Effect.suspend(() => {
        const entry = entries.get(toolCallId)
        if (entry === undefined) {
          return Effect.succeed<Array<ToolInputEnd | ToolCall>>([])
        }
        entries.delete(toolCallId)
        return finishEntry(entry)
      }),
    finishAll: () =>
      Effect.gen(function* () {
        const events: Array<ToolInputEnd | ToolCall> = []
        for (const entry of entries.values()) {
          events.push(...(yield* finishEntry(entry)))
        }
        entries.clear()
        return events
      }),
  }
}

export const ToolInput = {
  makeAssembler,
}
