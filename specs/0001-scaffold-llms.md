# Scaffold Repo + LLMs Package

> Use subagents to implement this plan task-by-task.

**Goal:** Scaffold Swain as a Bun workspace and implement the first package, `packages/llms`, as an Effect-native, protocol-first LLM provider library with streaming deltas and tool-call normalization.

**Architecture:** `llms` exposes a provider-neutral schema and public interface for LLM calls, protocol implementations that encode/decode provider-specific wire formats, facades that bind auth/endpoints/model IDs, and reusable transports for HTTP/SSE API calls. Providers do not use provider SDKs; they call provider HTTP APIs directly. The first implementation supports one provider turn: streaming text/reasoning deltas, streaming tool-call input, final tool-call events, `streamTurn()` as the primary API, and `generateTurn()` as a convenience wrapper that collects streamed events into a single turn response.

**Tech Stack:** Bun, TypeScript ESM, Effect.js, `@effect/platform` `HttpClient`, Bun test runner, direct HTTP API clients.

---

## Current Context / Assumptions

- The Swain repo is effectively empty except `.gitattributes` and `specs/`.
- The repo should be prepared for multiple packages from day one, so `llms` lives in `packages/llms`.
- The first provider set is:
  - OpenAI API and OpenAI-compatible deployments via Chat Completions: `https://api.openai.com/v1/chat/completions` for OpenAI, custom `baseURL` for compatible providers such as DeepSeek and Z.AI
  - OpenAI (via Codex subscription): `https://chatgpt.com/backend-api/codex/responses`
  - Anthropic Messages: `https://api.anthropic.com/v1/messages`
- Direct API references checked:
  - OpenAI Chat Completions exposes streamed `ChatCompletionChunk` deltas and `stream_options` only when `stream: true`.
  - OpenAI-compatible deployments in this plan must send `stream: true`; the shared OpenAI Chat protocol should not support a non-streaming execution path in the first slice.
  - Anthropic Messages streaming uses SSE with `"stream": true` and includes text, tool use, and thinking deltas.
  - Sampling parameter support varies by provider and model: current Anthropic Claude models reject `temperature` combined with `top_p` and require default sampling during extended thinking; OpenAI reasoning models reject non-default `temperature`. Sampling is therefore not provider-neutral; omit it from provider-neutral request options.
  - DeepSeek Chat Completions documents `stream: true` as data-only SSE deltas terminated by `data: [DONE]`.
  - DeepSeek Chat Completions documents sampling parameters such as `temperature` and `top_p`; treat these as provider-specific options.
  - Z.AI documents OpenAI-compatible HTTP APIs and streaming-capable chat models; treat it as an OpenAI-compatible streaming profile unless a model-specific endpoint says otherwise.
  - Z.AI documents sampling parameters such as `temperature` and `top_p`; treat these as provider-specific options.
  - Tau's `src/tau_ai/openai_codex.py` demonstrates the ChatGPT/Codex subscription path: `/codex/responses`, Responses-style SSE events, `Authorization`, `chatgpt-account-id`, `OpenAI-Beta: responses=experimental`, and a credential resolver.

## Key Decisions

- **Protocol-first, SDK-free:** Implement direct HTTP API clients. Do not depend on provider SDKs (`openai`, `@anthropic-ai/sdk`) or third party frameworks (AI SDK, LangChain, etc).
- **Package boundary:** Use `packages/llms`, not root `src/llms`.
- **First correctness target:** One-turn streaming chat with provider-neutral deltas and tool calls. Multi-turn agent loops and tool execution belong outside this package.
- **Tracer slice first:** Prove one end-to-end turn (OpenAI Chat protocol -> OpenAI facade -> `LLM.streamTurn`) before implementing the remaining protocols and facades.
- **Initial provider scope:** Implement `OpenAI` once for OpenAI API and OpenAI-compatible Chat Completions. Implement Anthropic Messages separately. Implement OpenAI Codex separately for ChatGPT/Codex subscription credentials and Responses-style `/codex/responses`.
- **OpenAI split:** `OpenAI` means API-key OpenAI API plus compatible `/chat/completions` deployments configured by `baseURL`. `OpenAICodex` means ChatGPT/Codex subscription integration using an access token plus ChatGPT account id credential resolver. `llms` accepts reusable Codex credentials through a resolver; OAuth login, refresh, and credential storage belong in the harness/credential package.
- **Common interface ownership:** Swain defines its own semantic names and fields; use prior art as a guide only.
- **System prompt boundary:** `system` is a separate `LLMRequest` field. `messages` must not contain a system role.
- **Tool result representation:** Tool results are `ToolResultContent` inside `UserMessage.content`; there is no `ToolMessage` type, only `UserMessage` and `AssistantMessage`.
- **Turn APIs only:** Public execution APIs are `LLM.streamTurn(request)` and `LLM.generateTurn(request)`. No multi-turn `run` or implicit tool loop. That belongs in a future harness package.
- **Defer:** embeddings, images, audio, prompt caching, cost/pricing, live model catalog fetches, local tool execution, retries, durable session state, OAuth, and agent orchestration.

## Public API Shape

Target call site:

```ts
import { Effect, Stream } from "effect"
import { FetchHttpClient } from "@effect/platform"
import { LLM, LLMTurnSummary, Message, Tool } from "@swain/llms"
import { OpenAI, OpenAICodex, Anthropic } from "@swain/llms/providers"

const model = OpenAI.configure({ apiKey: process.env.OPENAI_API_KEY }).chat("gpt-4.1-mini")

const request = LLM.request({
  model,
  system: "You are a helpful coding assistant.",
  messages: [Message.user("Say hello and call a tool if needed.")],
  tools: [
    Tool.define({
      name: "lookup",
      description: "Look up a value",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    }),
  ],
})

const summary = LLM.streamTurn(request).pipe(
  Stream.runCollect,
  Effect.flatMap((events) => LLMTurnSummary.fromEvents(Array.from(events))),
  Effect.provide(FetchHttpClient.layer),
)
```

## Common Interface Contract

`llms` owns one provider turn. The harness owns loops, tool execution, retries, continuation, compaction, fallback model switching, persistence, permissions, and policy.

```ts
type LLMRequest = {
  model: Model
  system?: SystemContent
  messages: ReadonlyArray<Message>
  tools?: ReadonlyArray<Tool>
  toolChoice?: ToolChoice
  generation?: GenerationOptions
  providerOptions?: ProviderOptions
}

type LLMResponse = {
  events: ReadonlyArray<LLMEvent>
}

type Message = UserMessage | AssistantMessage

type UserMessage = {
  role: "user"
  content: ReadonlyArray<TextContent | ToolResultContent>
}

type AssistantMessage = {
  role: "assistant"
  content: ReadonlyArray<TextContent | ReasoningContent | ToolCallContent>
}

type ToolResultValue =
  | { type: "text"; value: string }
  | { type: "json"; value: unknown }
```

Provider-specific request knobs are explicit and typed:

```ts
type ProviderOptions = {
  openai?: OpenAIProviderOptions
  openaiCodex?: OpenAICodexProviderOptions
  anthropic?: AnthropicProviderOptions
  [provider: string]: unknown
}
```

No generic `meta` field in the first slice. Add specific fields later when the need is concrete.

### Events

Events are the contract between `llms` and the agent harness (or other consumers). Protocol adapters convert provider-specific streaming responses into a provider-neutral event stream, so callers can react to text, reasoning, tool-call construction, provider facts, and turn completion across any supported provider wire format.

Use PascalCase schema/type names and kebab-case discriminants. IDs are required; adapters synthesize stable IDs when providers omit them.

```ts
type LLMEvent =
  | { type: "text-start"; contentId: string }
  | { type: "text-delta"; contentId: string; text: string }
  | { type: "text-end"; contentId: string }
  | { type: "reasoning-start"; contentId: string }
  | { type: "reasoning-delta"; contentId: string; text: string }
  | { type: "reasoning-end"; contentId: string }
  | { type: "tool-input-start"; toolCallId: string; name: string }
  | { type: "tool-input-delta"; toolCallId: string; text: string }
  | { type: "tool-input-end"; toolCallId: string; name: string }
  | { type: "tool-call"; toolCallId: string; name: string; input: unknown }
  | { type: "provider-error"; message: string; code?: string; recoverable?: boolean }
  | { type: "finish"; reason: FinishReason; usage?: Usage }

type FinishReason =
  | "stop"
  | "length"
  | "tool-call"
  | "content-filter"
  | "refusal"
  | "unknown"
```

Finish reason lowering:
- OpenAI Chat `stop`/`length`/`tool_calls`/`content_filter` map to `stop`/`length`/`tool-call`/`content-filter`
- Anthropic `end_turn`/`stop_sequence` map to `stop`, `max_tokens` to `length`, `tool_use` to `tool-call`, `refusal` to `refusal`
- Codex `response.completed` maps by output content, `response.incomplete` by its reason
- Anything unmapped is `unknown`

Providers often stream tool arguments in pieces, before the full JSON object is complete:
 - `tool-input-delta.text` exposes each raw argument chunk for display/debugging
 - `tool-call.input` is emitted only after those chunks are assembled and parsed, and is the only event the harness should treat as executable

Successful turn invariants:

- Exactly one `finish` event, which is the last event. Usage stats, when present, live on `finish`.
- `text-delta` only appears after `text-start` for the same `contentId`.
- `text-end` only appears after `text-start` for the same `contentId`.
- `reasoning-delta` only appears after `reasoning-start` for the same `contentId`.
- `reasoning-end` only appears after `reasoning-start` for the same `contentId`.
- `tool-input-delta` only appears after `tool-input-start` for the same `toolCallId`.
- `tool-input-end` only appears after `tool-input-start` for the same `toolCallId`.
- `tool-call` only appears after `tool-input-end` for the same `toolCallId`.
- `provider-error` may appear before `finish` only for nonfatal in-band provider errors. Fatal provider errors must fail the Effect with `LLMError`; when available, `LLMError.eventsSoFar` should return all events emitted prior to the error for debugging.

Fatal turn failures use the Effect error channel:

```ts
type LLMErrorReason =
  | "rate-limited"
  | "overloaded"
  | "context-length-exceeded"
  | "auth-failed"
  | "invalid-request"
  | "server-error"
  | "network-error"
  | "invalid-provider-output"
  | "unsupported-feature"

type LLMError = {
  reason: LLMErrorReason
  message: string
  retryable: boolean
  retryAfter?: Duration
  eventsSoFar?: ReadonlyArray<LLMEvent>
}
```

Caller cancellation is Effect interruption, not an error. Interrupting the fiber tears down the stream and aborts the in-flight HTTP request via `HttpClient`'s built-in interruption handling. There is no `aborted` error reason; `LLMError` only describes failures reported by the transport or provider.

`ProviderError` is not a duplicate recovery signal. Use it only for nonfatal in-band provider facts where the stream can still finish successfully. Use `LLMError` for fatal SSE errors, 429, 529/overload, context length exceeded, auth failures, network drops, malformed provider events, and invalid tool-call JSON.

### Turn Summary Helper

The response remains a faithful event list. Derived state comes from one helper:

```ts
type LLMTurnSummary = {
  finish: Finish
  usage?: Usage
  text: string
  reasoning: string
  toolCalls: ReadonlyArray<ToolCall>
  assistantContent: ReadonlyArray<TextContent | ReasoningContent | ToolCallContent>
  providerErrors: ReadonlyArray<ProviderError>
}

LLMTurnSummary.fromEvents(events): Effect.Effect<LLMTurnSummary, LLMError>
```

`fromEvents` validates the event ordering invariants. Malformed event lists fail with `LLMError` reason `invalid-provider-output`.

## Package Layout

```text
.
  package.json
  tsconfig.json
  biome.json
  packages/
    llms/
      package.json
      tsconfig.json
      src/
        index.ts
        llm.ts
        schema/
          errors.ts
          events.ts
          ids.ts
          index.ts
          messages.ts
          options.ts
        providers/
          anthropic.ts
          deepseek.ts
          index.ts
          openai-codex.ts
          openai-compatible.ts
          openai.ts
          zai.ts
        protocols/
          anthropic-messages.ts
          index.ts
          openai-codex-responses.ts
          openai-chat.ts
          tool-input.ts
        transport/
          auth.ts
          http.ts
          index.ts
          sse.ts
      scripts/
        smoke.ts
      test/
        anthropic-messages.test.ts
        exports.test.ts
        fixtures/
          anthropic-message-events.ts
          openai-codex-events.ts
          openai-chat-events.ts
        llm.test.ts
        openai-codex.test.ts
        openai-chat.test.ts
        http.test.ts
        provider-facades.test.ts
        schema.test.ts
        sse.test.ts
```

## Task 1: Scaffold Bun Workspace

**Objective:** Create a runnable multi-package TypeScript workspace with `packages/llms`.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `biome.json`
- Create: `packages/llms/package.json`
- Create: `packages/llms/tsconfig.json`
- Create: `packages/llms/src/index.ts`
- Create: `packages/llms/test/exports.test.ts`

**Steps:**

1. Create root `package.json` with:
   - `"type": "module"`
   - `"packageManager": "bun@1.3.14"`
   - workspaces: `["packages/*"]`
   - scripts:
     - `"typecheck": "bun run --cwd packages/llms typecheck"`
     - `"format": "bun run --cwd packages/llms format"`
     - `"format:check": "bun run --cwd packages/llms format:check"`
     - `"test": "bun test packages/llms/test"`
2. Add root `tsconfig.json` extending `@tsconfig/bun/tsconfig.json`.
3. Add root `biome.json` with minimal formatter settings; the package runs biome against the root config.
4. Add `packages/llms/package.json`:
   - name: `@swain/llms`
   - exports:
     - `"."`: `./src/index.ts`
     - `"./schema"`: `./src/schema/index.ts`
     - `"./providers"`: `./src/providers/index.ts`
     - `"./protocols"`: `./src/protocols/index.ts`
     - `"./transport"`: `./src/transport/index.ts`
   - dependencies pinned exactly, no semver ranges:
     - `"effect": "3.21.4"`
     - `"@effect/platform": "0.96.2"`
   - devDependencies pinned exactly, no semver ranges:
     - `"@biomejs/biome": "2.5.2"`
     - `"@tsconfig/bun": "1.0.10"`
     - `"@types/bun": "1.3.14"`
     - `"typescript": "6.0.3"`
   - scripts:
     - `"typecheck": "tsc --noEmit"`
     - `"format": "biome format --write ."`
     - `"format:check": "biome format ."`
     - `"test": "bun test test"`
5. Add an export smoke test that imports from all public export paths.
6. Run:
   - `bun install`
   - verify `bun.lock` was created and contains exact package resolutions
   - `bun run typecheck`
   - `bun run format:check`
   - `bun test packages/llms/test/exports.test.ts`
7. Commit:
   - `git add "package.json" "tsconfig.json" "biome.json" "packages/llms/**"`
   - `git commit -m "chore: scaffold bun workspace"`

## Task 2: Define Provider-Neutral Schema

**Objective:** Add the canonical runtime data model for requests, messages, tools, events, models, and typed failures.

**Files:**
- Create: `packages/llms/src/schema/ids.ts`
- Create: `packages/llms/src/schema/messages.ts`
- Create: `packages/llms/src/schema/events.ts`
- Create: `packages/llms/src/schema/options.ts`
- Create: `packages/llms/src/schema/errors.ts`
- Create: `packages/llms/src/schema/index.ts`
- Create: `packages/llms/test/schema.test.ts`

**Schema requirements:**

- Branded IDs:
  - `ProviderId`
  - `ModelId`
  - `ProtocolId`
  - `ContentId`
  - `ToolCallId`
- `SystemContent`: text-only privileged prompt content.
- Message content blocks use `*Content` names:
  - `TextContent`
  - `ReasoningContent`
  - `ToolCallContent`
  - `ToolResultContent`
- `Message` roles:
  - `user`
  - `assistant`
- No `system` message role.
- No public `ToolMessage`.
- `UserMessage.content` accepts:
  - `TextContent`
  - `ToolResultContent`
- `AssistantMessage.content` accepts:
  - `TextContent`
  - `ReasoningContent`
  - `ToolCallContent`
- `ToolCallContent`:
  - `type: "tool-call"`
  - `toolCallId`
  - `name`
  - `input`
- `ToolResultContent`:
  - `type: "tool-result"`
  - `toolCallId`
  - optional `name`
  - `result: ToolResultValue`
  - optional `isError`
- `ToolResultValue`:
  - `{ type: "text"; value: string }`
  - `{ type: "json"; value: unknown }`
- `Tool`:
  - `name`
  - `description`
  - `inputSchema`
  - constructor API: `Tool.define(input)`
- `ToolChoice`:
  - `auto`
  - `none`
  - `required`
  - named tool
- `GenerationOptions`:
  - `maxTokens`
  - `stop`
- Sampling controls such as `temperature`, `topP`, `topK`, and `seed` are not provider-neutral. Expose them only through typed `providerOptions` helpers for providers/models that actually support them.
- `ProviderOptions` is keyed by provider id and typed by provider files.
- `FinishReason` literals:
  - `stop`
  - `length`
  - `tool-call`
  - `content-filter`
  - `refusal`
  - `unknown`
- `Model`:
  - `id`
  - `provider`
  - `streamTurn(request)`: provider-bound function that executes exactly one model turn and emits `LLMEvent`s
  - optional `limits`: model capability metadata such as context window and maximum output tokens
- `LLMRequest`:
  - `model`
  - `system`
  - `messages`
  - `tools`
  - `toolChoice`
  - `generation`
  - `providerOptions`
- `LLMResponse`:
  - `events`
- `LLMEvent` union:
  - `TextStart`
  - `TextDelta`
  - `TextEnd`
  - `ReasoningStart`
  - `ReasoningDelta`
  - `ReasoningEnd`
  - `ToolInputStart`
  - `ToolInputDelta`
  - `ToolInputEnd`
  - `ToolCall`
  - `ProviderError`
  - `Finish`
- Event discriminants stay kebab-case.
- Event payloads use `contentId` for text/reasoning and `toolCallId` for tools.
- `Usage`:
  - `inputTokens`
  - `outputTokens`
- `LLMError` reason literals:
  - `rate-limited`
  - `overloaded`
  - `context-length-exceeded`
  - `auth-failed`
  - `invalid-request`
  - `server-error`
  - `network-error`
  - `invalid-provider-output`
  - `unsupported-feature`
- `LLMError` also carries:
  - `message`
  - `retryable`
  - optional `retryAfter`
  - optional `eventsSoFar`
- `LLMTurnSummary.fromEvents(events)` validates and derives:
  - final `Finish`
  - `usage`
  - concatenated `text`
  - concatenated `reasoning`
  - executable `toolCalls`
  - `assistantContent`
  - nonfatal `providerErrors`

**Tests:**

- Message constructors normalize strings into `TextContent`.
- No constructor permits a system role in `messages`.
- No constructor creates a public `ToolMessage`.
- User messages can contain `ToolResultContent`.
- Tool choice accepts `"auto"`, `"none"`, `"required"`, and a named tool.
- Events expose type guards, preferably camelCase aliases like `LLMEvent.is.textDelta`.
- `LLMTurnSummary.fromEvents` rejects malformed order and missing/non-final/multiple `finish` events.
- Invalid schema input fails through Effect Schema decoding.

**Verification:**

- `bun test packages/llms/test/schema.test.ts`
- `bun run typecheck`
- `bun run format:check`

**Commit:**

```bash
git add "packages/llms/src/schema/**" "packages/llms/test/schema.test.ts"
git commit -m "feat: define llm schema"
```

## Task 3: Add LLM Request Helpers

**Objective:** Add ergonomic constructors without creating a second data model.

**Files:**
- Create: `packages/llms/src/llm.ts`
- Modify: `packages/llms/src/index.ts`
- Create: `packages/llms/test/llm.test.ts`

**Implementation requirements:**

- `LLM.request(input)` normalizes:
  - `system: string | SystemContent`
  - `prompt: string | UserContent[]` into a trailing user message
  - `messages` into `Message`
  - `tools` into `Tool`
  - generation options into schema classes
- `LLM.streamTurn(request)` and `LLM.generateTurn(request)` should be exported here but can delegate to the selected model runtime added in Task 7.
- `LLM.generateTurn(request)` must be documented and implemented as a convenience wrapper that collects streamed events over `LLM.streamTurn(request)` into a single turn response.

**Tests:**

- `prompt` becomes one user message.
- `system` stays on the request and never becomes a chronological message.

**Verification:**

- `bun test packages/llms/test/llm.test.ts`
- `bun run typecheck`
- `bun run format:check`

**Commit:**

```bash
git add "packages/llms/src/llm.ts" "packages/llms/src/index.ts" "packages/llms/test/llm.test.ts"
git commit -m "feat: add llm request helpers"
```

## Task 4: Build Transport Primitives

**Objective:** Add the small reusable transport layer needed by provider protocols: auth resolution, HTTP request execution, and SSE parsing.

**Files:**
- Create: `packages/llms/src/transport/auth.ts`
- Create: `packages/llms/src/transport/sse.ts`
- Create: `packages/llms/src/transport/http.ts`
- Create: `packages/llms/src/transport/index.ts`
- Create: `packages/llms/test/sse.test.ts`
- Create: `packages/llms/test/http.test.ts`

**Implementation requirements:**

- `Auth` supports:
  - no auth
  - bearer token
  - static header
  - environment variable fallback
- `SSE.decode(text)` handles:
  - `data:` lines
  - blank-line event boundaries
  - `[DONE]`
  - ignored comments/unknown fields
- Use `@effect/platform` `HttpClient.HttpClient` / `HttpClientResponse.HttpClientResponse` instead of raw web `fetch` / `Response`.
- `Http.prepareJson(...)` builds an `HttpClientRequest` value with method, URL, headers, and JSON body without sending.
- `Http.streamSseJson(...)` executes the request via the `HttpClient.HttpClient` service from the Effect context and returns parsed SSE JSON values as a stream. Interruption aborts the in-flight request through `HttpClient`'s built-in handling; no manual `AbortSignal` wiring.
- `HttpClient.HttpClient` flows through the requirements channel; callers provide `FetchHttpClient.layer` (or a test layer) at the edge.
- Provider/protocol files own endpoint paths and provider-native body construction; do not introduce a general routing framework in this first slice.
- Fatal provider/transport failures fail the Effect channel with `LLMError`.
- Nonfatal in-band provider facts may emit `ProviderError` and continue.
- Keep the HTTP implementation small and replaceable. Do not introduce retries yet.

**Tests:**

- SSE parser handles multi-line `data:` payloads.
- Auth merges provider headers without mutating input.
- `Http.prepareJson(...)` builds URL, body, and headers without network.
- `Http.streamSseJson(...)` maps HTTP errors to typed `LLMError` without leaking raw `HttpClientError`s.
- Transport tests provide a stub `HttpClient` test layer instead of hitting the network.
- 429 maps to `LLMError` reason `rate-limited`, `retryable: true`, and `retryAfter` when available.
- 529/overload maps to `LLMError` reason `overloaded`, `retryable: true`.
- Auth failures map to `auth-failed`.
- Network failures map to `network-error`.

**Verification:**

- `bun test packages/llms/test/sse.test.ts packages/llms/test/http.test.ts`
- `bun run typecheck`
- `bun run format:check`

**Commit:**

```bash
git add "packages/llms/src/transport/**" "packages/llms/test/sse.test.ts" "packages/llms/test/http.test.ts"
git commit -m "feat: add llm transport runtime"
```

## Task 5: Implement OpenAI Chat Protocol

**Objective:** Encode provider-neutral requests into OpenAI Chat Completions wire format and decode streaming chunks into provider-neutral events. This one protocol is reused by OpenAI API and every OpenAI-compatible provider profile.

**Files:**
- Create: `packages/llms/src/protocols/openai-chat.ts`
- Create: `packages/llms/src/protocols/tool-input.ts`
- Create: `packages/llms/src/protocols/index.ts`
- Create: `packages/llms/test/fixtures/openai-chat-events.ts`
- Create: `packages/llms/test/openai-chat.test.ts`

**Wire requirements:**

- POST `/chat/completions`.
- Always send `stream: true`; this protocol exists to normalize streamed deltas and tool-call argument chunks.
- Send `stream_options: { include_usage: true }` when the provider supports it. Treat unsupported `stream_options` as a provider-profile override, not a separate non-streaming path.
- Request body:
  - `model`
  - `messages`
  - `tools`
  - `tool_choice`
  - `stream: true`
  - `stream_options: { include_usage: true }`
  - portable generation options mapped to OpenAI-compatible names
  - OpenAI-compatible sampling options from typed `providerOptions`, when supplied
- Lower messages:
  - `system` to system role
  - `user` text to string content
  - `assistant` text/reasoning/tool calls to assistant content/tool_calls
  - `ToolResultContent` inside `UserMessage.content` to OpenAI wire messages with `role: "tool"` and `tool_call_id`
- Lower tools to `type: "function"` with JSON schema parameters.
- Decode streaming chunks:
  - `delta.content` -> text delta lifecycle events
  - `delta.reasoning_content` or compatible equivalent -> reasoning delta lifecycle events
  - `delta.tool_calls[].function.arguments` -> tool input deltas
  - completed tool call JSON arguments -> final `tool-call`
  - `usage` -> `finish.usage`
  - finish reason -> final `finish`
- `tool-input-delta.text` must be raw provider argument delta text.
- `tool-call.input` must be parsed JSON/object and must not contain raw argument text.
- `protocols/tool-input.ts` owns only streamed tool input assembly: collect raw argument chunks by `toolCallId`, emit lifecycle events, parse final JSON input, and fail malformed JSON with `invalid-provider-output`.
- If the provider ends without a usable finish reason, synthesize `finish` reason `unknown`.

**Tests:**

- `prepare()` matches expected OpenAI Chat request body for text + tool definitions.
- Streaming text chunks produce `text-start`, `text-delta`, `text-end`.
- Streaming tool-call chunks produce input lifecycle events and final parsed `tool-call`.
- Invalid tool-call JSON fails with `LLMError` reason `invalid-provider-output`.
- Reasoning deltas are preserved when present.
- Successful fixture streams end with exactly one final `finish`.

**Verification:**

- `bun test packages/llms/test/openai-chat.test.ts`
- `bun run typecheck`
- `bun run format:check`

**Commit:**

```bash
git add "packages/llms/src/protocols/**" "packages/llms/test/fixtures/openai-chat-events.ts" "packages/llms/test/openai-chat.test.ts"
git commit -m "feat: add openai chat protocol"
```

## Task 6: Add OpenAI-Compatible Provider Facades

**Objective:** Add small provider configuration APIs that bind endpoint/auth/defaults before model selection. Anthropic and OpenAI Codex facades land in Task 10, after their protocols; this task plus Task 7 proves one end-to-end slice over OpenAI Chat before the other providers are implemented.

**Files:**
- Create: `packages/llms/src/providers/openai.ts`
- Create: `packages/llms/src/providers/openai-compatible.ts`
- Create: `packages/llms/src/providers/deepseek.ts`
- Create: `packages/llms/src/providers/zai.ts`
- Create: `packages/llms/src/providers/index.ts`
- Create: `packages/llms/test/provider-facades.test.ts`

**Implementation requirements:**

- `OpenAICompatible.configure({ providerId, baseURL, apiKey?, apiKeyEnv?, headers? }).chat(modelId)`
  - generic facade for OpenAI-compatible `/chat/completions` deployments
  - owns the shared model runtime construction used by OpenAI, DeepSeek, and Z.AI
  - exports typed `OpenAICompatible.options(input)` helper for OpenAI-compatible knobs such as `temperature` and `topP`; include fields like `seed` only for providers/models that support them
- `OpenAI.configure({ apiKey?, baseURL?, headers? }).chat(modelId)`
  - thin profile over `OpenAICompatible`
  - default `baseURL`: `https://api.openai.com/v1`
  - env fallback: `OPENAI_API_KEY`
  - exports typed `OpenAI.options(input)` helper for OpenAI-specific request options such as sampling and reasoning effort when supported by the selected model
- `DeepSeek.model(modelId)` profile:
  - thin profile over `OpenAICompatible`
  - provider id: `deepseek`
  - default base URL: `https://api.deepseek.com`
  - env fallback: `DEEPSEEK_API_KEY`
- `ZAI.model(modelId)` profile:
  - thin profile over `OpenAICompatible`
  - provider id: `zai`
  - default base URL: `https://api.z.ai/api/paas/v4`
  - env fallback: `ZAI_API_KEY`
  - allow callers to override base URL for GLM Coding Plan endpoints.

**Tests:**

- Provider model carries the correct provider id and executable turn runtime.
- Profiles set expected default base URLs.
- Explicit `apiKey` wins over env fallback.
- Missing auth fails at request execution or preparation with `LLMError` reason `auth-failed`, not a raw throw.
- Provider option helpers return a keyed `ProviderOptions` object and protocols only read their own key.

**Verification:**

- `bun test packages/llms/test/provider-facades.test.ts`
- `bun run typecheck`
- `bun run format:check`

**Commit:**

```bash
git add "packages/llms/src/providers/**" "packages/llms/test/provider-facades.test.ts"
git commit -m "feat: add openai-compatible provider facades"
```

## Task 7: Wire StreamTurn, GenerateTurn, And Turn Summary

**Objective:** Connect `LLM.streamTurn`, `LLM.generateTurn`, and turn summary derivation to the selected model runtime.

**Files:**
- Modify: `packages/llms/src/llm.ts`
- Modify: `packages/llms/src/index.ts`
- Create or modify: `packages/llms/test/llm.test.ts`

**Implementation requirements:**

- `LLM.streamTurn(request)` delegates to the selected model's internal `streamTurn` runtime.
- `LLM.generateTurn(request)` collects `streamTurn(request)` and returns `LLMResponse` with only:
  - `events`
- `LLMTurnSummary.fromEvents(events)` derives:
  - final `finish`
  - `usage`
  - concatenated `text`
  - concatenated `reasoning`
  - executable `toolCalls`
  - `assistantContent`
  - nonfatal `providerErrors`
- `LLMTurnSummary.fromEvents(events)` validates ordering invariants and fails with `LLMError` reason `invalid-provider-output` for malformed event logs.
- The runtime is one-turn only. It does not execute tools or continue the conversation.
- Provider errors surface as typed `LLMError`.
- `LLMError.eventsSoFar` may be populated by `generateTurn()` for debugging when collection fails after partial events.

**Tests:**

- End-to-end tracer: an `OpenAI` model with a stub `HttpClient` layer streams a fixture-backed turn through `LLM.streamTurn` and produces the full event lifecycle.
- `generateTurn()` collects a fixture-backed stream into `{ events }`.
- `streamTurn()` returns events without forcing collection.
- `LLMTurnSummary.fromEvents()` derives text, reasoning, tool calls, provider errors, usage, and finish reason from final events.
- `LLMTurnSummary.fromEvents()` rejects missing, multiple, or non-final `finish` events.
- `LLMTurnSummary.fromEvents()` rejects invalid text/reasoning/tool lifecycle order.

**Verification:**

- `bun test packages/llms/test/llm.test.ts`
- `bun run typecheck`
- `bun run format:check`

**Commit:**

```bash
git add "packages/llms/src/llm.ts" "packages/llms/src/index.ts" "packages/llms/test/llm.test.ts"
git commit -m "feat: wire llm turn runtime"
```

## Task 8: Implement Anthropic Messages Protocol

**Objective:** Encode provider-neutral requests into Anthropic Messages wire format and decode Anthropic SSE events into provider-neutral events.

**Files:**
- Create: `packages/llms/src/protocols/anthropic-messages.ts`
- Create: `packages/llms/test/fixtures/anthropic-message-events.ts`
- Create: `packages/llms/test/anthropic-messages.test.ts`

**Wire requirements:**

- POST `/messages`.
- Headers:
  - `x-api-key`
  - `anthropic-version: 2023-06-01`
  - `content-type: application/json`
- Request body:
  - `model`
  - `system`
  - `messages`
  - `tools`
  - `tool_choice`
  - `stream: true`
  - `max_tokens`
- Anthropic requires `max_tokens`; default it conservatively in the provider or selected model runtime defaults.
- Lower tools to Anthropic tool definitions with `input_schema`.
- Lower `ToolResultContent` inside `UserMessage.content` to Anthropic `tool_result` blocks.
- Lower `ToolResultValue.text` to a string result.
- Lower `ToolResultValue.json` by JSON-encoding the value.
- Preserve `ToolResultContent.isError` as Anthropic `is_error`.
- Decode SSE events:
  - `content_block_start` text/tool/thinking
  - `content_block_delta` text/thinking/input JSON deltas
  - `content_block_stop`
  - `message_delta` finish reason and usage
  - `message_stop` final finish
  - nonfatal provider error facts to `ProviderError`
  - fatal provider stream errors to `LLMError`
- `tool-input-delta.text` must be raw provider partial JSON text.
- `tool-call.input` must be parsed JSON/object and must not contain raw partial JSON text.

**Tests:**

- `prepare()` matches expected body for system + user + tool definitions.
- Text deltas produce lifecycle events.
- Tool-use partial JSON produces input lifecycle events and final `tool-call`.
- Thinking deltas produce reasoning events.
- Nonfatal Anthropic error facts map to `ProviderError`.
- Fatal Anthropic error events fail with `LLMError`.
- Successful fixture streams end with exactly one final `finish`.

**Verification:**

- `bun test packages/llms/test/anthropic-messages.test.ts`
- `bun run typecheck`
- `bun run format:check`

**Commit:**

```bash
git add "packages/llms/src/protocols/anthropic-messages.ts" "packages/llms/test/fixtures/anthropic-message-events.ts" "packages/llms/test/anthropic-messages.test.ts"
git commit -m "feat: add anthropic messages protocol"
```

## Task 9: Implement OpenAI Codex Responses Protocol

**Objective:** Encode provider-neutral requests into the ChatGPT/Codex subscription Responses wire format and decode streamed response events into provider-neutral events.

**Files:**
- Create: `packages/llms/src/protocols/openai-codex-responses.ts`
- Create: `packages/llms/test/fixtures/openai-codex-events.ts`
- Create: `packages/llms/test/openai-codex.test.ts`

**Wire requirements:**

- POST `/codex/responses` resolved from default base URL `https://chatgpt.com/backend-api`.
- Always send `stream: true`.
- Request body:
  - `model`
  - `store: false`
  - `stream: true`
  - `instructions` from `LLMRequest.system`
  - `input` converted from `LLMRequest.messages`
  - `text: { verbosity: "low" }`
  - `include: ["reasoning.encrypted_content"]`
  - `tool_choice`
  - `parallel_tool_calls: true`
  - optional `reasoning` from typed `OpenAICodex.options(...)`
- Headers:
  - `Authorization: Bearer <access token>`
  - `chatgpt-account-id: <account id>`
  - `originator`
  - `OpenAI-Beta: responses=experimental`
  - `accept: text/event-stream`
  - `content-type: application/json`
- Lower messages:
  - `UserMessage` text to Responses `input_text`
  - `AssistantMessage` text to completed assistant message output items
  - `ToolCallContent` to Responses `function_call` items
  - `ToolResultContent` to Responses `function_call_output` items
- Tool call IDs may need to preserve both provider `call_id` and item id. Use a reversible encoding such as `<call_id>|<item_id>` internally if needed, but keep the public field as `toolCallId`.
- Lower tools to Responses function tools with `parameters`.
- Decode SSE events:
  - `response.output_text.delta` -> text deltas
  - `response.reasoning.delta`, `response.reasoning_summary_text.delta`, and `response.reasoning_text.delta` -> reasoning deltas
  - `response.output_item.added` for function call tracking
  - `response.function_call_arguments.delta` -> raw `tool-input-delta.text`
  - `response.function_call_arguments.done` and function-call item completion -> final parsed `tool-call`
  - `response.done`, `response.completed`, or `response.incomplete` -> final `finish`
  - `error` or `response.failed` -> fatal `LLMError` unless a future concrete case proves it is nonfatal
- Map terminal billing/quota errors to non-retryable `rate-limited` or `auth-failed` where possible.

**Tests:**

- `prepare()` matches expected Codex Responses body for system, messages, and tools.
- Prepared headers include bearer token, ChatGPT account id, beta header, and SSE accept header.
- Streaming text/reasoning chunks produce lifecycle events.
- Streaming function-call arguments produce raw tool input deltas and final parsed `tool-call`.
- Response failure events fail with `LLMError`.
- Successful fixture streams end with exactly one final `finish`.

**Verification:**

- `bun test packages/llms/test/openai-codex.test.ts`
- `bun run typecheck`
- `bun run format:check`

**Commit:**

```bash
git add "packages/llms/src/protocols/openai-codex-responses.ts" "packages/llms/test/fixtures/openai-codex-events.ts" "packages/llms/test/openai-codex.test.ts"
git commit -m "feat: add openai codex protocol"
```

## Task 10: Add Anthropic And OpenAI Codex Provider Facades

**Objective:** Add the remaining provider facades now that their protocols exist.

**Files:**
- Create: `packages/llms/src/providers/openai-codex.ts`
- Create: `packages/llms/src/providers/anthropic.ts`
- Modify: `packages/llms/src/providers/index.ts`
- Modify: `packages/llms/test/provider-facades.test.ts`

**Implementation requirements:**

- `OpenAICodex.configure({ credentialResolver, baseURL?, headers?, originator? }).model(modelId)`
  - default `baseURL`: `https://chatgpt.com/backend-api`
  - `credentialResolver` returns `{ accessToken, accountId }`
  - optional env fallback accepts `OPENAI_CODEX_ACCESS_TOKEN`, but only if the provider can derive `accountId` from the token; otherwise fail with `auth-failed`
  - do not couple this provider to OpenAI API-key auth or OpenAI-compatible Chat Completions
  - exports typed `OpenAICodex.options(input)` helper for Responses-specific reasoning options such as `{ reasoning: { effort, summary } }`
  - mirrors Tau's separation between `OpenAICompatibleProvider` and `OpenAICodexProvider`
- `Anthropic.configure({ apiKey?, baseURL?, headers?, maxTokens? }).model(modelId)`
  - default `baseURL`: `https://api.anthropic.com/v1`
  - env fallback: `ANTHROPIC_API_KEY`
  - default `maxTokens`: `4096`
  - exports typed `Anthropic.options(input)` helper for Anthropic-specific request options supported by the selected model; do not expose common sampling knobs through `GenerationOptions`

**Tests:**

- `OpenAI` and `OpenAICodex` produce different provider ids, endpoints, auth headers, and protocols.
- `OpenAICodex` uses the supplied credential resolver to prepare bearer and `chatgpt-account-id` headers.
- `OpenAICodex` `OPENAI_CODEX_ACCESS_TOKEN` fallback derives account id from the JWT claim used by Tau; invalid tokens fail with `auth-failed`.

**Verification:**

- `bun test packages/llms/test/provider-facades.test.ts`
- `bun run typecheck`
- `bun run format:check`

**Commit:**

```bash
git add "packages/llms/src/providers/**" "packages/llms/test/provider-facades.test.ts"
git commit -m "feat: add anthropic and codex provider facades"
```

## Task 11: Add Export And Integration Guards

**Objective:** Ensure public exports stay intentional and the package can be consumed by future Swain packages.

**Files:**
- Modify: `packages/llms/src/index.ts`
- Modify: `packages/llms/src/schema/index.ts`
- Modify: `packages/llms/src/providers/index.ts`
- Modify: `packages/llms/src/protocols/index.ts`
- Modify: `packages/llms/src/transport/index.ts`
- Modify: `packages/llms/test/exports.test.ts`

**Implementation requirements:**

- Public root exports:
  - `LLM`
  - `Message`
  - `TextContent`
  - `ReasoningContent`
  - `ToolCallContent`
  - `ToolResultContent`
  - `Tool`
  - `ToolChoice`
  - `LLMEvent`
  - `LLMTurnSummary`
  - `LLMError`
  - relevant request/result types
- Provider exports:
  - `OpenAI`
  - `OpenAICodex`
  - `Anthropic`
  - `OpenAICompatible`
  - `DeepSeek`
  - `ZAI`
- Keep protocol and transport exports available but clearly lower-level.

**Tests:**

- Import every public export path.
- Construct one request from only public exports.
- Construct a user message containing a `ToolResultContent` from only public exports.
- Derive an `LLMTurnSummary` from a synthetic successful event list.
- Confirm internal helper files are not required by public call sites.

**Verification:**

- `bun test packages/llms/test/exports.test.ts`
- `bun test packages/llms/test`
- `bun run typecheck`
- `bun run format:check`

**Commit:**

```bash
git add "packages/llms/src/**/index.ts" "packages/llms/test/exports.test.ts"
git commit -m "test: guard llm public exports"
```

## Task 12: Final Validation And Minimal Docs

**Objective:** Add a short package README and run the full verification set.

**Files:**
- Create: `packages/llms/README.md`
- Create: `packages/llms/scripts/smoke.ts`
- Optionally modify: `README.md` if a root README is desired

**Smoke script requirements:**

- `bun packages/llms/scripts/smoke.ts` runs one real streaming turn per provider whose env key is present, printing the event log; providers without credentials are skipped.
- Manual-only guard against fixture drift; never part of `bun test`.

**README requirements:**

- State that Swain `llms` is protocol-first and SDK-free.
- Show:
  - OpenAI chat example
  - OpenAI Codex / ChatGPT credential-resolver example
  - Anthropic example
  - DeepSeek or Z.AI OpenAI-compatible example
  - streaming event consumption
  - `generateTurn()` collection example
  - `LLMTurnSummary.fromEvents()` example
  - tool-call handling boundary: package emits calls; caller executes tools
  - tool-result history boundary: harness appends tool results as `ToolResultContent` inside the next `UserMessage`
- Document env vars:
  - `OPENAI_API_KEY`
  - `OPENAI_CODEX_ACCESS_TOKEN`
  - `ANTHROPIC_API_KEY`
  - `DEEPSEEK_API_KEY`
  - `ZAI_API_KEY`

**Final verification:**

```bash
bun install
bun run typecheck
bun run format:check
bun test packages/llms/test
```

**Commit:**

```bash
git add "packages/llms/README.md" "packages/llms/scripts/**"
git commit -m "docs: document llm package"
```

## Risks And Tradeoffs

- **Effect platform churn:** `@effect/platform` is pre-1.0 and its `HttpClient` API moves between minors. Pin exactly and keep transport code isolated in `transport/http.ts` so version bumps stay local.
- **Codex endpoint instability:** `https://chatgpt.com/backend-api/codex/responses` is an unofficial, undocumented endpoint; OpenAI can change event shapes, headers, or auth without notice. The protocol is fixture-tested against Tau's observed behavior, so breakage surfaces as runtime `invalid-provider-output` errors, not test failures. Keep the protocol isolated in `protocols/openai-codex-responses.ts` and treat it as best-effort.
- **OpenAI-compatible drift:** DeepSeek/Z.AI compatibility is close enough for the first slice, but provider-specific reasoning fields may differ. Preserve only concrete provider fields that are needed by the common schema or typed provider options.
- **Tool-call JSON assembly:** Streaming tool arguments are partial JSON. Centralize only that assembly/parsing logic in `protocols/tool-input.ts` and test malformed JSON explicitly.
- **Anthropic message constraints:** Anthropic has stricter message/content sequencing than OpenAI Chat. Fail locally with `LLMError` reason `invalid-request` instead of sending a malformed request.
- **Event log correctness:** The event list is the canonical turn output. Enforce ordering in `LLMTurnSummary.fromEvents()` and protocol fixture tests so the harness can derive state without adapter-specific assumptions.
- **Provider errors split:** `ProviderError` is only for nonfatal in-band facts. Fatal failures must fail the Effect channel with `LLMError`; tests should cover this split.
- **No retries yet:** This keeps transport correctness inspectable. Add retry policy only after basic streaming behavior is covered by fixtures.

## Out Of Scope For This Plan

- Multi-turn agent loop
- Local tool execution
- Tool permissioning
- Provider-hosted tool execution/results
- Durable session history
- OAuth login, token refresh, and credential storage
- Provider SDK usage
- Live provider calls in normal tests (the manual smoke script is the only live path)
- Model catalog refresh
- Pricing and cost estimates
- Prompt caching
- Images, audio, embeddings, reranking

## Review Notes (2026-07-03)

Adversarial plan review; scores before -> after: Completeness 3->5, Feasibility 4->5, Scope 4->5, Testability 4->5, Risk 4->5, Assumptions 4->5.

- Verified: all pinned dep versions exist and are current latest on npm; Tau `openai_codex.py` exists and every Codex SSE event name/header matches; JWT account-id claim is `https://api.openai.com/auth` -> `chatgpt_account_id` (`tau_coding/oauth.py`).
- Transport uses `@effect/platform` `HttpClient`/`HttpClientResponse` instead of raw `fetch`; callers provide `FetchHttpClient.layer`.
- Cancellation is Effect interruption; `aborted` removed from `LLMErrorReason`.
- `FinishReason` enumerated (`stop | length | tool-call | content-filter | refusal | unknown`) with per-provider lowering.
- `http`/`HttpOptions` dropped from `LLMRequest` (YAGNI); `bunfig.toml` dropped (unneeded).
- Tasks reordered for a tracer slice: OpenAI-compatible facades (Task 6) + turn wiring (Task 7) land before Anthropic/Codex protocols; remaining facades moved to Task 10.
- `format`/`format:check` now run biome (pinned `2.5.2`); typechecking moved to a dedicated `typecheck` script (`tsc --noEmit`).
- Added manual live smoke script (Task 12) as the only live-call path; added Codex unofficial-endpoint risk; corrected the Anthropic sampling assumption.
- WebSocket or bidirectional transports
