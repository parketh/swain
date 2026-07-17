import { describe, expect, test } from "bun:test"
import { Message, ToolCallId } from "@swain/llms"
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

const kimiProfile = { optionsKey: "kimi", reasoningHistory: "reasoning_content" } as const

const assistantWith = (content: ReadonlyArray<unknown>) =>
  OpenAIChat.prepare(
    {
      modelId: "kimi-k3",
      messages: [
        Message.user("hi"),
        Message.assistant(content as Parameters<typeof Message.assistant>[0]),
      ],
    },
    kimiProfile,
  ).body.messages as Array<Record<string, unknown>>

describe("OpenAIChat Kimi reasoning-history lowering", () => {
  test("replays reasoning as reasoning_content alongside content and tool_calls", () => {
    const messages = assistantWith([
      { type: "reasoning", text: "planstep" },
      { type: "text", text: "answer" },
      { type: "tool-call", toolCallId: ToolCallId.make("call_1"), name: "lookup", input: {} },
    ])
    expect(messages[1]).toEqual({
      role: "assistant",
      reasoning_content: "planstep",
      content: "answer",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } },
      ],
    })
  })

  test("concatenates multiple reasoning blocks with no inserted whitespace", () => {
    const messages = assistantWith([
      { type: "reasoning", text: "plan" },
      { type: "reasoning", text: "step" },
      { type: "text", text: "answer" },
    ])
    expect(messages[1]?.reasoning_content).toBe("planstep")
  })

  test("lowers a reasoning-only assistant message to reasoning_content with null content", () => {
    const messages = assistantWith([{ type: "reasoning", text: "just thinking" }])
    expect(messages[1]).toEqual({
      role: "assistant",
      reasoning_content: "just thinking",
      content: null,
    })
  })

  test("default profile omits reasoning and emits no empty assistant message", () => {
    const messages = OpenAIChat.prepare({
      modelId: "gpt",
      messages: [Message.user("hi"), Message.assistant([{ type: "reasoning", text: "hidden" }])],
    }).body.messages as Array<Record<string, unknown>>
    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual({ role: "user", content: "hi" })
  })
})
