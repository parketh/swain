/** Realistic ChatGPT/Codex Responses SSE payloads (post-SSE-parse JSON values). */

export const textReasoningTurnChunks: Array<unknown> = [
  { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "reasoning", id: "rs_1", summary: [] },
  },
  { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "Consider" },
  { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: " carefully." },
  { type: "response.reasoning_summary_text.done", item_id: "rs_1", text: "Consider carefully." },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "reasoning", id: "rs_1" },
  },
  {
    type: "response.output_item.added",
    output_index: 1,
    item: { type: "message", id: "msg_1", role: "assistant" },
  },
  { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" },
  { type: "response.output_text.delta", item_id: "msg_1", delta: " world" },
  { type: "response.output_text.done", item_id: "msg_1", text: "Hello world" },
  {
    type: "response.output_item.done",
    output_index: 1,
    item: { type: "message", id: "msg_1" },
  },
  {
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      output: [
        { type: "reasoning", id: "rs_1" },
        { type: "message", id: "msg_1" },
      ],
      usage: { input_tokens: 12, output_tokens: 7 },
    },
  },
]

export const functionCallTurnChunks: Array<unknown> = [
  { type: "response.created", response: { id: "resp_2", status: "in_progress" } },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "" },
  },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"query":' },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"bun"}' },
  {
    type: "response.function_call_arguments.done",
    item_id: "fc_1",
    arguments: '{"query":"bun"}',
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup" },
  },
  {
    type: "response.completed",
    response: {
      id: "resp_2",
      status: "completed",
      output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup" }],
      usage: { input_tokens: 25, output_tokens: 11 },
    },
  },
]

export const parallelFunctionCallTurnChunks: Array<unknown> = [
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "" },
  },
  {
    type: "response.output_item.added",
    output_index: 1,
    item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "lookup", arguments: "" },
  },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"query":"bun"}' },
  { type: "response.function_call_arguments.delta", item_id: "fc_2", delta: '{"query":' },
  {
    type: "response.function_call_arguments.done",
    item_id: "fc_1",
    arguments: '{"query":"bun"}',
  },
  { type: "response.function_call_arguments.delta", item_id: "fc_2", delta: '"deno"}' },
  {
    type: "response.function_call_arguments.done",
    item_id: "fc_2",
    arguments: '{"query":"deno"}',
  },
  {
    type: "response.completed",
    response: {
      id: "resp_parallel",
      status: "completed",
      output: [
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup" },
        { type: "function_call", id: "fc_2", call_id: "call_2", name: "lookup" },
      ],
      usage: { input_tokens: 28, output_tokens: 13 },
    },
  },
]

/** Arguments arrive only on the done event; no streamed deltas. */
export const doneOnlyArgumentsChunks: Array<unknown> = [
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "lookup", arguments: "" },
  },
  {
    type: "response.function_call_arguments.done",
    item_id: "fc_2",
    arguments: '{"query":"deno"}',
  },
  {
    type: "response.completed",
    response: {
      id: "resp_3",
      status: "completed",
      output: [{ type: "function_call", id: "fc_2", call_id: "call_2", name: "lookup" }],
    },
  },
]

export const invalidToolJsonChunks: Array<unknown> = [
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", id: "fc_3", call_id: "call_3", name: "lookup", arguments: "" },
  },
  { type: "response.function_call_arguments.delta", item_id: "fc_3", delta: '{"query":' },
  { type: "response.function_call_arguments.done", item_id: "fc_3", arguments: '{"query":' },
]

export const incompleteTurnChunks: Array<unknown> = [
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "message", id: "msg_2", role: "assistant" },
  },
  { type: "response.output_text.delta", item_id: "msg_2", delta: "partial" },
  {
    type: "response.incomplete",
    response: {
      id: "resp_4",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "message", id: "msg_2" }],
      usage: { input_tokens: 9, output_tokens: 3 },
    },
  },
]

export const failedResponseChunks: Array<unknown> = [
  { type: "response.created", response: { id: "resp_5", status: "in_progress" } },
  {
    type: "response.failed",
    response: {
      id: "resp_5",
      status: "failed",
      error: { code: "server_error", message: "internal failure" },
    },
  },
]

export const quotaErrorChunks: Array<unknown> = [
  { type: "response.created", response: { id: "resp_6", status: "in_progress" } },
  { type: "error", code: "insufficient_quota", message: "usage limit reached" },
]
