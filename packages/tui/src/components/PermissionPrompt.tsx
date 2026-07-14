import type { PermissionDecision, PermissionRequest } from "@swain/core"
import { Box, Text, useInput } from "ink"
import { useState } from "react"
import { denyDecision, PERMISSION_CHOICES } from "../permissions"
import { theme } from "../theme"
import { DiffView } from "./Diff"

export interface PermissionPromptProps {
  readonly request: PermissionRequest
  readonly onDecision: (decision: PermissionDecision) => void
  /** Terminal rows/columns, used to bound the diff so the prompt always fits. */
  readonly maxRows?: number
  readonly width?: number
}

// Rows consumed by everything but the diff: the prompt's own chrome (border,
// header, tool, summary, choices) plus the pinned prompt/status cluster the
// overlay floats above. Reserving them keeps the diff from overflowing the
// viewport and clipping the prompt off-screen.
const RESERVED_ROWS = 14

/**
 * Focused approval picker for a suspended tool call. Shows the request context
 * (tool, summary, command, or a bounded syntax-highlighted diff) and a vertical
 * Yes/No choice list: Up/Down navigate, Enter chooses, Esc denies.
 */
export const PermissionPrompt = ({
  request,
  onDecision,
  maxRows,
  width,
}: PermissionPromptProps) => {
  const [index, setIndex] = useState(0)

  useInput((_input, key) => {
    if (key.escape) return onDecision(denyDecision)
    if (key.upArrow) return setIndex((i) => Math.max(0, i - 1))
    if (key.downArrow) return setIndex((i) => Math.min(PERMISSION_CHOICES.length - 1, i + 1))
    if (key.return) {
      const choice = PERMISSION_CHOICES[index]
      if (choice !== undefined) onDecision(choice.decision)
    }
  })

  const diffLines = Math.max(3, (maxRows ?? 24) - RESERVED_ROWS)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Permission required
      </Text>
      <Text>
        <Text color={theme.muted}>tool: </Text>
        {request.toolName}
      </Text>
      <Text>{request.summary}</Text>
      {request.command !== undefined ? <Text color="gray">$ {request.command}</Text> : null}
      {request.diff !== undefined ? (
        <Box marginTop={1}>
          <DiffView diff={request.diff} width={(width ?? 80) - 4} maxLines={diffLines} />
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {PERMISSION_CHOICES.map((choice, i) => (
          <Text key={choice.label} color={i === index ? "cyan" : undefined}>
            {i === index ? "› " : "  "}
            {choice.label}
          </Text>
        ))}
      </Box>
    </Box>
  )
}
