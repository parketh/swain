import type { AgentEvent } from "@swain/core"
import type { Message } from "@swain/llms"
import { Box, type DOMElement, Text } from "ink"
import type { ReactNode } from "react"
import { theme } from "../theme"
import { DiffView } from "./Diff"
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
  readonly notices?: ReadonlyArray<string>
}

export const emptyDraft: DraftState = {
  assistant: "",
  reasoning: "",
  tools: [],
  errors: [],
  notices: [],
}

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
    // `step-end` fires after the step's assistant message is pushed to
    // `session.messages`, so the streamed copy is redundant from here on. This
    // also covers the final step of internally-started turns (e.g. notification
    // drains), which never pass through the prompt submit path and would
    // otherwise leave the last message duplicated. Tool rows stay: they carry
    // live execution output until their results are persisted.
    case "step-end":
      return { ...state, assistant: "", reasoning: "" }
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
    // A non-fatal notice (e.g. compacting a Kimi K3 session); surfaced on its
    // own channel so it reads as a warning, not a red error.
    case "compaction-warning":
      return { ...state, notices: [...(state.notices ?? []), event.message] }
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
  backgroundColor,
  children,
}: {
  marker: string
  color?: string
  backgroundColor?: string
  children: ReactNode
}) => (
  <Box flexDirection="row" backgroundColor={backgroundColor}>
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
  /** Unified diff to render inline (Edit tools): pending approval, or applied. */
  readonly diff?: string
}
interface ErrorItem {
  readonly kind: "error"
  readonly text: string
}
interface NoticeItem {
  readonly kind: "notice"
  readonly text: string
}
interface SwitchItem {
  readonly kind: "switch"
  readonly from: string
  readonly to: string
  readonly reason: string
  readonly requestedBy: "router" | "user"
}
interface CompactionItem {
  readonly kind: "compaction"
  readonly compactedMessages: number
}
type Item = TextItem | ToolItem | ErrorItem | NoticeItem | SwitchItem | CompactionItem

const switchRefKey = (ref: { provider: string; modelId: string; variant?: string }): string =>
  ref.variant !== undefined && ref.variant !== ""
    ? `${ref.provider}:${ref.modelId}:${ref.variant}`
    : `${ref.provider}:${ref.modelId}`

// Subagent completions are injected as model-visible `<task-notification>` user
// messages, but they are internal control-plane input rather than conversation
// history. Their typed `isMeta` marker lets the transcript omit them without
// hiding a genuine user prompt that happens to contain the same tag.
//
// NOTE: an `isMeta` user message is not automatically a notification. Model-switch
// and compaction boundaries are also carried on `isMeta` messages but as non-text
// blocks that we DO render (see the block loop in buildItems). Only the `text`
// block of an `isMeta` message is the notification payload — so this predicate is
// applied per-text-block, never to skip the whole message. Any future meta message
// type must keep that distinction: gate text on this, render its own block kind.
const isNotification = (message: { readonly role: string; readonly isMeta?: boolean }): boolean =>
  message.role === "user" && message.isMeta === true
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

/** The unified-diff text an Edit result carries, if any (for inline rendering). */
const editDiff = (name: string | undefined, value: unknown): string | undefined => {
  if (name !== "Edit" || typeof value !== "object" || value === null) return undefined
  const diffs = (value as { diffs?: unknown }).diffs
  const first = Array.isArray(diffs) ? diffs[0] : undefined
  const text = (first as { text?: unknown } | undefined)?.text
  return typeof text === "string" ? text : undefined
}

/**
 * Linearize persisted messages + the live draft into display items in order.
 * `pendingDiff` is the diff of the Edit currently awaiting approval; it is
 * attached to that tool's still-running draft row so the change shows inline.
 */
export const buildItems = (
  messages: ReadonlyArray<Message>,
  draft: DraftState,
  pendingDiff?: string,
): ReadonlyArray<Item> => {
  const items: Array<Item> = []
  // biome-ignore lint/suspicious/noExplicitAny: opaque persisted content blocks
  const list = messages as ReadonlyArray<any>
  const results = resultsById(list)
  // A tool call can exist in both sources at once: its `tool-call` block is
  // persisted before execution while its draft row streams live output. Render
  // exactly one — the draft row until the result is persisted, then the
  // persisted row (whose result value is authoritative).
  const draftIds = new Set(draft.tools.map((row) => row.toolCallId))
  for (const message of list) {
    for (const block of message.content ?? []) {
      if (block.type === "text") {
        // Drop only the notification's text payload, not the whole message —
        // its sibling meta blocks (model-switch, compaction) still render below.
        if (isNotification(message)) continue
        items.push({ kind: "text", role: message.role, text: block.text })
      } else if (block.type === "model-switch") {
        items.push({
          kind: "switch",
          from: switchRefKey(block.from),
          to: switchRefKey(block.to),
          reason: block.reason,
          requestedBy: block.requestedBy,
        })
      } else if (block.type === "compaction") {
        items.push({ kind: "compaction", compactedMessages: block.compactedMessages })
      } else if (block.type === "tool-call" && !isHiddenTool(block.name)) {
        const result = results.get(String(block.toolCallId))
        if (result === undefined && draftIds.has(String(block.toolCallId))) continue
        const diff = result !== undefined ? editDiff(block.name, result.value) : undefined
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
          ...(diff !== undefined && { diff }),
        })
      }
      // reasoning is intentionally hidden; tool-result blocks are consumed above.
    }
  }
  for (const row of draft.tools) {
    if (isHiddenTool(row.name) || results.has(row.toolCallId)) continue
    // A still-running Edit is the one suspended on the approval prompt; show its
    // pending diff inline so the change is visible while the user decides.
    // Permission suspends the turn on the first check, so at most one Edit is
    // ever pending — no need to disambiguate multiple not-done Edit rows here.
    const diff = !row.done && row.name === "Edit" ? pendingDiff : undefined
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
      ...(diff !== undefined && { diff }),
    })
  }
  if (draft.assistant !== "") items.push({ kind: "text", role: "assistant", text: draft.assistant })
  for (const error of draft.errors) items.push({ kind: "error", text: error })
  for (const notice of draft.notices ?? []) items.push({ kind: "notice", text: notice })
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

const ToolResultRow = ({ item, width }: { item: ToolItem; width?: number }) => (
  <>
    <ToolCall name={item.name} input={item.input} />
    <ResultLine isError={item.isError} text={item.summary} />
    {item.diff !== undefined ? (
      <Box marginLeft={2} marginTop={1}>
        <DiffView diff={item.diff} width={(width ?? 80) - 2} />
      </Box>
    ) : null}
  </>
)

const NodeRow = ({ node, width }: { node: Node; width?: number }) => {
  if (node.kind === "text") {
    return node.role === "assistant" ? (
      <Row marker="⏺">
        <Markdown>{node.text}</Markdown>
      </Row>
    ) : (
      <Row marker=">" color={theme.primary} backgroundColor={theme.promptBg}>
        <Text>{node.text}</Text>
      </Row>
    )
  }
  if (node.kind === "error") return <Text color="red">⚠ {node.text}</Text>
  if (node.kind === "notice") return <Text color="yellow">⚠ {node.text}</Text>
  if (node.kind === "switch") {
    const verb = node.requestedBy === "user" ? "Switched" : "Routed"
    return (
      <Row marker="⇄" color={theme.primaryDim}>
        <Text color={theme.muted}>
          {verb} {node.from} → {node.to} — {node.reason}
        </Text>
      </Row>
    )
  }
  if (node.kind === "compaction") {
    return (
      <Row marker="≡" color={theme.primaryDim}>
        <Text color={theme.muted}>
          Compacted {node.compactedMessages} earlier message
          {node.compactedMessages === 1 ? "" : "s"} into a summary
        </Text>
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
  return <ToolResultRow item={node} width={width} />
}

export interface TranscriptProps {
  readonly messages: ReadonlyArray<Message>
  readonly draft: DraftState
  /** Terminal columns, so inline diffs can truncate to fit. */
  readonly width?: number
  /** Diff of the Edit currently awaiting approval, rendered inline on its row. */
  readonly pendingDiff?: string
  /**
   * Registers the wrapper element and text of each rendered user prompt so the
   * scrollback tracker can pin the current turn's prompt at the viewport top.
   * The wrapper's `getComputedTop()` is content-relative (single-column parent),
   * matching the scroll offset. Called with `null` on unmount to deregister.
   */
  readonly registerPrompt?: (index: number, el: DOMElement | null, text: string) => void
}

export const Transcript = ({
  messages,
  draft,
  width,
  pendingDiff,
  registerPrompt,
}: TranscriptProps) => {
  const nodes = collapseItems(buildItems(messages, draft, pendingDiff))
  return (
    <Box flexDirection="column">
      {nodes.map((node, i) => (
        <Box
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only transcript
          key={i}
          flexDirection="column"
          marginTop={i > 0 ? 1 : 0}
          ref={
            registerPrompt !== undefined && node.kind === "text" && node.role === "user"
              ? (el) => registerPrompt(i, el, node.text)
              : undefined
          }
        >
          <NodeRow node={node} width={width} />
        </Box>
      ))}
    </Box>
  )
}
