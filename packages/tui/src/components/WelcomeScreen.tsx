import type { PermissionMode } from "@swain/core"
import { Box, Text } from "ink"
import type { ActiveModel } from "../config"

const ACCENT = "#7dd3ff"

// "SWAIN" in the ANSI Shadow figlet font; each row is colored on a cyan→blue
// vertical gradient for a bit of depth.
const BANNER: ReadonlyArray<readonly [string, string]> = [
  ["███████╗██╗    ██╗ █████╗ ██╗███╗   ██╗", "#5ff7f0"],
  ["██╔════╝██║    ██║██╔══██╗██║████╗  ██║", "#4fddf3"],
  ["███████╗██║ █╗ ██║███████║██║██╔██╗ ██║", "#45c0f2"],
  ["╚════██║██║███╗██║██╔══██║██║██║╚██╗██║", "#3ba0f2"],
  ["███████║╚███╔███╔╝██║  ██║██║██║ ╚████║", "#4f80f2"],
  ["╚══════╝ ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝", "#5f6ff2"],
]

const TIPS: ReadonlyArray<readonly [string, string]> = [
  ["/help", "list commands and keyboard shortcuts"],
  ["/", "browse slash commands"],
  ["@", "reference a file in your prompt"],
]

const home = (path: string): string => {
  const h = process.env.HOME
  return h !== undefined && path.startsWith(h) ? `~${path.slice(h.length)}` : path
}

const modelLabel = (model: ActiveModel): string =>
  model.provider === "none"
    ? "no provider configured — run /connect"
    : `${model.provider}/${model.modelId}${model.variant !== undefined ? `:${model.variant}` : ""}`

export interface WelcomeScreenProps {
  readonly cwd: string
  readonly activeModel: ActiveModel
  readonly permissionMode: PermissionMode
}

export const WelcomeScreen = ({ cwd, activeModel, permissionMode }: WelcomeScreenProps) => (
  <Box flexDirection="column" alignItems="center" paddingX={1} paddingY={1}>
    <Box flexDirection="column">
      {BANNER.map(([line, color], i) => (
        <Text key={i} color={color} bold>
          {line}
        </Text>
      ))}
    </Box>
    <Box marginTop={1}>
      <Text>
        <Text color={ACCENT} bold>
          s
        </Text>
        <Text>oft</Text>
        <Text color={ACCENT} bold>
          w
        </Text>
        <Text>are </Text>
        <Text color={ACCENT} bold>
          ai
        </Text>
        <Text> e</Text>
        <Text color={ACCENT} bold>
          n
        </Text>
        <Text>gineer</Text>
      </Text>
    </Box>
    <Box
      flexDirection="column"
      marginTop={1}
      paddingX={2}
      paddingY={1}
      borderStyle="round"
      borderColor="#3ba0f2"
    >
      <Text>
        <Text color="cyan">{"model".padEnd(6)}</Text>
        {modelLabel(activeModel)}
      </Text>
      <Text>
        <Text color="cyan">{"mode".padEnd(6)}</Text>
        {permissionMode}
      </Text>
      <Text>
        <Text color="cyan">{"cwd".padEnd(6)}</Text>
        <Text dimColor>{home(cwd)}</Text>
      </Text>
    </Box>
    <Box flexDirection="column" marginTop={1}>
      {TIPS.map(([key, description]) => (
        <Text key={key}>
          <Text color="magenta">{key.padEnd(6)}</Text>
          <Text dimColor> {description}</Text>
        </Text>
      ))}
    </Box>
  </Box>
)
