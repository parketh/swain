import type { PermissionDecision, PermissionRequest } from "@swain/core"
import { Box, Text, useInput } from "ink"
import { useState } from "react"
import { denyDecision, PERMISSION_CHOICES } from "../permissions"

export interface PermissionPromptProps {
  readonly request: PermissionRequest
  readonly onDecision: (decision: PermissionDecision) => void
}

/**
 * Focused approval picker for a suspended tool call. Shows the request context
 * (tool, summary, command/diff when present) and a vertical Yes/No choice list:
 * Up/Down navigate, Enter chooses, Esc denies.
 */
export const PermissionPrompt = ({ request, onDecision }: PermissionPromptProps) => {
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

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Permission required
      </Text>
      <Text>
        <Text dimColor>tool: </Text>
        {request.toolName}
      </Text>
      <Text>{request.summary}</Text>
      {request.command !== undefined ? <Text color="gray">$ {request.command}</Text> : null}
      {request.diff !== undefined ? <Text color="gray">{request.diff}</Text> : null}
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
