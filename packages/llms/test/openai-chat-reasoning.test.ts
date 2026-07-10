import { describe, expect, test } from "bun:test"
import { Message } from "@swain/llms"
import { OpenAIChat } from "@swain/llms/protocols"

const prepareFor = (key: string, options: Record<string, unknown>) =>
  OpenAIChat.prepare(
    {
      modelId: "m",
      messages: [Message.user("hi")],
      providerOptions: { [key]: options },
    },
    { optionsKey: key },
  ).body

describe("OpenAIChat reasoning encoding", () => {
  for (const key of ["deepseek", "zai"]) {
    for (const effort of ["high", "max"] as const) {
      test(`${key}: reasoning at ${effort} encodes the thinking flag and effort`, () => {
        const body = prepareFor(key, { thinking: true, reasoningEffort: effort })
        expect(body.thinking).toEqual({ type: "enabled" })
        expect(body.reasoning_effort).toBe(effort)
      })
    }

    test(`${key}: no reasoning options encode neither field`, () => {
      const body = prepareFor(key, { temperature: 0.5 })
      expect(body.thinking).toBeUndefined()
      expect(body.reasoning_effort).toBeUndefined()
      expect(body.temperature).toBe(0.5)
    })
  }
})
