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
    // Each iteration's assistant text and tool rows are persisted to
    // `session.messages` before the next one starts, so clear the transient
    // draft at the boundary — otherwise it accumulates every iteration's text
    // into one run-on blob duplicating the messages above. Errors are kept:
    // they are not persisted and should stay visible for the whole turn.
    case "step-start":
      return { ...state, assistant: "", reasoning: "", tools: [] }
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

// --- Transcript model -----------------------------------------------------
// Flatten messages + live draft into one linear item list, then collapse runs
// of consecutive read/search tool calls into a single summary line — the way
// Claude Code shows a burst of Reads/Greps as "Read 3 files" instead of six
// separate rows.

const SEARCH_TOOLS: ReadonlySet<string> = new Set(["Grep", "Glob"])
const READ_TOOLS: ReadonlySet<string> = new Set(["Read"])
const isCollapsibleTool = (name: string): boolean => SEARCH_TOOLS.has(name) || READ_TOOLS.has(name)

/** Tense-aware roll-up for a run of read/search tools, e.g. "Searched for 2 patterns, read 3 files". */
export const groupSummary = (reads: number, searches: number, active: boolean): string => {
  const parts: Array<string> = []
  if (searches > 0) {
    const verb = active
      ? parts.length === 0
        ? "Searching for"
        : "searching for"
      : parts.length === 0
        ? "Searched for"
        : "searched for"
    parts.push(`${verb} ${searches} ${searches === 1 ? "pattern" : "patterns"}`)
  }
  if (reads > 0) {
    const verb = active
      ? parts.length === 0
        ? "Reading"
        : "reading"
      : parts.length === 0
        ? "Read"
        : "read"
    parts.push(`${verb} ${reads} ${reads === 1 ? "file" : "files"}`)
  }
  const text = parts.join(", ")
  return active ? `${text}…` : text
}

interface TextItem {
  readonly kind: "text"
  readonly role: "user" | "assistant"
  readonly text: string
}
interface ToolItem {
  readonly kind: "tool"
  readonly name: string
  readonly input: unknown
  readonly summary: string
  readonly isError: boolean
  readonly done: boolean
}
interface ErrorItem {
  readonly kind: "error"
  readonly text: string
}
interface NotificationItem {
  readonly kind: "notification"
  readonly text: string
}
type Item = TextItem | ToolItem | ErrorItem | NotificationItem

// Subagent completions are injected as `<task-notification>` user messages so
// the model sees them, but they are not something the user typed — strip the
// wrapper and render them as a system notification, not a user prompt.
const NOTIFICATION_OPEN = "<task-notification>"
const isNotification = (role: string, text: string): boolean =>
  role === "user" && text.trimStart().startsWith(NOTIFICATION_OPEN)
const stripNotification = (text: string): string =>
  text
    .replace(/^\s*<task-notification>\n?/, "")
    .replace(/\n?<\/task-notification>\s*$/, "")
    .trim()
interface GroupNode {
  readonly kind: "group"
  readonly reads: number
  readonly searches: number
  readonly active: boolean
}
type Node = Item | GroupNode

// biome-ignore lint/suspicious/noExplicitAny: opaque persisted content blocks
const resultsById = (
  messages: ReadonlyArray<any>,
): Map<string, { value: unknown; isError: boolean }> => {
  const map = new Map<string, { value: unknown; isError: boolean }>()
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block.type === "tool-result") {
        map.set(String(block.toolCallId), {
          value: block.result?.value,
          isError: block.isError === true,
        })
      }
    }
  }
  return map
}

/** Linearize persisted messages + the live draft into display items in order. */
export const buildItems = (
  messages: ReadonlyArray<Message>,
  draft: DraftState,
): ReadonlyArray<Item> => {
  const items: Array<Item> = []
  // biome-ignore lint/suspicious/noExplicitAny: opaque persisted content blocks
  const list = messages as ReadonlyArray<any>
  const results = resultsById(list)
  for (const message of list) {
    for (const block of message.content ?? []) {
      if (block.type === "text") {
        items.push(
          isNotification(message.role, block.text)
            ? { kind: "notification", text: stripNotification(block.text) }
            : { kind: "text", role: message.role, text: block.text },
        )
      } else if (block.type === "tool-call" && !isHiddenTool(block.name)) {
        const result = results.get(String(block.toolCallId))
        items.push({
          kind: "tool",
          name: block.name,
          input: block.input,
          summary:
            result !== undefined
              ? summarizeResult(block.name ?? "", result.value, result.isError)
              : "…",
          isError: result?.isError === true,
          done: result !== undefined,
        })
      }
      // reasoning is intentionally hidden; tool-result blocks are consumed above.
    }
  }
  for (const row of draft.tools) {
    if (isHiddenTool(row.name)) continue
    items.push({
      kind: "tool",
      name: row.name,
      input: row.input,
      summary: row.done
        ? summarizeResult(row.name, row.output, row.isError)
        : row.output !== ""
          ? `${summarizeResult(row.name, row.output, false)} …`
          : "…",
      isError: row.isError,
      done: row.done,
    })
  }
  if (draft.assistant !== "") items.push({ kind: "text", role: "assistant", text: draft.assistant })
  for (const error of draft.errors) items.push({ kind: "error", text: error })
  return items
}

/** Collapse runs of 2+ consecutive read/search tools into one summary node. */
export const collapseItems = (items: ReadonlyArray<Item>): ReadonlyArray<Node> => {
  const nodes: Array<Node> = []
  let run: Array<ToolItem> = []
  const flush = (): void => {
    if (run.length === 0) return
    if (run.length === 1) {
      nodes.push(run[0]!)
    } else {
      nodes.push({
        kind: "group",
        reads: run.filter((t) => READ_TOOLS.has(t.name)).length,
        searches: run.filter((t) => SEARCH_TOOLS.has(t.name)).length,
        active: run.some((t) => !t.done),
      })
    }
    run = []
  }
  for (const item of items) {
    if (item.kind === "tool" && isCollapsibleTool(item.name)) {
      run.push(item)
    } else {
      flush()
      nodes.push(item)
    }
  }
  flush()
  return nodes
}

const ToolResultRow = ({ item }: { item: ToolItem }) => (
  <>
    <ToolCall name={item.name} input={item.input} />
    <ResultLine isError={item.isError} text={item.summary} />
  </>
)

const NodeRow = ({ node }: { node: Node }) => {
  if (node.kind === "text") {
    return node.role === "assistant" ? (
      <Row marker="⏺">
        <Markdown>{node.text}</Markdown>
      </Row>
    ) : (
      <Row marker=">" color={theme.primary}>
        <Text>{node.text}</Text>
      </Row>
    )
  }
  if (node.kind === "error") return <Text color="red">⚠ {node.text}</Text>
  if (node.kind === "notification") {
    return (
      <Row marker="⚑" color={theme.primaryDim}>
        <Box flexDirection="column">
          <Text color={theme.muted}>Subagent update</Text>
          <Markdown>{node.text}</Markdown>
        </Box>
      </Row>
    )
  }
  if (node.kind === "group") {
    return (
      <Row marker="⏺" color={theme.primaryDim}>
        <Text color={theme.muted}>{groupSummary(node.reads, node.searches, node.active)}</Text>
      </Row>
    )
  }
  return <ToolResultRow item={node} />
}

export interface TranscriptProps {
  readonly messages: ReadonlyArray<Message>
  readonly draft: DraftState
}

export const Transcript = ({ messages, draft }: TranscriptProps) => {
  const nodes = collapseItems(buildItems(messages, draft))
  return (
    <Box flexDirection="column">
      {nodes.map((node, i) => (
        <Box
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only transcript
          key={i}
          flexDirection="column"
          marginTop={i > 0 ? 1 : 0}
        >
          <NodeRow node={node} />
        </Box>
      ))}
    </Box>
  )
}
