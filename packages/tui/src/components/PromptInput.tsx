import { Box, Text } from "ink"
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

export interface PromptInputProps {
  readonly value: string
}

const colorFor = (kind: PromptSegment["kind"]): string | undefined =>
  kind === "command" ? COMMAND_COLOR : kind === "unknown" ? UNKNOWN_COLOR : undefined

export const PromptInput = ({ value }: PromptInputProps) => {
  const segments = promptSegments(value)
  return (
    <Box>
      <Text color="green">{"› "}</Text>
      {segments.length === 0 ? (
        <Text dimColor>type a prompt, or / for commands</Text>
      ) : (
        segments.map((segment, i) => (
          <Text key={`${i}-${segment.text}`} color={colorFor(segment.kind)}>
            {segment.text}
          </Text>
        ))
      )}
    </Box>
  )
}
