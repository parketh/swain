import { Box, Text } from "ink"
import { COMMANDS, type CommandInfo } from "../commands"
import { theme } from "../theme"
import { clampCols, fillPad } from "./overlayFill"

/**
 * Filters built-in commands by name prefix (ranked first) then summary
 * substring, so the leading suggestion for `/he` is `/help`.
 */
export const filterCommands = (query: string): ReadonlyArray<CommandInfo> => {
  const needle = query.toLowerCase()
  const byName = COMMANDS.filter((command) => command.name.startsWith(needle))
  const bySummary = COMMANDS.filter(
    (command) => !command.name.startsWith(needle) && command.summary.toLowerCase().includes(needle),
  )
  return [...byName, ...bySummary]
}

export interface CommandOverlayProps {
  readonly query: string
  readonly highlight: number
  /** Fills each row to this width so the floated menu occludes the transcript. */
  readonly width?: number
}

export const CommandOverlay = ({ query, highlight, width }: CommandOverlayProps) => {
  const matches = filterCommands(query)
  if (matches.length === 0) return null
  return (
    <Box flexDirection="column">
      {matches.map((command, i) => {
        const left = `${i === highlight ? "› " : "  "}/${command.name} `
        const summary =
          width === undefined
            ? `— ${command.summary}`
            : clampCols(`— ${command.summary}`, Math.max(0, width - left.length))
        return (
          <Text key={command.name} color={i === highlight ? "cyan" : undefined}>
            {left}
            <Text color={theme.muted}>{summary}</Text>
            {fillPad(left.length + summary.length, width)}
          </Text>
        )
      })}
    </Box>
  )
}
