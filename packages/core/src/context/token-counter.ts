import type { Message } from "@swain/llms"
import { renderCompaction, renderModelSwitch } from "@swain/llms"

/**
 * Estimates token pressure for content not already covered by a provider's
 * reported `activeContextTokens` snapshot: pending user input, tool results,
 * meta messages, and local transcript deltas. Intentionally an abstraction so
 * an exact tokenizer or provider count-token API can replace the estimator
 * later without touching compaction policy.
 */
export interface TokenCounter {
  estimateText(text: string): number
  estimateJson(value: unknown): number
  estimateMessage(message: Message): number
  estimateMessages(messages: ReadonlyArray<Message>): number
}

// Small per-message allowance for role framing and structural tokens the block
// estimates do not capture. Deliberately over-counts slightly: under-counting
// context pressure is the dangerous direction.
const MESSAGE_OVERHEAD = 4

/** ~4 characters per token, the working average for both prose and code. */
const estimateText = (text: string): number => Math.ceil(text.length / 4)

/**
 * ~4 characters per token for JSON tool inputs/results too. The earlier ~2
 * heuristic roughly doubled tool-result pressure versus real BPE tokenization,
 * which drove auto-compaction to trigger far too early on read-heavy turns.
 */
const estimateJson = (value: unknown): number => Math.ceil(JSON.stringify(value).length / 4)

const estimateMessage = (message: Message): number => {
  let total = MESSAGE_OVERHEAD
  for (const block of message.content) {
    switch (block.type) {
      case "text":
      case "reasoning":
        total += estimateText(block.text)
        break
      case "tool-call":
        total += estimateText(block.name) + estimateJson(block.input)
        break
      case "tool-result":
        total +=
          block.result.type === "text"
            ? estimateText(block.result.value)
            : estimateJson(block.result.value)
        break
      case "model-switch":
        total += estimateText(renderModelSwitch(block))
        break
      case "compaction":
        total += estimateText(renderCompaction(block))
        break
    }
  }
  return total
}

const estimateMessages = (messages: ReadonlyArray<Message>): number =>
  messages.reduce((sum, message) => sum + estimateMessage(message), 0)

/** The V1 length-based token counter. */
export const defaultTokenCounter: TokenCounter = {
  estimateText,
  estimateJson,
  estimateMessage,
  estimateMessages,
}
