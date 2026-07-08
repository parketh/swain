import type { AgentEvent } from "@swain/core"
import type { Message } from "@swain/llms"
import { Box, Text } from "ink"
import type { ReactNode } from "react"
import { theme } from "../theme"
import { Markdown } from "./markdown"
import { formatToolUse, summarizeResult } from "./toolFormat"

export interface ToolRow {
  readonly toolCallId: string
  readonly name: string
  readonly input: unknown
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
// Task tool calls are reflected in the dedicated task panel, so they are kept
// out of the transcript to avoid duplicating that state as tool-call noise.
const HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "TaskCreate",
  "TaskList",
  "TaskGet",
  "TaskUpdate",
])

export const isHiddenTool = (name: string | undefined): boolean =>
  name !== undefined && HIDDEN_TOOLS.has(name)

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
      if (isHiddenTool(event.name)) return state
      return {
        ...state,
        tools: [
          ...state.tools,
          {
            toolCallId: String(event.toolCallId),
            name: event.name,
            input: event.input,
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

// A left gutter marker (`⏺` for a turn, blank for continuations) followed by
// the block content, matching Claude Code's transcript layout.
const Row = ({
  marker,
  color,
  children,
}: {
  marker: string
  color?: string
  children: ReactNode
}) => (
  <Box flexDirection="row">
    <Box minWidth={2} flexShrink={0}>
      <Text color={color}>{marker}</Text>
    </Box>
    <Box flexDirection="column" flexGrow={1}>
      {children}
    </Box>
  </Box>
)

// The `⎿` connector under a tool call, carrying its result summary.
const ResultLine = ({ text, isError }: { text: string; isError: boolean }) => (
  <Box flexDirection="row">
    <Text color={theme.faint}>{"  ⎿ "}</Text>
    <Text color={isError ? "red" : theme.muted}>{text}</Text>
  </Box>
)

const ToolCall = ({ name, input }: { name: string; input: unknown }) => {
  const args = formatToolUse(name, input)
  return (
    <Row marker="⏺" color={theme.primaryDim}>
      <Text>
        <Text bold>{name}</Text>
        {args !== "" ? <Text color={theme.muted}>({args})</Text> : null}
      </Text>
    </Row>
  )
}

// A message carrying only tool results belongs to the preceding assistant's
// tool calls, so it hugs them instead of opening a new spaced block.
// biome-ignore lint/suspicious/noExplicitAny: opaque message content blocks
const isToolResultOnly = (message: any): boolean =>
  message.content.length > 0 &&
  // biome-ignore lint/suspicious/noExplicitAny: opaque content block
  message.content.every((block: any) => block.type === "tool-result")

// biome-ignore lint/suspicious/noExplicitAny: opaque message content blocks
const MessageRow = ({ message }: { message: any }) => (
  <Box flexDirection="column" gap={1}>
    {/* biome-ignore lint/suspicious/noExplicitAny: opaque content block */}
    {message.content.map((block: any, i: number) => {
      const key = i
      if (block.type === "text") {
        if (message.role === "assistant")
          return (
            <Row key={key} marker="⏺">
              <Markdown>{block.text}</Markdown>
            </Row>
          )
        return (
          <Row key={key} marker=">" color={theme.primary}>
            <Text>{block.text}</Text>
          </Row>
        )
      }
      // Reasoning is intentionally hidden; the live spinner stands in for it.
      if (block.type === "reasoning") return null
      if (block.type === "tool-call") {
        if (isHiddenTool(block.name)) return null
        return <ToolCall key={key} name={block.name} input={block.input} />
      }
      if (block.type === "tool-result") {
        if (isHiddenTool(block.name)) return null
        return (
          <ResultLine
            key={key}
            isError={block.isError === true}
            text={summarizeResult(block.name ?? "", block.result?.value, block.isError === true)}
          />
        )
      }
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
      <Box
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only history
        key={i}
        flexDirection="column"
        marginTop={i > 0 && !isToolResultOnly(message) ? 1 : 0}
      >
        <MessageRow message={message} />
      </Box>
    ))}
    {draft.tools.map((row) => (
      <Box key={row.toolCallId} flexDirection="column" marginTop={1}>
        <ToolCall name={row.name} input={row.input} />
        {row.output !== "" || row.done ? (
          <ResultLine
            isError={row.isError}
            text={
              row.done
                ? summarizeResult(row.name, row.output, row.isError)
                : `${summarizeResult(row.name, row.output, false)} …`
            }
          />
        ) : (
          <ResultLine isError={false} text="…" />
        )}
      </Box>
    ))}
    {draft.assistant !== "" ? (
      <Box marginTop={1}>
        <Row marker="⏺">
          <Markdown>{draft.assistant}</Markdown>
        </Row>
      </Box>
    ) : null}
    {draft.errors.map((error, i) => (
      <Box
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only errors
        key={i}
        marginTop={1}
      >
        <Text color="red">⚠ {error}</Text>
      </Box>
    ))}
  </Box>
)
