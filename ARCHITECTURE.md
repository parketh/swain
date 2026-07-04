# Architecture

Swain is an agent harness for coding. It is organized as a Bun workspace of Effect-native packages:
- `@swain/llms`: LLM provider library
- `@swain/core`: core agent harness (loop, tools, memory, permissions)

## packages/llms

A protocol-first LLM provider library. It owns exactly one provider turn: encode a provider-neutral request, stream the provider's response, and decode it into a provider-neutral event stream. Agent loops, tool execution, retries, and persistence belong to a future harness package.

### Layers

```
callers (harness, scripts)
      │  LLM.streamTurn / LLM.generateTurn
      ▼
schema/      provider-neutral data model: messages, tools, events,
             errors, options, branded IDs
      ▼
providers/   facades binding auth, endpoints, defaults, and model IDs
             (OpenAI, OpenAICompatible, DeepSeek, ZAI, Anthropic, OpenAICodex)
      ▼
protocols/   wire-format encode/decode: OpenAI Chat Completions,
             Anthropic Messages, OpenAI Codex Responses; streamed
             tool-input assembly
      ▼
transport/   auth resolution, HTTP via @effect/platform HttpClient,
             SSE parsing
```

### Key decisions

- **SDK-free:** direct HTTP API clients only; no provider SDKs or LLM frameworks.
- **Events are the contract:** protocols normalize provider streams into one `LLMEvent` union (text/reasoning/tool-input lifecycles, `tool-call`, `provider-error`, single final `finish`). `LLMTurnSummary.fromEvents` validates ordering invariants and derives turn state.
- **Errors split:** nonfatal in-band provider facts emit `ProviderError` events; fatal failures fail the Effect channel with typed `LLMError`. Cancellation is Effect interruption, not an error.
- **System prompt boundary:** `system` is a request field; `messages` contain only `user`/`assistant` roles. Tool results are `ToolResultContent` inside the next `UserMessage`.
- **Sampling is provider-specific:** `GenerationOptions` carries only portable knobs (`maxTokens`, `stop`); temperature and friends live in typed `providerOptions`.
- **HttpClient via requirements:** callers provide `FetchHttpClient.layer` (or a stub layer in tests) at the edge; no network in unit tests.

Full design record: `specs/0001-scaffold-llms.md`.

## packages/core

The core agent harness. It runs the "LLM turn → tool results → next turn" loop over an in-memory session, calling `@swain/llms/client` (a thin injectable `LLMClient` service over the `LLM` namespace).

`core` owns session state, system prompt assembly, message history, tool registration/execution, permissions, and file-state safety. It is headless; a TUI is deferred.

### Key decisions

- **Effect-native tools:** each `Tool` carries Effect Schema input/output schemas and a `call()` returning an Effect; dependencies (`FileSystem`, `CommandExecutor`, `HttpClient`, `ToolContext`) are requirements provided by layers. `@effect/platform-bun`'s `BunContext` provides live `FileSystem`/`CommandExecutor` at runtime; tests swap stubs.
- **Permissions:** `plan | ask | auto`. `plan` denies mutating tools, `ask` (default) prompts before edits/writes/risky shell, `auto` runs validation and hard-deny checks without interactive approval.
- **File safety:** an in-memory `FileStateCache` enforces read-before-write, staleness detection (mtime + digest), and per-path write serialization. It is never persisted; restarts force fresh reads.
- **Built-in tools:** `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch`, `WebSearch` (Exa-backed, provider-neutral), `Ask`. Search shells out to ripgrep.
- **Persistence:** session metadata and transcript persist under `.swain/sessions/<id>/`; runtime cache, locks, and pending approvals do not.

Full design record: `specs/0002-core-agent-loop.md`.
