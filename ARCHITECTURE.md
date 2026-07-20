# Architecture

Swain is organized as a Bun workspace of Effect.js packages:
- `@swain/llms`: LLM provider library implementing a provider-neutral LLM interface, streaming deltas, message protocol normalization, and shared transport.
- `@swain/core`: the core agent harness, comprising the agentic loop, session state, tools, memory, permissions, and model routing.
- `@swain/tui`: Ink-based interactive CLI for running the core agent loop; manages provider connections, slash commands, file search, and more.

## Tech stack

- Bun
- TypeScript (ESM)
- Effect.js
- Biome
- Bun test runner

## packages/llms

A protocol-first LLM provider library. It owns exactly one provider turn: encode a provider-neutral request, stream the provider's response, and decode it into a provider-neutral event stream. Agent loops, tool execution, retries, and persistence belong to a future harness package.

### Layers

```
callers (harness, scripts)
      │  LLM.streamTurn / LLM.generateTurn
      ▼
schema/      provider-neutral data model: messages, tools, events,
             errors, options, branded IDs, labs, providers
      ▼
models/      per-lab model cards: provider-native model IDs and each
             model's effort/variant vocabulary (anthropic, openai,
             deepseek, zai, kimi)
      ▼
providers/   facades binding auth, endpoints, defaults, and model IDs
             (OpenAI, OpenAICompatible, DeepSeek, ZAI, Kimi, Anthropic, OpenAICodex)
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
- **Lab vs provider:** a `Lab` (who trains a model) is distinct from a `Provider` (who serves it); one model can be reachable through several providers — e.g. `gpt-5.5` via both `openai` and `openai-codex`. Shared `Lab`/`Provider` enums live in `schema/`; per-lab model cards in `models/`.
- **Reasoning/effort is wired per protocol:** effort variants encode real request fields, not inert catalog rows — Anthropic adaptive thinking (`low`/`medium`/`high`/`xhigh`/`max`, non-default sampling params dropped), DeepSeek/Z.ai top-level `thinking` flag + `reasoning_effort` (`high`/`max`), Codex native `low`/`medium`/`high`, Kimi K3 `reasoning_effort: "max"` only (no graded ladder) via `https://api.moonshot.ai/v1`.
- **Preserved reasoning (Kimi K3):** canonical `ReasoningContent` is the provider-neutral session representation, persisted in `messages.jsonl` and always hidden from the TUI. An opt-in OpenAI Chat lowering profile (`reasoningHistory: "reasoning_content"`, `maxTokensField: "max_completion_tokens"`) replays each assistant message's reasoning as Kimi's message-level `reasoning_content`; other protocols omit foreign reasoning rather than fabricating a native form (Anthropic thinking is signed, so it cannot be forged). K3 therefore receives all reasoning retained in its projected context — its own and any prior model's — for every message still present after compaction; folded turns and their reasoning are dropped, so this is not the full historical reasoning over a long session. Reasoning is never converted to visible text. Compaction runs on K3 exactly like any model (retained messages keep their `reasoning_content`; folded turns are dropped); because Moonshot flags cross-turn reasoning loss as risky, a K3 session surfaces a `compaction-warning` `AgentEvent` each time it compacts, but compaction is never blocked.
- **HttpClient via requirements:** callers provide `FetchHttpClient.layer` (or a stub layer in tests) at the edge; no network in unit tests.

## packages/core

The core agent harness. It runs the "LLM turn → tool results → next turn" loop over an in-memory session, calling `@swain/llms/client` (a thin injectable `LLMClient` service over the `LLM` namespace).

`core` owns session state, system prompt assembly, message history, tool registration/execution, permissions, and file-state safety. It is headless; a TUI is deferred.

### Key decisions

- **Effect-native tools:** each `Tool` carries Effect Schema input/output schemas and a `call()` returning an Effect; dependencies (`FileSystem`, `CommandExecutor`, `HttpClient`, `ToolContext`) are requirements provided by layers. `@effect/platform-bun`'s `BunContext` provides live `FileSystem`/`CommandExecutor` at runtime; tests swap stubs.
- **Permissions:** `plan | ask | auto`. `plan` denies mutating tools, `ask` (default) prompts before edits/writes/risky shell, `auto` runs validation and hard-deny checks without interactive approval.
- **File safety:** an in-memory `FileStateCache` enforces read-before-write, staleness detection (mtime + digest), and per-path write serialization. It is never persisted; restarts force fresh reads.
- **Built-in tools:** `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch`, `WebSearch` (Exa-backed, provider-neutral), `Ask`, the task tools (`TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`), `Agent`, and `SwitchModel` (routing control flow). Search shells out to ripgrep.
- **Persistence:** session metadata, transcript, and the task graph (`tasks.json`) persist under `<sessionsDir>/<id>/` (the TUI resolves this to `${XDG_CONFIG_HOME:-~/.config}/swain/sessions/<project-slug>/`); runtime cache, locks, and pending approvals do not.
- **Runtime benchmarking:** persisted rows carry local-only, provider-invisible timing for eval analysis: a UTC wall-clock `createdAt` commit timestamp plus durations in numeric milliseconds from a monotonic clock. Every committed message has a required `createdAt`. Each committed assistant response records `responseDurationMs` (provider-response latency including failed attempts and retry backoff; copied onto the meta message a model switch or compaction replaces it with). The final assistant response of a successful `runTurn` additionally records `turnDurationMs` — whole-turn latency from `runTurn` entry, so it aggregates preflight compaction, retries, approvals, and tools, and is *not* comparable to `responseDurationMs`. Selected synchronous tools (`WebSearch`, `WebFetch`) record `callTool` latency as `ToolResultContent.durationMs`; unflagged tools carry none (absence means "not instrumented"). Terminal delegated tasks record child-run `durationMs` in `tasks.json`, measuring the subagent run itself rather than worktree setup/cleanup. Interrupted/failed turns fabricate no durations; historical sessions are discarded rather than migrated (`createdAt` is required at decode).
- **Tasks & subagents:** `TaskStore` is a per-session persisted task graph the main loop uses directly as a to-do list. `Agent` claims a task and forks a detached subagent (`Explore`, `Plan`, `GeneralPurpose`) via the `Orchestrator`; children run a fresh brief with a restricted tool registry (never `Agent`/`Ask`/`Task*`) and report only their final result. Completion is durable-before-visible: the child writes its result to the task, then rings a contentless wake-up queue; the TUI drains completions between parent turns as synthetic `<task-notification>` user messages. V1 subagents must not mutate the parent worktree — `Explore`/`Plan` are read-only, and write-capable `GeneralPurpose` runs in an isolated git worktree under `<git-root>/.swain/worktrees/<agent-id>`.
- **Model routing:** the effective model is session-local state (`SystemContext.modelRef` + write-only `pastModels`), decoupled from the TUI's global default so auto-routing never mutates it. `runTurn` reads request options from the session each iteration. `SwitchModel` is a model-visible tool that core intercepts as *control flow*, not an ordinary tool result: it resolves the target, replaces request options wholesale (never merged), sanitizes the switching assistant message (retaining its reasoning/text, dropping every tool-call so no orphan `tool_result` is owed), records a typed `model-switch` meta transcript event, reassembles the system prompt, and continues the same user turn on the new model — at most one switch per turn, siblings dropped. Switching into K3 replays the prior model's canonical reasoning as `reasoning_content`; Moonshot warns that cross-model continuation into K3 may still be quality-unstable even when the wire history is complete (Swain guarantees serialization correctness, not model quality). Targets are `provider:modelId[:variant]` strings resolved through an injected `ModelResolver` so core stays catalog-agnostic (TUI owns the catalog). The router prompt block is injected only when routing is active and asks the model to classify each request into a tier (Simple/Routine/Complex/Critical) and pick by capability vs cost. `Agent.model` optionally delegates a subagent to an enabled target; omitted, the child inherits the parent's current model.

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
- **Global typed config, split secrets:** settings, the active model, and router config live in `${XDG_CONFIG_HOME:-~/.config}/swain/config.json`, while provider credentials live in a separate `auth.json` beside it (both dir `0700`, file `0600`), validated with Effect Schema. `saveConfig` never writes credentials, so `config.json` stays secret-free (safe to track in dotfiles); legacy keys in an older `config.json` are migrated into `auth.json` on startup. `models.ts` owns the static lab/provider/model/variant catalog (consuming the `@swain/llms` enums and model cards), attaches per-target `RoutingProfile` metadata (`capability`, `avgCostPerTask`), and lowers variants to `providerOptions`. Session/transcript persistence stays project-local under `.swain/sessions/<id>/`.
- **Model router UI & policy:** `router.ts` owns target IDs, opt-out–based config (`RouterConfig`: a global toggle plus `disabledModels`/`disabledTargets`), and derivation of enabled targets. Connected models default to routable with all catalog variants; `routerStatus` is `off`/`inactive` (fewer than two enabled targets)/`on`. Only Pareto-non-dominated targets with routing data reach the model — `routerPromptTargets` filters the enabled set through `paretoFrontier` (drop any target another dominates on capability≥/cost≤). `/router` opens a model-first dialog (`RouterDialog`) for toggling models/variants; the status line shows the minimal router state; the TUI provides core's `ModelResolver` layer bridging target IDs to live models.
- **Interaction bridges:** the TUI-backed `AskService` and `ApprovalService` suspend the tool Effect and resolve once the `QuestionPrompt`/`PermissionPrompt` submits.