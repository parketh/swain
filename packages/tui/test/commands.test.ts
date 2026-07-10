import { describe, expect, test } from "bun:test"
import { parseCommand } from "../src/commands"

describe("parseCommand", () => {
  test("plain text parses as a prompt", () => {
    expect(parseCommand("hello")).toEqual({ type: "prompt", text: "hello" })
  })

  test("a bare command parses with empty args", () => {
    expect(parseCommand("/help")).toEqual({ type: "command", name: "help", args: "" })
  })

  test("/router parses as a known command", () => {
    expect(parseCommand("/router")).toEqual({ type: "command", name: "router", args: "" })
  })

  test("/router with args still parses as the router command (args ignored by the UI)", () => {
    expect(parseCommand("/router anything")).toEqual({
      type: "command",
      name: "router",
      args: "anything",
    })
  })

  test("a command preserves its argument string", () => {
    expect(parseCommand("/model openai gpt-4.1")).toEqual({
      type: "command",
      name: "model",
      args: "openai gpt-4.1",
    })
  })

  test("an unrecognized slash token is an unknown-command", () => {
    expect(parseCommand("/unknown x")).toEqual({
      type: "unknown-command",
      name: "unknown",
      args: "x",
    })
  })

  test("leading whitespace before a slash is a prompt, not a command", () => {
    expect(parseCommand("  /help")).toEqual({ type: "prompt", text: "  /help" })
  })
})
