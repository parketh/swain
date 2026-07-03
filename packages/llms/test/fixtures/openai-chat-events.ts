/** Realistic OpenAI Chat Completions `ChatCompletionChunk` streams (post-SSE-parse JSON values). */

export const textTurnChunks: Array<unknown> = [
  {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  },
  {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
  },
  {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }],
  },
  {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  },
  {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  },
]

export const toolCallTurnChunks: Array<unknown> = [
  {
    id: "chatcmpl-2",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }],
  },
  {
    id: "chatcmpl-2",
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_abc",
              type: "function",
              function: { name: "lookup", arguments: "" },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: "chatcmpl-2",
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] },
        finish_reason: null,
      },
    ],
  },
  {
    id: "chatcmpl-2",
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: '"bun"}' } }] },
        finish_reason: null,
      },
    ],
  },
  {
    id: "chatcmpl-2",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  },
  {
    id: "chatcmpl-2",
    object: "chat.completion.chunk",
    choices: [],
    usage: { prompt_tokens: 30, completion_tokens: 9, total_tokens: 39 },
  },
]

export const reasoningTurnChunks: Array<unknown> = [
  {
    id: "chatcmpl-3",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }],
  },
  {
    id: "chatcmpl-3",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { reasoning_content: "Consider" }, finish_reason: null }],
  },
  {
    id: "chatcmpl-3",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { reasoning_content: " carefully." }, finish_reason: null }],
  },
  {
    id: "chatcmpl-3",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: "The answer is 4." }, finish_reason: null }],
  },
  {
    id: "chatcmpl-3",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  },
]

export const invalidToolJsonChunks: Array<unknown> = [
  {
    id: "chatcmpl-4",
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_bad",
              type: "function",
              function: { name: "lookup", arguments: '{"query":' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: "chatcmpl-4",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  },
]

export const noFinishReasonChunks: Array<unknown> = [
  {
    id: "chatcmpl-5",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
  },
]
