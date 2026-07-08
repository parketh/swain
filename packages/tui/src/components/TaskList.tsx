import type { Task, TaskStatus } from "@swain/core"
import { Box, Text } from "ink"
import { theme } from "../theme"

export interface TaskListProps {
  readonly tasks: ReadonlyArray<Task>
  /** Maximum task rows to show; the rest are summarized in the header count. */
  readonly limit?: number
}

const STATUS_MARK: Record<TaskStatus, string> = {
  completed: "✓",
  in_progress: "◐",
  failed: "✗",
  pending: "○",
}

const STATUS_COLOR: Record<TaskStatus, string> = {
  completed: theme.muted,
  in_progress: "cyan",
  failed: "red",
  pending: "yellow",
}

const isBlocked = (task: Task, byId: ReadonlyMap<string, Task>): boolean =>
  task.status === "pending" && task.blockedBy.some((id) => byId.get(id)?.status !== "completed")

// In-progress first, then unblocked pending, then blocked pending, then recently
// finished — the order the user most wants to see at a glance.
const priority = (task: Task, byId: ReadonlyMap<string, Task>): number => {
  if (task.status === "in_progress") return 0
  if (task.status === "pending") return isBlocked(task, byId) ? 2 : 1
  return 3
}

export const TaskList = ({ tasks, limit = 6 }: TaskListProps) => {
  if (tasks.length === 0) return null
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const counts = {
    completed: tasks.filter((t) => t.status === "completed").length,
    in_progress: tasks.filter((t) => t.status === "in_progress").length,
    pending: tasks.filter((t) => t.status === "pending").length,
    failed: tasks.filter((t) => t.status === "failed").length,
  }
  const ordered = [...tasks].sort((a, b) => priority(a, byId) - priority(b, byId))
  const shown = ordered.slice(0, limit)
  const hidden = ordered.length - shown.length

  const header =
    `Tasks: ${counts.in_progress} running · ${counts.pending} pending · ${counts.completed} done` +
    (counts.failed > 0 ? ` · ${counts.failed} failed` : "")

  return (
    <Box flexDirection="column">
      <Text color={theme.muted}>{header}</Text>
      {shown.map((task) => {
        const blocked = isBlocked(task, byId)
        const owner =
          task.agentType !== undefined ? ` [${task.agentType}${blocked ? ", blocked" : ""}]` : ""
        return (
          <Text key={task.id} color={STATUS_COLOR[task.status]}>
            {`${STATUS_MARK[task.status]} ${task.subject}`}
            <Text color={theme.muted}>{owner}</Text>
          </Text>
        )
      })}
      {hidden > 0 ? <Text color={theme.muted}>{`… ${hidden} more`}</Text> : null}
    </Box>
  )
}
