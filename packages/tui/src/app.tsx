import { Box, render, Text } from "ink"
import type React from "react"

export interface AppProps {
  readonly cwd: string
}

/**
 * Root Ink component. Task 1 renders a minimal REPL shell; later tasks replace
 * the body with the transcript, prompt input, status line, and overlays.
 */
export const App: React.FC<AppProps> = ({ cwd }) => (
  <Box flexDirection="column">
    <Text color="cyan">swain</Text>
    <Text dimColor>{cwd}</Text>
  </Box>
)

export interface StartOptions {
  readonly cwd: string
}

/** Mounts the Ink app. Ctrl+C exits cleanly via Ink's default handler. */
export const startApp = (options: StartOptions): void => {
  render(<App cwd={options.cwd} />)
}
