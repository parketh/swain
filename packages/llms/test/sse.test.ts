import { describe, expect, test } from "bun:test"
import { SSE } from "@swain/llms/transport"

describe("SSE.decode", () => {
  test("decodes a single data event", () => {
    expect(SSE.decode('data: {"a":1}\n\n')).toEqual([{ data: '{"a":1}' }])
  })

  test("joins multi-line data payloads with newlines", () => {
    const events = SSE.decode("data: first\ndata: second\n\n")
    expect(events).toEqual([{ data: "first\nsecond" }])
  })

  test("splits events on blank-line boundaries", () => {
    const events = SSE.decode("data: one\n\ndata: two\n\n")
    expect(events).toEqual([{ data: "one" }, { data: "two" }])
  })

  test("exposes event names", () => {
    const events = SSE.decode('event: message_start\ndata: {"x":1}\n\n')
    expect(events).toEqual([{ event: "message_start", data: '{"x":1}' }])
  })

  test("recognizes the [DONE] sentinel", () => {
    const events = SSE.decode("data: [DONE]\n\n")
    expect(events).toHaveLength(1)
    expect(events[0] !== undefined && SSE.isDone(events[0])).toBe(true)
  })

  test("ignores comments and unknown fields", () => {
    const events = SSE.decode(": keep-alive\nid: 7\nretry: 100\nwhatever: x\ndata: ok\n\n")
    expect(events).toEqual([{ data: "ok" }])
  })

  test("handles CRLF line endings", () => {
    expect(SSE.decode("data: a\r\n\r\ndata: b\r\n\r\n")).toEqual([{ data: "a" }, { data: "b" }])
  })

  test("dispatches a trailing event without a final blank line", () => {
    expect(SSE.decode("data: tail")).toEqual([{ data: "tail" }])
  })
})

describe("SSE.makeDecoder", () => {
  test("assembles events across arbitrary chunk boundaries", () => {
    const decoder = SSE.makeDecoder()
    const collected = [
      ...decoder.feed("da"),
      ...decoder.feed('ta: {"a"'),
      ...decoder.feed(":1}\n"),
      ...decoder.feed("\ndata: next\n\n"),
    ]
    expect(collected).toEqual([{ data: '{"a":1}' }, { data: "next" }])
  })

  test("discards an unterminated trailing event on end", () => {
    const decoder = SSE.makeDecoder()
    expect(decoder.feed("data: partial")).toEqual([])
    expect(decoder.end()).toEqual([])
  })
})
