import { Box, Text } from "ink"
import { COMMANDS, type CommandInfo } from "../commands"
import { theme } from "../theme"

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
}

export const CommandOverlay = ({ query, highlight }: CommandOverlayProps) => {
  const matches = filterCommands(query)
  if (matches.length === 0) return null
  return (
    <Box flexDirection="column">
      {matches.map((command, i) => (
        <Text key={command.name} color={i === highlight ? "cyan" : undefined}>
          {i === highlight ? "› " : "  "}
          {`/${command.name}`} <Text color={theme.muted}>— {command.summary}</Text>
        </Text>
      ))}
    </Box>
  )
}
