import type { SessionState } from "@swain/core"
import type { ActiveModel } from "./config"
import { costUsd } from "./models"

export interface UsageSnapshot {
  readonly turns: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly costUsd?: number
  readonly provider: string
  readonly modelId: string
  readonly variant?: string
}

/** Projects session counters and the active model into a display snapshot. */
export const usageSnapshot = (session: SessionState, activeModel: ActiveModel): UsageSnapshot => {
  const cost = costUsd(
    activeModel.modelId,
    session.counters.inputTokens,
    session.counters.outputTokens,
  )
  return {
    turns: session.counters.turns,
    inputTokens: session.counters.inputTokens,
    outputTokens: session.counters.outputTokens,
    totalTokens: session.counters.inputTokens + session.counters.outputTokens,
    ...(cost !== undefined && { costUsd: cost }),
    provider: activeModel.provider,
    modelId: activeModel.modelId,
    ...(activeModel.variant !== undefined && { variant: activeModel.variant }),
  }
}
