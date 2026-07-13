import type { PermissionMode } from "@swain/core"
import { Box, Text } from "ink"
import type { ActiveModel } from "../config"
import type { RouterStatus } from "../router"
import { theme } from "../theme"
import type { UsageSnapshot } from "../usage"

export interface StatusLineProps {
  readonly activeModel: ActiveModel
  readonly permissionMode: PermissionMode
  readonly usage: UsageSnapshot
  readonly routerStatus: RouterStatus
  /** Auto compaction was disabled after a failure; manual `/compact` still works. */
  readonly autoCompactionDisabled?: boolean
}

const ROUTER_COLOR: Record<RouterStatus, string> = {
  off: "gray",
  "needs-setup": "yellow",
  on: "green",
}

const ROUTER_LABEL: Record<RouterStatus, string> = {
  off: "off",
  "needs-setup": "needs setup",
  on: "on",
}

const MODE_COLOR: Record<PermissionMode, string> = {
  ask: "yellow",
  auto: "green",
  plan: "cyan",
}

export const StatusLine = ({
  activeModel,
  permissionMode,
  usage,
  routerStatus,
  autoCompactionDisabled,
}: StatusLineProps) => (
  <Box>
    <Text color={theme.muted}>{activeModel.provider}/</Text>
    <Text>{activeModel.modelId}</Text>
    {activeModel.variant !== undefined ? (
      <Text color={theme.muted}>:{activeModel.variant}</Text>
    ) : null}
    <Text> · </Text>
    <Text color={MODE_COLOR[permissionMode]}>{permissionMode}</Text>
    <Text color={theme.muted}> · </Text>
    <Text color={ROUTER_COLOR[routerStatus]}>router {ROUTER_LABEL[routerStatus]}</Text>
    <Text color={theme.muted}>
      {" · "}
      {usage.totalTokens} tok
      {usage.costUsd !== undefined ? ` (${formatCost(usage.costUsd)})` : ""}
    </Text>
    {autoCompactionDisabled === true ? <Text color="yellow"> · auto-compact off</Text> : null}
  </Box>
)

// Sub-cent costs need more precision than dollars; scale decimals to magnitude.
const formatCost = (cost: number): string =>
  cost >= 1 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`
