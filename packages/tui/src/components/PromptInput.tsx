import { Box, Text } from "ink"
import { COMMAND_NAMES } from "../commands"
import { theme } from "../theme"

export const COMMAND_COLOR = "magenta"
export const UNKNOWN_COLOR = "red"

// Raw ANSI so each line renders as a SINGLE string (one Ink Text atom) instead
// of many per-character nodes — per-char nodes get laid out separately by Yoga
// and can wrap mid-word in a real terminal. Mirrors Claude Code's approach of
// building one string with the cursor inverted inline.
const INV_ON = "[7m"
const INV_OFF = "[27m"
const FG_RESET = "[39m"
const FG = { command: "[35m", unknown: "[31m" } as const

export interface PromptSegment {
  readonly text: string
  readonly kind: "command" | "unknown" | "text"
}

const matchesAnyPrefix = (name: string): boolean =>
  COMMAND_NAMES.some((command) => command === name || command.startsWith(name))

/**
 * Splits a controlled prompt value into colored ranges. Only a leading `/`
 * marks a command token (through the first whitespace); it is `command`-colored
 * while it still prefixes some command name, and `unknown`-colored once it no
 * longer matches any. The remainder is plain text.
 */
export const promptSegments = (value: string): ReadonlyArray<PromptSegment> => {
  if (!value.startsWith("/")) return value === "" ? [] : [{ text: value, kind: "text" }]
  const wsIndex = value.search(/\s/)
  const tokenEnd = wsIndex === -1 ? value.length : wsIndex
  const token = value.slice(0, tokenEnd)
  const rest = value.slice(tokenEnd)
  const kind: PromptSegment["kind"] = matchesAnyPrefix(token.slice(1)) ? "command" : "unknown"
  const segments: Array<PromptSegment> = [{ text: token, kind }]
  if (rest !== "") segments.push({ text: rest, kind: "text" })
  return segments
}

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && !/\s/.test(ch)

/** Index of the previous word boundary from `cursor` (Option+Left). */
export const prevWord = (value: string, cursor: number): number => {
  let i = Math.min(cursor, value.length)
  while (i > 0 && !isWordChar(value[i - 1])) i -= 1
  while (i > 0 && isWordChar(value[i - 1])) i -= 1
  return i
}

/** Index of the next word boundary from `cursor` (Option+Right). */
export const nextWord = (value: string, cursor: number): number => {
  let i = Math.max(0, cursor)
  while (i < value.length && !isWordChar(value[i])) i += 1
  while (i < value.length && isWordChar(value[i])) i += 1
  return i
}

const commandTokenEnd = (line: string): number => {
  const ws = line.search(/\s/)
  return ws === -1 ? line.length : ws
}

/** Builds one line's display string with the cursor inverted inline. */
const renderLine = (
  line: string,
  cursorCol: number | undefined,
  tokenEnd: number,
  tokenAnsi: string | undefined,
): string => {
  let out = ""
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? ""
    const colored = tokenAnsi !== undefined && i < tokenEnd ? `${tokenAnsi}${ch}${FG_RESET}` : ch
    out += i === cursorCol ? `${INV_ON}${colored}${INV_OFF}` : colored
  }
  // Cursor sitting just past the end of the line renders as an inverted space.
  if (cursorCol === line.length) out += `${INV_ON} ${INV_OFF}`
  return out
}

export interface PromptInputProps {
  readonly value: string
  readonly cursor: number
}

export const PromptInput = ({ value, cursor }: PromptInputProps) => {
  if (value === "") {
    return (
      <Box>
        <Text color="green">{"› "}</Text>
        <Text>{`${INV_ON} ${INV_OFF}`}</Text>
        <Text color={theme.muted}> type a prompt, or / for commands</Text>
      </Box>
    )
  }

  const lines = value.split("\n")
  const singleCommand = lines.length === 1 && value.startsWith("/")
  const tokenEnd = singleCommand ? commandTokenEnd(value) : 0
  const tokenAnsi = singleCommand
    ? matchesAnyPrefix(value.slice(1, tokenEnd))
      ? FG.command
      : FG.unknown
    : undefined

  // Map the flat cursor index to (line, column).
  let remaining = Math.max(0, Math.min(cursor, value.length))
  let cursorLine = 0
  let cursorCol = 0
  for (let li = 0; li < lines.length; li += 1) {
    const len = lines[li]?.length ?? 0
    if (remaining <= len) {
      cursorLine = li
      cursorCol = remaining
      break
    }
    remaining -= len + 1
  }

  // Join all lines into ONE Text so embedded blank lines keep their height —
  // a Box column of per-line Text nodes collapses empty lines to zero rows.
  const body = lines
    .map((line, li) =>
      renderLine(
        line,
        li === cursorLine ? cursorCol : undefined,
        li === 0 ? tokenEnd : 0,
        li === 0 ? tokenAnsi : undefined,
      ),
    )
    .join("\n")

  return (
    <Box flexDirection="row">
      <Text color="green">{"› "}</Text>
      <Text>{body}</Text>
    </Box>
  )
}
