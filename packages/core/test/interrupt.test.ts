import { describe, expect, test } from "bun:test"
import { Message, type Model, ModelId, ProviderId, ToolCallId } from "@swain/llms"
import { Stream } from "effect"
import { INTERRUPT_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE, recordInterruption } from "../src/agent"
import { createSessionState, type SessionState } from "../src/state"

const model: Model = {
  id: ModelId.make("claude-sonnet-5"),
  provider: ProviderId.make("anthropic"),
  streamTurn: () => Stream.empty,
}

const session = (): SessionState =>
  createSessionState({
    workingDirectory: "/w",
    model,
    modelRef: { provider: "anthropic", modelId: "claude-sonnet-5" },
    currentDate: "2026-07-13",
  })

// Anthropic requires the first message to be a user message and strict
// user/assistant alternation, so a valid interrupted history must still alternate.
const rolesAlternate = (state: SessionState): boolean =>
  state.messages.every((m, i) => (i % 2 === 0 ? m.role === "user" : m.role === "assistant"))

describe("recordInterruption", () => {
  test("commits partial assistant text and appends the interrupt marker", () => {
    const state = session()
    state.messages.push(Message.user("do the thing"))
    recordInterruption(state, "I was partway through")
    expect(state.messages).toHaveLength(2)
    expect(state.messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: `I was partway through\n\n${INTERRUPT_MESSAGE}` }],
    })
    expect(state.messages[1]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    // An interruption marker is stamped but fabricates no response/turn duration.
    expect(state.messages[1]?.responseDurationMs).toBeUndefined()
    expect(state.messages[1]?.turnDurationMs).toBeUndefined()
    expect(rolesAlternate(state)).toBe(true)
  })

  test("with no partial text, appends just the interrupt marker", () => {
    const state = session()
    state.messages.push(Message.user("do the thing"))
    recordInterruption(state)
    expect(state.messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: INTERRUPT_MESSAGE }],
    })
  })

  test("answers orphan tool_use so history stays valid, then marks the interrupt", () => {
    const state = session()
    state.messages.push(Message.user("read the file"))
    state.messages.push(
      Message.assistant([
        {
          type: "tool-call",
          toolCallId: ToolCallId.make("call-1"),
          name: "Read",
          input: { p: "a" },
        },
      ]),
    )
    recordInterruption(state)
    // user, assistant(tool_use), user(tool-result), assistant(marker)
    expect(state.messages).toHaveLength(4)
    expect(state.messages[2]).toMatchObject({
      role: "user",
      content: [
        {
          type: "tool-result",
          toolCallId: ToolCallId.make("call-1"),
          name: "Read",
          result: { type: "text", value: INTERRUPT_MESSAGE_FOR_TOOL_USE },
          isError: true,
        },
      ],
    })
    expect(state.messages[3]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: INTERRUPT_MESSAGE }],
    })
    const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    expect(state.messages[2]?.createdAt).toMatch(isoRe)
    expect(state.messages[3]?.createdAt).toMatch(isoRe)
    expect(rolesAlternate(state)).toBe(true)
  })

  test("preserves prior turn messages rather than retracting them", () => {
    const state = session()
    state.messages.push(Message.user("first"))
    state.messages.push(Message.assistant("first answer"))
    state.messages.push(Message.user("second"))
    recordInterruption(state)
    expect(state.messages.slice(0, 3).map((m) => m.role)).toEqual(["user", "assistant", "user"])
    expect(state.messages).toHaveLength(4)
    expect(rolesAlternate(state)).toBe(true)
  })
})
