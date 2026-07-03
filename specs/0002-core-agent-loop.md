# Core Agent Loop Implementation Plan

> Use subagents to implement this plan task-by-task.

**Goal:** Add `packages/core` alongside `packages/llms` to run a minimal Effect-native agent loop with built-in tools (including an Exa-backed web search tool), permission checks, in-memory session state, file read/write safety, and a deterministic test harness.

**Architecture:** `@swain/llms` remains the provider-turn package. Add `@swain/llms/client` as a thin Effect service layer over the existing `LLM` namespace, then build `@swain/core` on top of that client. `core` owns session state, system prompt assembly, message history, tool registration/execution, permissions, file state, and the repeated “LLM turn -> tool results -> next turn” loop.

**Tech Stack:**
- Bun
- TypeScript ESM
- Effect
- `@effect/platform` (interfaces: `FileSystem`, `Command`, `CommandExecutor`, `HttpClient`)
- `@effect/platform-bun` (`BunContext` — live `FileSystem`/`CommandExecutor` runtime layer)
- `@swain/llms`
- ripgrep (`rg`) for grep/glob filesystem search
- `diff` for edit diff generation
- Bun test runner

---

## Current Context / Assumptions

- Existing `@swain/llms` owns exactly one provider turn. It exposes provider-neutral messages, tools, events, `LLM.streamTurn`, `LLM.generateTurn`, and `LLMTurnSummary.fromEvents`.
- Existing architecture explicitly leaves agent loops, tool execution, permissions, retries, and persistence to a future harness package.
- This phase creates that harness as `packages/core`, but intentionally keeps it headless. `packages/tui` is deferred.
- Tool input validation uses Effect Schema.
- `FileStateCache` is in-memory only. On session restart, conversation history may be loaded from disk, but file freshness must be re-established through fresh reads.
- Native non-text file content is out of scope. `Read` reports image/PDF/binary metadata with `supported: false` and omits contents.
- Multi-agent orchestration is out of scope. Do not implement `Agent`, subagent permission bubbling, background tasks, or task-list tools in this phase.

## Key Decisions

- **LLM client layer lives in `llms`:** Add `packages/llms/src/client.ts` with `LLMClient.Service`, `LLMClient.layer`, `LLMClient.streamTurn`, and `LLMClient.generateTurn`. It is a thin injectable facade over the current `LLM` namespace.
- **Core package exports are narrow:**
  - `@swain/core`: main agent/session API: create session state, submit prompts, run turns, assemble system prompt, expose core errors/events.
  - `@swain/core/tools`: `Tool` interface, built-in tool registry, tool result helpers, and one export per model-callable built-in tool.
  - `@swain/core/permission`: `PermissionMode`, `PermissionService`, permission decisions, and default permission layer.
- **Permission modes:** expose exactly `plan | ask | auto`.
  - `plan`: deny mutating tools. Allow read/search-style tools after validation.
  - `ask`: default. Allow read/search-style tools. Ask before file edits/writes and risky shell commands.
  - `auto`: no interactive approval, but still run schema validation, tool-specific validation, workspace/path checks, and hard denies.
- **Edit input:** `Edit` takes exact replacement input only: `path`, `oldText`, `newText`, optional `replaceAll`. Unified diff/structured patch is derived output, not input.
- **Write semantics:** `Write` creates new text files only and fails if the file already exists. Existing files are changed with `Edit`.
- **Web:** implement `WebFetch` as a direct HTTP fetch tool. Implement `WebSearch` with a provider interface and Exa as the first provider through direct HTTP calls. Do not use Exa SDK. Tests stub `HttpClient`.
- **Persistence:** persist session metadata and transcript; do not persist `FileStateCache`, locks, pending approvals, or in-flight tool calls.

## Package Layout

```text
packages/
  llms/
    src/
      ...
      client.ts
      index.ts
  core/
    package.json
    tsconfig.json
    src/
      index.ts
      agent.ts
      prompt.ts
      permission.ts
      errors.ts
      state/
        index.ts
        session.ts
        store.ts
      tools/
        index.ts
        tool.ts
        registry.ts
        results.ts
        read.ts
        write.ts
        edit.ts
        glob.ts
        grep.ts
        bash.ts
        ask.ts
        web-fetch.ts
        web-search/
          index.ts
          tool.ts
          exa.ts
      files/
        paths.ts
        diff.ts
        media.ts
    test/
      utils/
        fixtures.ts
        harness.ts
      agent.test.ts
      tools-filesystem.test.ts
      permissions.test.ts
      web-exa.test.ts
```

## Public API Sketch

### `@swain/llms/client`

```ts
export interface LLMClient {
  readonly request: typeof LLM.request
  readonly streamTurn: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  readonly generateTurn: (request: LLMRequest) => Effect.Effect<LLMResponse, LLMError>
}

export class Service extends Context.Service<Service, LLMClient>()("@swain/LLMClient") {}

export const layer: Layer.Layer<Service, never, HttpClient.HttpClient>
```

### `@swain/core/tools`

```ts
export interface Tool<Input, Output, ExtraRequirements = never> {
  readonly name: string
  readonly description: string
  readonly inputSchema: Schema.Schema<Input, unknown>
  readonly outputSchema: Schema.Schema<Output, unknown>
  readonly readOnly: boolean
  readonly call: (input: Input) => Effect.Effect<Output, ToolError, ExtraRequirements | ToolContext>
}

export interface ToolContext {
  readonly session: SessionState
  readonly abortSignal: AbortSignal
  readonly permission: PermissionService
}

export interface ToolCaller {
  readonly call: (toolCall: ToolCall) => Effect.Effect<ToolResultContent, ToolError, ToolContext>
}

export const toLLMTool: (tool: Tool<unknown, unknown, unknown>) => LLMTool
```

Each tool has an Effect Schema for inputs and outputs. `toLLMTool` converts a callable `@swain/core` `Tool` into a non-callable `@swan/llms` tool definition.

When the model calls a tool, `ToolCaller` decodes the raw input, applies the coarse permission gate (`plan` denies non-read-only tools), calls `tool.call()`, validates the returned value against `outputSchema`, and sends the validated result back to the model as `ToolResultContent`.

`ToolContext` is an Effect service provided by the agent runner while executing tools. `session` includes the working directory, file cache, message state, counters, and per-file locks. `permission` lets tools ask for approval after they have enough context to explain the request, such as an `Edit` diff or a `Bash` command. `abortSignal` lets shell/network tools stop when the turn is interrupted.

### `@swain/core/permission`

```ts
export type PermissionMode = "plan" | "ask" | "auto"
export type PermissionDecision =
  | { readonly type: "allow" }
  | { readonly type: "deny"; readonly reason: string }
  | { readonly type: "ask"; readonly reason: string }
```

### `Edit`

Input:

```ts
type EditInput = {
  readonly path: string
  readonly oldText: string
  readonly newText: string
  readonly replaceAll?: boolean
}
```

Result:

```ts
type EditResult = {
  readonly path: string
  readonly oldText: string
  readonly newText: string
  readonly replaceAll?: boolean
  readonly replacements: number
  readonly diffs: ReadonlyArray<{
    readonly format: "unified"
    readonly text: string
    readonly truncated: boolean
  }>
}
```

## System Prompt Assembly

Add `assembleSystemPrompt(input)` function in `packages/core/src/prompt.ts`. For this phase, it should be a pure function that returns a single string built from:

- identity: "You are Swain, an agentic coding assistant."
- workspace: current working directory
- current date
- model
- permission mode
- available tools

For now, available tools should be rendered as a stringified list of names and descriptions, derived from the registered `core` built-in tools:

```ts
const toolList = tools.map((tool) => ({
  name: tool.name,
  description: tool.description,
}))
```

The template can be simple:

```ts
`You are Swain, an agentic coding assistant that helps users with software engineering tasks. You and the user share the same working directory. 

Use the context and available tools to assist the user. Ask clarifying questions if needed. Respect the active permission mode.

<context>
Working directory: ${workingDirectory}
Current date: ${currentDate}
Model: ${model}
Permission mode: ${permissionMode}
</context>

Available tools:
${JSON.stringify(toolList, null, 2)}
`
```

Note full tool schemas are sent through the `@swain/llms` `tools` request field via `toLLMTool`, which is the model-facing invocation contract. Do not duplicate them in the system prompt.

Defer section caching, custom prompt precedence, memory, environment summaries, MCP instructions, and prompt-cache boundaries. Keep the implementation as a pure function so later phases can split it into sections without changing the agent loop.

## Built-In Tools

- `Read`: read text file contents. For non-text files, return metadata with `supported: false`.
- `Write`: create a new text file. Fails if the file already exists.
- `Edit`: exact text replacement in an existing text file.
- `Glob`: list files matching a pattern using ripgrep/file traversal.
- `Grep`: content search using `rg`.
- `Bash`: execute an approved shell command.
- `WebSearch`: provider-neutral search, backed by Exa initially.
- `WebFetch`: direct HTTP fetch/content extraction for a provided URL.
- `Ask`: ask one or more multiple-choice questions to clarify intent.

Deferred tools:

- `Agent`, `ExploreAgent`, `PlanAgent`
- `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`, `TaskStop`
- native image/PDF file reads
- patch/unified-diff input tool

## FileStateCache Rules

`FileStateCache` is an in-memory cache of local file contents the model has seen. It enforces three safety invariants:

- **Read before write:** if there is no cache entry for an existing file, the model must read the file before editing it.
- **Staleness detection:** if a file changed since the last read, based on last modified timestamp and content digest, the model must read it again before editing.
- **Single writer in this process:** writes and edits are serialized per absolute path within the current Swain process, and the cache is refreshed after each successful write. External writes are detected by the freshness check before writing; cross-process locking is deferred.

Implement it as a plain `Map` keyed by normalized absolute paths. No size/byte caps and no eviction in this phase: a headless session touches few files, so unbounded growth is not a concern yet. This is safe to extend later because a missing entry already makes `Edit` fail read-before-write and forces a re-read; adding an LRU cap is a localized change behind the same `Map` interface. Defer eviction/caps until a long-running session shows real memory pressure.

Store text file entries in memory:

```ts
type FileStateEntry = {
  readonly path: string
  readonly kind: "text"
  readonly lastModifiedMs: number
  readonly digest: string
  readonly content: string
}
```

- `Read` stores a cache entry for text files.
- `Edit` requires a cache entry and the file must still match the cached last modified timestamp/content digest.
- If the file changed after the last read, `Edit` fails and tells the model to read again.
- `Write` may create a new file without a cache entry, but only if the target does not exist.
- Writes and edits are serialized per absolute path with a keyed lock.
- After successful `Write` or `Edit`, update cache from disk.
- Non-text reads may record metadata for user visibility, but they do not satisfy edit freshness.
- Defer persistence, clone/merge helpers, cross-process file locks, and cache eviction/size caps.

## Step-By-Step Plan

### Task 1: Add tool output schemas to `@swain/llms`

**Objective:** Extend the model-facing `@swain/llms` tool definition with optional output schema support.

**Files:**
- Modify: `packages/llms/src/schema/messages.ts`
- Modify: `packages/llms/src/index.ts`
- Test: `packages/llms/test/schema.test.ts`
- Test: `packages/llms/test/exports.test.ts`

**Implementation notes:**
- Add optional `outputSchema` to the existing `Tool` schema.
- Keep `inputSchema` required.
- Update `Tool.define(...)` to preserve `outputSchema` when provided.
- Additive and backward compatible: `outputSchema` is optional, existing `Tool.define` callers are unaffected, and provider serialization (which reads `inputSchema`) ignores the new field.
- Do not add executable tool behavior to `llms`.

**Verification:**
- `Tool.define` accepts and preserves `outputSchema`
- `@swain/llms` exports the updated `Tool` type

**Commit:** `feat: add llm tool output schema`

### Task 2: Add `LLMClient` to `@swain/llms`

**Objective:** Make existing LLM turn functions injectable without changing provider behavior.

**Files:**
- Create: `packages/llms/src/client.ts`
- Modify: `packages/llms/src/index.ts`
- Test: `packages/llms/test/client.test.ts`

**Implementation notes:**
- `LLMClient.layer` depends on `HttpClient.HttpClient`.
- Service methods call existing `LLM.request`, `LLM.streamTurn`, `LLM.generateTurn`.
- Tests should use the existing fixture-backed `HttpClient` layer.

**Verification:**
- `bun test packages/llms/test/client.test.ts`
- `bun run --cwd packages/llms typecheck`

**Commit:** `feat: add llm client layer`

### Task 3: Scaffold `packages/core`

**Objective:** Create the package, exports, test runner config, and workspace scripts.

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`

**Implementation notes:**
- Depend on pinned exact versions of `effect`, `@effect/platform`, `@effect/platform-bun`, and `@swain/llms`.
- `@effect/platform-bun` supplies the `BunContext` layer that provides live `FileSystem` and `CommandExecutor`; the agent runtime provides it, tests may swap in stub layers.
- Add exact-pinned `diff` for unified diff generation.
- Do not add provider SDKs.
- Root scripts should verify both `llms` and `core`.

**Verification:**
- `bun run typecheck`
- `bun run format:check`

**Commit:** `chore: scaffold core package`

### Task 4: Define session state and prompt assembly

**Objective:** Add in-memory state and deterministic system prompt assembly.

**Files:**
- Create: `packages/core/src/state/index.ts`
- Create: `packages/core/src/state/session.ts`
- Create: `packages/core/src/prompt.ts`
- Test: `packages/core/test/agent.test.ts`

**Implementation notes:**
- State includes `sessionId`, `workingDirectory`, `systemContext`, `fileState`, `messages`, and analytics counters. Prompt queuing is deferred (no concurrent submit/cancel in this phase); `submitPrompt` appends directly.
- Prompt assembly should include identity, working directory, current date, permission mode, and a stringified list of available tool names/descriptions.
- Keep prompt assembly pure and unit-tested.

**Verification:**
- prompt output changes when tools/permission mode change
- prompt output includes tool names and descriptions
- prompt output is stable for identical input

**Commit:** `feat: add core session state`

### Task 5: Define tool interface, caller, and registry

**Objective:** Add the callable `core` `Tool` interface, `ToolCaller`, Effect Schema validation pipeline, and conversion to `@swain/llms` tool definitions.

**Files:**
- Create: `packages/core/src/tools/tool.ts`
- Create: `packages/core/src/tools/registry.ts`
- Create: `packages/core/src/tools/results.ts`
- Create: `packages/core/src/tools/index.ts`
- Test: `packages/core/test/agent.test.ts`

**Implementation notes:**
- Registration should be Effect-native: `ToolRegistry` is a `Context.Tag` service backed by a map of tool name to `Tool`.
- `toLLMTool` should live in `packages/core/src/tools/tool.ts`; it adapts one registered core tool to an `@swain/llms` tool definition.
- `ToolCaller` should live in `packages/core/src/tools/tool.ts`; it calls a selected tool call from the registry.
- Tools are plain values whose `call()` returns an Effect. Tool dependencies are requirements in the Effect environment and are provided by layers.
- Validation order: input schema decode, coarse permission gate, `call()`, output schema decode.
- Tool-specific preconditions should live in the input schema when pure, or fail from `call()` with `ToolError` when they require filesystem/network/session state.
- Unknown tool calls, input-decode failures, and output-decode failures all surface to the model as an error tool result (`ToolResultContent` with `isError: true`) so it can recover, rather than failing the turn. Hard denies and permission `deny` decisions likewise return an error tool result.
- Tool execution output maps to `ToolResultContent` in the next `UserMessage`.

**Verification:**
- invalid input never reaches `call`
- invalid output fails before being returned to the model
- tool result is appended as `ToolResultContent`

**Commit:** `feat: add core tool registry`

### Task 6: Implement permissions

**Objective:** Add `plan`, `ask`, and `auto` behavior for tool calls.

**Files:**
- Create: `packages/core/src/permission.ts`
- Test: `packages/core/test/permissions.test.ts`

**Implementation notes:**
- `plan` denies `Write`, `Edit`, and `Bash`.
- `ask` allows read-only tools and asks for writes/edits/risky shell commands.
- `auto` allows without interactive approval after validation and hard-deny checks.
- Implement approval as an injectable service so tests can auto-allow/deny.
- Do not implement subagent bubbling.

**Verification:**
- plan mode blocks writes/edits/bash
- ask mode asks for write/edit
- auto mode skips approval but not validation

**Commit:** `feat: add permission modes`

### Task 7: Implement file tools and cache

**Objective:** Add `Read`, `Write`, `Edit`, `Glob`, and `Grep` with cache freshness and per-file write locks.

**Files:**
- Create: `packages/core/src/files/paths.ts`
- Create: `packages/core/src/files/diff.ts`
- Create: `packages/core/src/files/media.ts`
- Modify: `packages/core/src/state/session.ts`
- Create: `packages/core/src/tools/read.ts`
- Create: `packages/core/src/tools/write.ts`
- Create: `packages/core/src/tools/edit.ts`
- Create: `packages/core/src/tools/glob.ts`
- Create: `packages/core/src/tools/grep.ts`
- Test: `packages/core/test/tools-filesystem.test.ts`

**Implementation notes:**
- `Read`/`Write`/`Edit` go through Effect `FileSystem`; `Glob`/`Grep` (and `Bash`) shell out via `Command`/`CommandExecutor`. Both are provided by `BunContext` at runtime and stubbed in tests.
- Use workspace path normalization and reject path escapes.
- Use `rg` for `Grep`.
- Use ripgrep-backed file listing for `Glob` where practical.
- Use `diff` to derive unified diff text from before/after contents.
- `Edit` mirrors Claude Code conceptually: exact `oldText`/`newText`, optional `replaceAll`, uniqueness required unless `replaceAll` is true.
- `Write` creates text files only and fails if the path exists.

**Verification:**
- read before edit is required
- stale file edit fails
- successful edit updates cache
- write existing file fails
- non-text read returns `supported: false`
- concurrent edits to same path are serialized

**Commit:** `feat: add filesystem tools`

### Task 8: Implement shell tool

**Objective:** Add `Bash` with permission checks and bounded execution.

**Files:**
- Create: `packages/core/src/tools/bash.ts`
- Test: `packages/core/test/permissions.test.ts`

**Implementation notes:**
- Execute from `workingDirectory`.
- Capture stdout/stderr and exit code.
- Add timeout and output truncation.
- Use a small hard-deny set for obviously dangerous commands; keep richer shell parsing for a later spec.

**Verification:**
- safe command runs in `ask` mode
- risky command asks in `ask` mode
- risky command runs in `auto` only if not hard-denied
- hard-denied command never runs

**Commit:** `feat: add bash tool`

### Task 9: Implement web fetch and Exa-backed search

**Objective:** Add direct `WebFetch` and provider-backed `WebSearch`, with Exa as the first search provider.

**Files:**
- Create: `packages/core/src/tools/web-fetch.ts`
- Create: `packages/core/src/tools/web-search/index.ts`
- Create: `packages/core/src/tools/web-search/tool.ts`
- Create: `packages/core/src/tools/web-search/exa.ts`
- Test: `packages/core/test/web-exa.test.ts`

**Implementation notes:**
- Exa search endpoint: `POST https://api.exa.ai/search` (verified against Exa docs 2026-07-03).
- Auth via `EXA_API_KEY`, sent as `x-api-key`.
- Request body: `query` (required, string) plus optional neutral `numResults`. Response: `{ requestId, results[], costDollars }` where each result has `title`, `url`, `text`, `highlights`, `publishedDate`, `author`, `id`. Map these to the provider-neutral result shape.
- `WebSearch` input stays provider-neutral; Exa-specific knobs (`type`, `contents`, `category`, domain/date filters) go under `providerOptions.exa`. If Exa's contract changes, only `exa.ts` changes — `WebSearch`/`tool.ts` stay provider-neutral.
- `WebFetch` uses `HttpClient` directly to fetch the requested URL, returns extracted text for supported text-like responses, and caps/truncates output.
- Tests stub `HttpClient`; no live Exa calls in unit tests.

**Verification:**
- Exa search request body matches Exa docs
- Exa search response maps to provider-neutral results
- WebFetch returns text for text/html or text/plain responses
- missing API key fails with typed error

**Commit:** `feat: add exa web tools`

### Task 10: Implement `Ask`

**Objective:** Add user clarification as an injectable interaction service.

**Files:**
- Create: `packages/core/src/tools/ask.ts`
- Test: `packages/core/test/agent.test.ts`

**Implementation notes:**
- Input supports one or more multiple-choice questions.
- Execution delegates to an injectable approval/interaction service.
- Test harness returns deterministic answers.

**Verification:**
- model tool call produces selected answers as a tool result

**Commit:** `feat: add ask tool`

### Task 11: Add testing harness

**Objective:** Provide deterministic harness utilities so the agent loop lands with a working end-to-end test slice (no TUI).

**Files:**
- Create: `packages/core/test/utils/fixtures.ts`
- Create: `packages/core/test/utils/harness.ts`
- Test: `packages/core/test/agent.test.ts`

**Implementation notes:**
- Fake LLM emits scripted event sequences.
- Fake approval service records asks and returns configured decisions (reuses the injectable approval service from Task 6).
- Fake web service returns configured search/fetch results (reuses the web tool interfaces from Task 9).
- Temporary workspace helper creates files and inspects output; provides stub `FileSystem`/`CommandExecutor` (or a real `BunContext` against a temp dir) for filesystem/shell tests.

**Verification:**
- harness can drive a prompt through LLM -> tool -> LLM completion without network

**Commit:** `test: add core agent harness`

### Task 12: Implement the agent loop

**Objective:** Wire prompt assembly, `LLMClient`, tool execution, and message history into the minimal loop, verified end-to-end with the Task 11 harness.

**Files:**
- Create: `packages/core/src/agent.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/agent.test.ts`

**Implementation notes:**
- `submitPrompt` appends a user message.
- `runTurn` calls `LLMClient.streamTurn`, collects events, derives `LLMTurnSummary`, appends assistant content, executes tool calls, appends tool result user message, and repeats until finish reason is not `tool-call`.
- Include a max-iterations guard to prevent infinite tool loops.
- Update token/model usage counters from `finish.usage` (optional on `Finish`; skip when absent).

**Verification:**
- one text-only fake LLM turn appends assistant message
- fake tool-call turn executes tool and submits result to the next LLM turn
- max tool-loop guard fails with typed error

**Commit:** `feat: add core agent loop`

### Task 13: Add session persistence

**Objective:** Persist transcript and restart metadata without persisting runtime cache.

**Files:**
- Create: `packages/core/src/state/store.ts`
- Test: `packages/core/test/agent.test.ts`

**Implementation notes:**
- Store under `.swain/sessions/<sessionId>/`.
- Persist `session.json` and `messages.jsonl`.
- Load messages and metadata on restart.
- Do not persist `FileStateCache`; after restart edits require fresh reads.

**Verification:**
- saved transcript reloads into memory
- reloaded session has empty file cache

**Commit:** `feat: persist core sessions`

## Verification

Run before claiming implementation complete:

```bash
bun run typecheck
bun run format:check
bun test packages/llms/test
bun test packages/core/test
```

Manual smoke, once implemented:

```bash
bun test packages/core/test/agent.test.ts -t "tool-call turn"
```

## Risks / Tradeoffs

- Effect Schema to JSON Schema conversion may be incomplete. Keep first-phase schemas plain and add adapter tests.
- `rg` is an external binary. If absent, `Grep`/`Glob` should fail with a clear typed tool error rather than silently falling back to slower behavior.
- `Bash` safety is intentionally minimal. This phase verifies the permission pipeline, not a complete shell security model.
- Exa is the first web provider, not the web abstraction. Keep provider-specific options isolated.
- Session persistence without file cache is conservative: it forces re-reads after restart, which is correct but may cost extra turns.
- No TUI means manual interactive experience waits for a later spec.
