import { Box, Text } from "ink"
import { COMMANDS } from "../commands"

const KEYS: ReadonlyArray<readonly [string, string]> = [
  ["Enter", "submit prompt / accept command"],
  ["Shift+Enter / \\+Enter", "insert a newline"],
  ["Tab / →", "accept suggestion"],
  ["↑ / ↓", "navigate suggestions"],
  ["⌥←/→", "move by word"],
  ["⌥⌫ / Ctrl+W", "delete previous word"],
  ["Shift-Tab", "cycle permission mode"],
  ["Esc", "clear input / close overlay"],
  ["Ctrl+C", "interrupt turn, or exit when idle"],
]

export const HelpView = () => (
  <Box flexDirection="column">
    <Text bold>Commands</Text>
    {COMMANDS.map((command) => (
      <Text key={command.name}>
        <Text color="magenta">/{command.name}</Text>
        <Text dimColor> — {command.summary}</Text>
      </Text>
    ))}
    <Text bold>Keys</Text>
    {KEYS.map(([key, description]) => (
      <Text key={key}>
        <Text color="cyan">{key}</Text>
        <Text dimColor> — {description}</Text>
      </Text>
    ))}
  </Box>
)
