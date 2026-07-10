import { describe, expect, test } from "bun:test"
import { LLMTurnSummary, Message } from "@swain/llms"
import { AnthropicMessages } from "@swain/llms/protocols"
import { Effect, Stream } from "effect"
import { thinkingTurnChunks } from "./fixtures/anthropic-message-events"

const prepareSync = (
  ...args: Parameters<typeof AnthropicMessages.prepare>
): Effect.Effect.Success<ReturnType<typeof AnthropicMessages.prepare>> =>
  Effect.runSync(AnthropicMessages.prepare(...args))

const decodeAll = (chunks: Array<unknown>) =>
  Effect.runPromise(
    AnthropicMessages.decode(Stream.fromIterable(chunks)).pipe(Stream.runCollect),
  ).then((events) => Array.from(events))

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

describe("AnthropicMessages adaptive thinking", () => {
  for (const effort of EFFORTS) {
    test(`encodes adaptive thinking with effort ${effort} and drops sampling params`, () => {
      const { body } = prepareSync({
        modelId: "claude-opus-4-8",
        messages: [Message.user("hi")],
        providerOptions: {
          anthropic: {
            thinking: { type: "adaptive", effort },
            temperature: 0.7,
            topP: 0.9,
            topK: 40,
            caching: false,
          },
        },
      })
      expect(body.thinking).toEqual({ type: "adaptive" })
      expect(body.output_config).toEqual({ effort })
      expect(body.temperature).toBeUndefined()
      expect(body.top_p).toBeUndefined()
      expect(body.top_k).toBeUndefined()
    })
  }

  test("adaptive thinking without an explicit effort omits output_config", () => {
    const { body } = prepareSync({
      modelId: "claude-sonnet-5",
      messages: [Message.user("hi")],
      providerOptions: { anthropic: { thinking: { type: "adaptive" }, caching: false } },
    })
    expect(body.thinking).toEqual({ type: "adaptive" })
    expect(body.output_config).toBeUndefined()
  })

  test("without a thinking option, sampling params are still sent", () => {
    const { body } = prepareSync({
      modelId: "claude-sonnet-5",
      messages: [Message.user("hi")],
      providerOptions: { anthropic: { temperature: 0.7, topP: 0.9, caching: false } },
    })
    expect(body.thinking).toBeUndefined()
    expect(body.temperature).toBe(0.7)
    expect(body.top_p).toBe(0.9)
  })

  test("existing thinking-delta stream decoding still passes", async () => {
    const events = await decodeAll(thinkingTurnChunks)
    const summary = await Effect.runPromise(LLMTurnSummary.fromEvents(events))
    expect(summary.reasoning).toBe("Consider carefully.")
    expect(summary.text).toBe("The answer is 4.")
  })
})
