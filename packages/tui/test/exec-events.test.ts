import { describe, expect, test } from "bun:test"
import { Message, ToolCallId } from "@swain/llms"
import { initEvent, messageEvent, resultEvent, serialize } from "../src/exec-events"

describe("initEvent", () => {
  test("carries model ref, permission mode, cwd, and router flag", () => {
    expect(
      initEvent({
        model: "anthropic:claude-opus-4-8:high",
        permissionMode: "auto",
        cwd: "/repo",
        router: false,
      }),
    ).toEqual({
      type: "init",
      model: "anthropic:claude-opus-4-8:high",
      permissionMode: "auto",
      cwd: "/repo",
      router: false,
    })
  })
})

describe("messageEvent", () => {
  test("translates an assistant message's blocks to native names", () => {
    const message = Message.assistant([
      { type: "reasoning", text: "let me look" },
      { type: "text", text: "I'll check." },
      {
        type: "tool-call",
        toolCallId: ToolCallId.make("t1"),
        name: "Bash",
        input: { command: "ls" },
      },
    ])
    expect(messageEvent(message)).toEqual({
      type: "assistant",
      content: [
        { type: "reasoning", text: "let me look" },
        { type: "text", text: "I'll check." },
        { type: "tool-call", id: "t1", name: "Bash", input: { command: "ls" } },
      ],
    })
  })

  test("emits a user message only for its tool-result blocks", () => {
    const message = Message.user([
      {
        type: "tool-result",
        toolCallId: ToolCallId.make("t1"),
        name: "Bash",
        result: { type: "text", value: "a.ts" },
        isError: false,
      },
    ])
    expect(messageEvent(message)).toEqual({
      type: "user",
      content: [{ type: "tool-result", id: "t1", name: "Bash", isError: false, result: "a.ts" }],
    })
  })

  test("unwraps a json tool result value and defaults isError to false", () => {
    const message = Message.user([
      {
        type: "tool-result",
        toolCallId: ToolCallId.make("t2"),
        result: { type: "json", value: { ok: true } },
      },
    ])
    expect(messageEvent(message)).toEqual({
      type: "user",
      content: [{ type: "tool-result", id: "t2", isError: false, result: { ok: true } }],
    })
  })

  test("skips a user message with no tool results (prompt echo / meta)", () => {
    expect(messageEvent(Message.user("the original prompt"))).toBeNull()
  })
})

describe("resultEvent", () => {
  test("success carries the final text and is not an error", () => {
    expect(resultEvent("success", "the answer")).toEqual({
      type: "result",
      subtype: "success",
      isError: false,
      result: "the answer",
    })
  })

  test("error_during_execution is flagged and carries the message", () => {
    expect(resultEvent("error_during_execution", "upstream boom")).toEqual({
      type: "result",
      subtype: "error_during_execution",
      isError: true,
      result: "upstream boom",
    })
  })

  test("interrupted is flagged with no result field", () => {
    expect(resultEvent("interrupted")).toEqual({
      type: "result",
      subtype: "interrupted",
      isError: true,
    })
  })
})

describe("serialize", () => {
  test("is single-line JSON with a trailing newline", () => {
    const line = serialize(resultEvent("success", "hi"))
    expect(line.endsWith("\n")).toBe(true)
    expect(line.includes("\n")).toBe(true)
    expect(line.trimEnd().includes("\n")).toBe(false)
    expect(JSON.parse(line)).toEqual({
      type: "result",
      subtype: "success",
      isError: false,
      result: "hi",
    })
  })
})
