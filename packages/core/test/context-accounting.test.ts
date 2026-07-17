import { describe, expect, test } from "bun:test"
import type { Message, Model, Usage } from "@swain/llms"
import { ModelId, Message as Msg, ProviderId } from "@swain/llms"
import {
  defaultTokenCounter,
  effectiveContextWindow,
  estimateCurrentContextTokens,
  type RequestShape,
  recordContextUsage,
  shouldAutoCompact,
} from "../src/context"
import { createSessionState, type SessionState } from "../src/state"

const counter = defaultTokenCounter

const modelWithWindow = (contextWindow?: number): Model => ({
  id: ModelId.make("test-model"),
  provider: ProviderId.make("test"),
  ...(contextWindow !== undefined && { limits: { contextWindow, maxOutputTokens: 1_000 } }),
  streamTurn: () => {
    throw new Error("unused")
  },
})

const session = (messages: Array<Message>, contextWindow?: number): SessionState =>
  createSessionState({
    workingDirectory: "/work",
    model: modelWithWindow(contextWindow),
    currentDate: "2026-07-13",
    messages,
  })

const shape: RequestShape = { system: "You are helpful.", tools: [] }

describe("estimateCurrentContextTokens", () => {
  test("estimates the full request locally when there is no provider usage", () => {
    const messages = [Msg.user("hello there"), Msg.assistant("hi")]
    const state = session(messages)
    const expected = counter.estimateText(shape.system!) + counter.estimateMessages(messages)
    expect(estimateCurrentContextTokens(state, shape, counter)).toBe(expected)
  })

  test("adds only the post-snapshot transcript to the provider active context", () => {
    const messages = [Msg.user("first"), Msg.assistant("reply")]
    const state = session(messages)
    const usage: Usage = { inputTokens: 500, outputTokens: 100, activeContextTokens: 640 }
    recordContextUsage(state, usage)
    // A new user turn arrives after the snapshot.
    const added = Msg.user("a follow-up question")
    state.messages.push(added)
    expect(estimateCurrentContextTokens(state, shape, counter)).toBe(
      640 + counter.estimateMessage(added),
    )
  })

  test("uses activeContextTokens (incl. cache) rather than input+output", () => {
    const state = session([Msg.user("x"), Msg.assistant("y")])
    // Cache-heavy Anthropic turn: active context far exceeds input+output.
    recordContextUsage(state, { inputTokens: 12, outputTokens: 4, activeContextTokens: 1016 })
    expect(estimateCurrentContextTokens(state, shape, counter)).toBe(1016)
  })

  test("a shrunk transcript (post-compaction) invalidates the snapshot", () => {
    const messages = [Msg.user("a"), Msg.assistant("b"), Msg.user("c"), Msg.assistant("d")]
    const state = session(messages)
    recordContextUsage(state, { inputTokens: 5_000, outputTokens: 50 })
    expect(state.contextUsage?.measuredAtMessageIndex).toBe(4)
    // Compaction replaces the transcript with fewer messages.
    state.messages.splice(0, state.messages.length, Msg.user("summary"))
    // The stale index now exceeds the length, so we re-estimate locally instead
    // of trusting the 5050-token snapshot.
    expect(estimateCurrentContextTokens(state, shape, counter)).toBeLessThan(5_000)
  })
})

describe("shouldAutoCompact", () => {
  test("true when estimated pressure reaches 90% of the effective window", () => {
    const state = session([Msg.user("x"), Msg.assistant("y")], 10_000)
    // Effective window = 10_000 - 1_000 reserve = 9_000; 90% = 8_100.
    recordContextUsage(state, { inputTokens: 8_200, outputTokens: 0, activeContextTokens: 8_200 })
    expect(shouldAutoCompact(state, shape, counter)).toBe(true)
  })

  test("false below the trigger", () => {
    const state = session([Msg.user("x"), Msg.assistant("y")], 10_000)
    recordContextUsage(state, { inputTokens: 1_000, outputTokens: 0, activeContextTokens: 1_000 })
    expect(shouldAutoCompact(state, shape, counter)).toBe(false)
  })

  test("false when auto compaction is disabled", () => {
    const state = session([Msg.user("x"), Msg.assistant("y")], 10_000)
    Object.assign(state.compaction, { autoEnabled: false })
    recordContextUsage(state, { inputTokens: 9_999, outputTokens: 0, activeContextTokens: 9_999 })
    expect(shouldAutoCompact(state, shape, counter)).toBe(false)
  })

  test("false when the model has no known context window", () => {
    const state = session([Msg.user("x"), Msg.assistant("y")])
    recordContextUsage(state, { inputTokens: 9_999, outputTokens: 0, activeContextTokens: 9_999 })
    expect(shouldAutoCompact(state, shape, counter)).toBe(false)
  })

  test("a tiny window with no maxOutputTokens does not force perpetual compaction", () => {
    // contextWindow 8k < the 20k reserve cap; the reserve is clamped so the
    // effective window stays positive rather than negative.
    const model: Model = {
      id: ModelId.make("tiny"),
      provider: ProviderId.make("test"),
      limits: { contextWindow: 8_000 },
      streamTurn: () => {
        throw new Error("unused")
      },
    }
    expect(effectiveContextWindow(model)).toBeGreaterThan(0)
    const state = createSessionState({
      workingDirectory: "/work",
      model,
      currentDate: "2026-07-13",
      messages: [Msg.user("x"), Msg.assistant("y")],
    })
    recordContextUsage(state, { inputTokens: 100, outputTokens: 0, activeContextTokens: 100 })
    expect(shouldAutoCompact(state, shape, counter)).toBe(false)
  })
})
