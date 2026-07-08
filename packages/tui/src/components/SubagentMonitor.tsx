import { Box, Text } from "ink"
import type { SubagentStatus } from "../controller"
import { theme } from "../theme"
import { formatToolUse } from "./toolFormat"

export interface SubagentMonitorProps {
  readonly agents: ReadonlyArray<SubagentStatus>
  /** Epoch ms used to compute elapsed time; the App ticks it once per second. */
  readonly now: number
}

const elapsed = (startedAt: number, now: number): string => {
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`
}

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** Current action: the last tool the child invoked and its target, if any. */
const action = (agent: SubagentStatus): string => {
  if (agent.lastTool === undefined) return "starting…"
  const args = formatToolUse(agent.lastTool, agent.lastToolInput)
  return truncate(args !== "" ? `${agent.lastTool} ${args}` : agent.lastTool, 48)
}

/** Live monitor for running subagents, separate from the parent's task list. */
export const SubagentMonitor = ({ agents, now }: SubagentMonitorProps) => {
  if (agents.length === 0) return null
  return (
    <Box flexDirection="column">
      <Text color={theme.muted}>{`Subagents: ${agents.length} running`}</Text>
      {agents.map((agent) => (
        <Text key={agent.agentId} color="cyan">
          {`◐ ${agent.agentType} `}
          <Text color={theme.muted}>
            {`(${agent.agentId.slice(0, 8)}) · ${elapsed(agent.startedAt, now)} · ` +
              `${agent.toolUseCount} tools · ${action(agent)}`}
          </Text>
        </Text>
      ))}
    </Box>
  )
}
