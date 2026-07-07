# Architecture

Swain is an agent harness for coding. It is organized as a Bun workspace of Effect-native packages:
- `@swain/llms`: LLM provider library
- `@swain/core`: core agent harness (loop, tools, memory, permissions)
- `@swain/tui`: Ink-based interactive CLI over the core loop

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

## packages/tui

An Ink/React interactive CLI over the core loop. It owns terminal state, command parsing, local config/credential storage, model selection, file search, and the approval/question UI, while delegating model turns, tools, sessions, and permissions to `@swain/core` and `@swain/llms`.

### Layers

```
bin/swain.tsx → run()          flag parsing, model resolution, app mount
      ▼
components/ (App, PromptInput, Transcript, StatusLine, overlays,
            ListSelect, QuestionPrompt, PermissionPrompt, pickers)
      │  React-owned transcript/draft state; forwarded AgentEvents
      ▼
controller.ts                  bridges UI actions to Effect programs,
                               forwards each AgentEvent, owns TuiState
      ▼
runtime.ts                     ManagedRuntime over LLMClient + tools +
                               BunContext + TUI Ask/Approval bridges
      ▼
@swain/core (runTurn, sessions, tools, permissions)
```

### Key decisions

- **Core event observer:** `runTurn()` takes an optional `onEvent` observer emitting provider deltas, step boundaries, tool lifecycle, and errors as `AgentEvent`; the `Effect<void>` API and final session mutations are unchanged for headless callers.
- **Tool progress channel:** `callTool` provides a per-call `ToolProgress` service (no-op by default); `Bash` streams stdout as `tool-execution-delta`. Progress is advisory and never persisted.
- **Controller owns state, React owns display:** `TuiState` holds session/model/mode; transcript rows and draft streaming buffers are local React state derived from `session.messages` plus forwarded events.
- **Commands are local:** built-in `/` commands are parsed and executed in the TUI; only `/plan` with args sends a model prompt.
- **Global typed config, split secrets:** settings and the active model live in `${XDG_CONFIG_HOME:-~/.config}/swain/config.json`, while provider credentials live in a separate `auth.json` beside it (both dir `0700`, file `0600`), validated with Effect Schema. `saveConfig` never writes credentials, so `config.json` stays secret-free (safe to track in dotfiles); legacy keys in an older `config.json` are migrated into `auth.json` on startup. `models.ts` owns the static provider/model/variant catalog and lowers variants to `providerOptions`. Session/transcript persistence stays project-local under `.swain/sessions/<id>/`.
- **Interaction bridges:** the TUI-backed `AskService` and `ApprovalService` suspend the tool Effect and resolve once the `QuestionPrompt`/`PermissionPrompt` submits.

Full design record: `specs/0003-tui.md`.
