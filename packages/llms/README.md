# @swain/llms

Protocol-first, SDK-free LLM provider library. Providers are direct HTTP API clients — no `openai`/`@anthropic-ai/sdk`, no AI SDK, no LangChain. The package owns exactly one provider turn: encode a provider-neutral request, stream the response, and decode it into a provider-neutral `LLMEvent` stream.

## Usage

### OpenAI chat

```ts
import { FetchHttpClient } from "@effect/platform"
import { Effect, Stream } from "effect"
import { LLM } from "@swain/llms"
import { OpenAI } from "@swain/llms/providers"

const model = OpenAI.configure({ apiKey: process.env.OPENAI_API_KEY }).chat("gpt-4.1-mini")

const request = LLM.request({
  model,
  system: "You are a helpful coding assistant.",
  prompt: "Say hello.",
})

// Streaming event consumption
const program = LLM.streamTurn(request).pipe(
  Stream.runForEach((event) => Effect.log(event.type)),
  Effect.provide(FetchHttpClient.layer),
)
```

### Anthropic

```ts
import { Anthropic } from "@swain/llms/providers"

const model = Anthropic.configure({ maxTokens: 4096 }).model("claude-sonnet-4-5")
```

### OpenAI Codex (ChatGPT subscription)

Credentials come from a resolver; OAuth login/refresh/storage live outside this package.

```ts
import { OpenAICodex } from "@swain/llms/providers"

const model = OpenAICodex.configure({
  credentialResolver: () => loadCodexCredentials(), // { accessToken, accountId }
}).model("gpt-5.1-codex")
```

Without a resolver, `OPENAI_CODEX_ACCESS_TOKEN` is used as a fallback when the ChatGPT account id is derivable from the token's JWT claims; otherwise the turn fails with `auth-failed`.

### OpenAI-compatible deployments (DeepSeek, Z.AI, custom)

```ts
import { DeepSeek, OpenAICompatible, ZAI } from "@swain/llms/providers"

const deepseek = DeepSeek.model("deepseek-chat")
const glm = ZAI.model("glm-4.6")
const custom = OpenAICompatible.configure({
  providerId: "my-deployment",
  baseURL: "https://llm.internal.example/v1",
  apiKeyEnv: "MY_DEPLOYMENT_API_KEY",
}).chat("my-model")
```

Sampling is not provider-neutral; pass provider-specific knobs through the typed helpers:

```ts
LLM.request({ model: deepseek, prompt: "…", providerOptions: DeepSeek.options({ temperature: 0.7 }) })
```

### Collecting a turn

```ts
import { LLM, LLMTurnSummary } from "@swain/llms"

// generateTurn collects the streamed events into { events }
const response = yield* LLM.generateTurn(request)

// derive text / reasoning / tool calls / usage from the event log
const summary = yield* LLMTurnSummary.fromEvents(response.events)
summary.text
summary.toolCalls
summary.finish.reason
```

### Tool calls

The package emits tool calls; the caller executes tools. Define tools on the request, then treat `tool-call` events (or `summary.toolCalls`) as the only executable signal — `tool-input-delta` text is raw partial JSON for display only.

```ts
import { Message, Tool } from "@swain/llms"

const request = LLM.request({
  model,
  prompt: "Look up the weather.",
  tools: [
    Tool.define({
      name: "lookup",
      description: "Look up a value",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    }),
  ],
})
```

After executing a tool, the harness appends the result as `ToolResultContent` inside the **next user message** — there is no tool message role:

```ts
Message.user([
  ToolResultContent.make({
    type: "tool-result",
    toolCallId: call.toolCallId,
    name: call.name,
    result: { type: "json", value: { temperature: 21 } },
  }),
])
```

## Environment variables

| Variable | Provider |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI |
| `OPENAI_CODEX_ACCESS_TOKEN` | OpenAI Codex (fallback when no credential resolver) |
| `ANTHROPIC_API_KEY` | Anthropic |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `ZAI_API_KEY` | Z.AI |

## Smoke script

`bun packages/llms/scripts/smoke.ts` runs one real streaming turn per provider whose env key is present and prints the event log. Manual only; never part of `bun test`.
