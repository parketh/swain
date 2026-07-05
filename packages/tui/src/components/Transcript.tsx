import type { AgentEvent } from "@swain/core"
import type { Message } from "@swain/llms"
import { Box, Text } from "ink"

export interface ToolRow {
  readonly toolCallId: string
  readonly name: string
  readonly output: string
  readonly done: boolean
  readonly isError: boolean
}

export interface DraftState {
  readonly assistant: string
  readonly reasoning: string
  readonly tools: ReadonlyArray<ToolRow>
  readonly errors: ReadonlyArray<string>
}

export const emptyDraft: DraftState = { assistant: "", reasoning: "", tools: [], errors: [] }

/**
 * Folds one `AgentEvent` into live draft state: streamed assistant/reasoning
 * text, per-`toolCallId` tool rows (progress appended before finalization), and
 * provider/agent errors. This is display-only; authoritative history stays in
 * `session.messages`.
 */
export const foldEvent = (state: DraftState, event: AgentEvent): DraftState => {
  switch (event.type) {
    case "llm-event": {
      const inner = event.event
      if (inner.type === "text-delta") return { ...state, assistant: state.assistant + inner.text }
      if (inner.type === "reasoning-delta")
        return { ...state, reasoning: state.reasoning + inner.text }
      if (inner.type === "provider-error")
        return { ...state, errors: [...state.errors, inner.message] }
      return state
    }
    case "tool-execution-start":
      return {
        ...state,
        tools: [
          ...state.tools,
          {
            toolCallId: String(event.toolCallId),
            name: event.name,
            output: "",
            done: false,
            isError: false,
          },
        ],
      }
    case "tool-execution-delta":
      return {
        ...state,
        tools: state.tools.map((row) =>
          row.toolCallId === String(event.toolCallId)
            ? { ...row, output: row.output + event.text }
            : row,
        ),
      }
    case "tool-execution-end":
      return {
        ...state,
        tools: state.tools.map((row) =>
          row.toolCallId === String(event.toolCallId)
            ? { ...row, done: true, isError: event.isError }
            : row,
        ),
      }
    case "agent-error":
      return { ...state, errors: [...state.errors, event.message] }
    default:
      return state
  }
}

export const foldEvents = (events: ReadonlyArray<AgentEvent>): DraftState =>
  events.reduce(foldEvent, emptyDraft)

const preview = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

// biome-ignore lint/suspicious/noExplicitAny: opaque message content blocks
const MessageRow = ({ message }: { message: any }) => (
  <Box flexDirection="column">
    {message.content.map((block: any, i: number) => {
      if (block.type === "text")
        return (
          <Text key={i} color={message.role === "assistant" ? undefined : "green"}>
            {message.role === "assistant" ? block.text : `› ${block.text}`}
          </Text>
        )
      if (block.type === "tool-call")
        return (
          <Text key={i} color="blue">
            ⚙ {block.name} {preview(block.input)}
          </Text>
        )
      if (block.type === "tool-result")
        return (
          <Text key={i} color={block.isError ? "red" : "gray"}>
            {block.isError ? "✗" : "←"} {preview(block.result?.value)}
          </Text>
        )
      return null
    })}
  </Box>
)

export interface TranscriptProps {
  readonly messages: ReadonlyArray<Message>
  readonly draft: DraftState
}

export const Transcript = ({ messages, draft }: TranscriptProps) => (
  <Box flexDirection="column">
    {messages.map((message, i) => (
      <MessageRow key={i} message={message} />
    ))}
    {draft.reasoning !== "" ? <Text dimColor>{draft.reasoning}</Text> : null}
    {draft.tools.map((row) => (
      <Text key={row.toolCallId} color={row.isError ? "red" : "blue"}>
        ⚙ {row.name}
        {row.output !== "" ? `\n${row.output}` : ""}
        {row.done ? "" : " …"}
      </Text>
    ))}
    {draft.assistant !== "" ? <Text>{draft.assistant}</Text> : null}
    {draft.errors.map((error, i) => (
      <Text key={i} color="red">
        ⚠ {error}
      </Text>
    ))}
  </Box>
)
