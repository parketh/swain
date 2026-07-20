import type { AssistantContent, Message, ToolResultContent } from "@swain/llms"

/** A block inside an `assistant` stream event; swain-native block names. */
export type AssistantBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool-call"
      readonly id: string
      readonly name: string
      readonly input: unknown
    }

/** A block inside a `user` stream event; only tool results are surfaced. */
export interface ToolResultBlock {
  readonly type: "tool-result"
  readonly id: string
  readonly name?: string
  readonly isError: boolean
  readonly result: unknown
}

export type ResultSubtype = "success" | "error_during_execution" | "interrupted"

/**
 * One newline-delimited JSON event emitted by `swain exec --output-format
 * stream-json`. Structure loosely mirrors Claude Code's stream, but uses
 * swain-native block names and only the fields swain actually has.
 */
export type StreamEvent =
  | {
      readonly type: "init"
      readonly model: string
      readonly permissionMode: "auto" | "plan"
      readonly cwd: string
      readonly router: boolean
    }
  | { readonly type: "assistant"; readonly content: ReadonlyArray<AssistantBlock> }
  | { readonly type: "user"; readonly content: ReadonlyArray<ToolResultBlock> }
  | {
      readonly type: "result"
      readonly subtype: ResultSubtype
      readonly isError: boolean
      readonly result?: string
    }

export interface InitOptions {
  readonly model: string
  readonly permissionMode: "auto" | "plan"
  readonly cwd: string
  readonly router: boolean
}

export const initEvent = (options: InitOptions): StreamEvent => ({ type: "init", ...options })

const assistantBlock = (block: AssistantContent): AssistantBlock => {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text }
    case "reasoning":
      return { type: "reasoning", text: block.text }
    case "tool-call":
      return { type: "tool-call", id: block.toolCallId, name: block.name, input: block.input }
  }
}

const toolResultBlock = (block: ToolResultContent): ToolResultBlock => ({
  type: "tool-result",
  id: block.toolCallId,
  ...(block.name !== undefined && { name: block.name }),
  isError: block.isError ?? false,
  result: block.result.value,
})

/**
 * Maps a committed transcript message to a stream event. Assistant messages
 * always map; user messages map only when they carry tool results, so the
 * initial prompt echo and meta rows (model-switch, compaction) are skipped.
 */
export const messageEvent = (message: Message): StreamEvent | null => {
  if (message.role === "assistant") {
    return { type: "assistant", content: message.content.map(assistantBlock) }
  }
  const results = message.content.filter(
    (block): block is ToolResultContent => block.type === "tool-result",
  )
  if (results.length === 0) return null
  return { type: "user", content: results.map(toolResultBlock) }
}

export const resultEvent = (subtype: ResultSubtype, result?: string): StreamEvent => ({
  type: "result",
  subtype,
  isError: subtype !== "success",
  ...(result !== undefined && { result }),
})

/** Serializes an event as one NDJSON line (compact JSON plus a trailing newline). */
export const serialize = (event: StreamEvent): string => `${JSON.stringify(event)}\n`
