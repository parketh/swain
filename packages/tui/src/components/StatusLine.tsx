import type { PermissionMode } from "@swain/core"
import { Box, Text } from "ink"
import type { ActiveModel } from "../config"
import { theme } from "../theme"
import type { UsageSnapshot } from "../usage"

export interface StatusLineProps {
  readonly activeModel: ActiveModel
  readonly permissionMode: PermissionMode
  readonly usage: UsageSnapshot
}

const MODE_COLOR: Record<PermissionMode, string> = {
  ask: "yellow",
  auto: "green",
  plan: "cyan",
}

export const StatusLine = ({ activeModel, permissionMode, usage }: StatusLineProps) => (
  <Box>
    <Text color={theme.muted}>{activeModel.provider}/</Text>
    <Text>{activeModel.modelId}</Text>
    {activeModel.variant !== undefined ? (
      <Text color={theme.muted}>:{activeModel.variant}</Text>
    ) : null}
    <Text> · </Text>
    <Text color={MODE_COLOR[permissionMode]}>{permissionMode}</Text>
    <Text color={theme.muted}>
      {" · "}
      {usage.totalTokens} tok ({usage.turns} turns)
    </Text>
  </Box>
)
