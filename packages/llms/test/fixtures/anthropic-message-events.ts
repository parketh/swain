/** Realistic Anthropic Messages SSE event payloads (post-SSE-parse JSON values). */

export const textTurnChunks: Array<unknown> = [
  {
    type: "message_start",
    message: {
      id: "msg_01",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-sonnet-4-5",
      usage: { input_tokens: 12, output_tokens: 1 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "ping" },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 4 },
  },
  { type: "message_stop" },
]

export const toolUseTurnChunks: Array<unknown> = [
  {
    type: "message_start",
    message: {
      id: "msg_02",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-sonnet-4-5",
      usage: { input_tokens: 30, output_tokens: 1 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Looking it up." } },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "toolu_01", name: "lookup", input: {} },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"query":' },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '"bun"}' },
  },
  { type: "content_block_stop", index: 1 },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 15 },
  },
  { type: "message_stop" },
]

export const thinkingTurnChunks: Array<unknown> = [
  {
    type: "message_start",
    message: {
      id: "msg_03",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-sonnet-4-5",
      usage: { input_tokens: 20, output_tokens: 1 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "Consider" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: " carefully." },
  },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "The answer is 4." },
  },
  { type: "content_block_stop", index: 1 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 9 },
  },
  { type: "message_stop" },
]

export const fatalErrorChunks: Array<unknown> = [
  {
    type: "message_start",
    message: {
      id: "msg_04",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-sonnet-4-5",
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Par" } },
  { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
]

export const nonfatalFactChunks: Array<unknown> = [
  {
    type: "message_start",
    message: {
      id: "msg_05",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-sonnet-4-5",
      usage: { input_tokens: 8, output_tokens: 1 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
  { type: "error", error: { type: "informational_notice", message: "degraded quality period" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " there" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 3 },
  },
  { type: "message_stop" },
]

export const invalidToolJsonChunks: Array<unknown> = [
  {
    type: "message_start",
    message: {
      id: "msg_06",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-sonnet-4-5",
      usage: { input_tokens: 5, output_tokens: 1 },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_bad", name: "lookup", input: {} },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"query":' },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 6 },
  },
  { type: "message_stop" },
]

export const maxTokensTurnChunks: Array<unknown> = [
  {
    type: "message_start",
    message: {
      id: "msg_07",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-sonnet-4-5",
      usage: { input_tokens: 6, output_tokens: 1 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "truncated" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "max_tokens", stop_sequence: null },
    usage: { output_tokens: 2 },
  },
  { type: "message_stop" },
]
