import { Box, Text } from "ink"
import type { ReactNode } from "react"
import { COMMAND_NAMES } from "../commands"

export const COMMAND_COLOR = "magenta"
export const UNKNOWN_COLOR = "red"

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

const Line = ({
  text,
  cursorCol,
  tokenEnd,
  tokenColor,
}: {
  readonly text: string
  readonly cursorCol: number | undefined
  readonly tokenEnd: number
  readonly tokenColor: string | undefined
}) => {
  const chars: Array<ReactNode> = []
  for (let i = 0; i <= text.length; i += 1) {
    const isCursor = i === cursorCol
    if (i === text.length) {
      if (isCursor)
        chars.push(
          <Text key={i} inverse={true}>
            {" "}
          </Text>,
        )
      break
    }
    const color = tokenColor !== undefined && i < tokenEnd ? tokenColor : undefined
    chars.push(
      <Text key={i} inverse={isCursor} color={color}>
        {text[i]}
      </Text>,
    )
  }
  return <Text>{chars}</Text>
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
        <Text inverse> </Text>
        <Text dimColor> type a prompt, or / for commands</Text>
      </Box>
    )
  }

  const lines = value.split("\n")
  const singleCommand = lines.length === 1 && value.startsWith("/")
  const tokenEnd = singleCommand ? commandTokenEnd(value) : 0
  const tokenColor = singleCommand
    ? matchesAnyPrefix(value.slice(1, tokenEnd))
      ? COMMAND_COLOR
      : UNKNOWN_COLOR
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

  return (
    <Box flexDirection="row">
      <Text color="green">{"› "}</Text>
      <Box flexDirection="column">
        {lines.map((line, li) => (
          <Line
            // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
            key={li}
            text={line}
            cursorCol={li === cursorLine ? cursorCol : undefined}
            tokenEnd={li === 0 ? tokenEnd : 0}
            tokenColor={li === 0 ? tokenColor : undefined}
          />
        ))}
      </Box>
    </Box>
  )
}
