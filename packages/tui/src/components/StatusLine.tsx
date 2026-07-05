import type { PermissionMode } from "@swain/core"
import { Box, Text } from "ink"
import type { ActiveModel } from "../config"
import type { UsageSnapshot } from "../usage"

export interface StatusLineProps {
  readonly activeModel: ActiveModel
  readonly permissionMode: PermissionMode
  readonly sessionId: string
  readonly usage: UsageSnapshot
  readonly running: boolean
}

const MODE_COLOR: Record<PermissionMode, string> = {
  ask: "yellow",
  auto: "green",
  plan: "cyan",
}

export const StatusLine = ({
  activeModel,
  permissionMode,
  sessionId,
  usage,
  running,
}: StatusLineProps) => (
  <Box>
    <Text dimColor>{activeModel.provider}/</Text>
    <Text>{activeModel.modelId}</Text>
    {activeModel.variant !== undefined ? <Text dimColor>:{activeModel.variant}</Text> : null}
    <Text> · </Text>
    <Text color={MODE_COLOR[permissionMode]}>{permissionMode}</Text>
    <Text dimColor> · {sessionId.slice(0, 8)}</Text>
    <Text dimColor>
      {" · "}
      {usage.totalTokens} tok ({usage.turns} turns)
    </Text>
    {running ? <Text color="yellow"> · running…</Text> : null}
  </Box>
)
