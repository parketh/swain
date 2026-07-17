# Session Runtime Benchmarking Implementation Plan

> Use subagents to implement this plan task-by-task.

**Goal:** Add durable timestamps and response, turn, selected tool, and delegated-subagent durations to session artifacts for benchmarking and eval analysis.

**Architecture:** Extend the provider-neutral message schema with optional local timing metadata, but keep every protocol lowering function explicit so metadata never reaches provider APIs. Core stamps messages when they are committed, measures elapsed work with Effect's monotonic clock, and persists the resulting fields through the existing `messages.jsonl` path. Web tool timing is opt-in on the core tool definition; detached subagent runtime remains one-to-one task metadata in `tasks.json` rather than being forced into the immediate `Agent` spawn response.

**Tech Stack:** Bun workspace, TypeScript ESM, Effect, Effect Schema, `@swain/llms`, `@swain/core`, Bun test runner, Biome.

---

## Decisions

- A provider response is one LLM request/stream cycle. Record `responseDurationMs` on the message representing that committed response.
- A user turn is one successful `runTurn` invocation. Record `turnDurationMs` only on its final assistant message.
- Start `turnDurationMs` at `runTurn` entry. Include preflight compaction, overflow recovery, provider retries/backoff, tool calls, and approval waits.
- Include failed provider attempts and retry backoff in the eventual committed response's `responseDurationMs`.
- Time compaction LLM responses and store `responseDurationMs` on the resulting compaction meta message.
- Use `createdAt` as the message timestamp. It is an ISO-8601 UTC timestamp for transcript commit: user submission for prompts, completion/append time for assistant and tool-result messages.
- Store durations as numeric milliseconds. Fractional milliseconds are allowed; do not round unless Effect's clock already yields an integral value.
- Use this flat persisted contract. These are not new named types; each group lists fields added to an existing schema. `createdAt` is required (every core-created message has it); the duration fields stay optional because their presence is conditional on runtime placement, not on history:

```ts
// Added to both role schemas: UserMessage and AssistantMessage
// (packages/llms/src/schema/messages.ts)
readonly createdAt: string          // required on every persisted message
readonly responseDurationMs?: number // only assistant / response-replacing meta
readonly turnDurationMs?: number     // only final assistant of a successful turn

// Added to ToolResultContent (packages/llms/src/schema/messages.ts)
readonly durationMs?: number         // only tools opted into timing

// Added to Task and TaskSchema (packages/core/src/tasks.ts)
readonly durationMs?: number         // only terminal delegated tasks
```

- `createdAt` is required in the message decode schema; the duration fields remain optional because they are conditionally present. All historical sessions will be deleted before this ships, so the decode schema need not tolerate unstamped legacy rows.
- No backfill or migration. Existing session and task files are discarded, not upgraded.
- Persist response and turn durations only for successful committed responses. Interrupted marker messages receive `createdAt`, but no synthetic response or turn duration. Failed turns with no committed response get no timing record in this phase.
- Ordinary tool timing is opt-in and limited to `WebSearch` and `WebFetch`. Store `durationMs` on their `ToolResultContent` for both successful and error results.
- The timed web-tool interval is the existing `callTool` lifecycle: input decode, permission handling, tool execution, and output validation. Exclude later oversized-result offloading and session persistence.
- `Agent` returns immediately after spawning a detached child, so its tool result must not claim to measure child work. Measure the child runner itself and persist `durationMs` on the terminal delegated task in `tasks.json`, for both completion and failure.
- Keep subagent duration out of task notification text. Notifications can batch several tasks and are model-visible presentation, not structured eval storage.
- Timing metadata is local only. Do not send `createdAt`, `responseDurationMs`, `turnDurationMs`, or `durationMs` to Anthropic, OpenAI Chat, or OpenAI Codex Responses.
- No timing UI, aggregate benchmark report, telemetry sidecar, per-retry metrics, or all-tool instrumentation in this phase.

## Current Context

- `packages/llms/src/schema/messages.ts` defines the `Message` and `ToolResultContent` schemas used both in memory and by session JSONL decoding.
- Provider lowerers already rebuild wire messages field-by-field:
  - `packages/llms/src/protocols/anthropic-messages.ts`
  - `packages/llms/src/protocols/openai-chat.ts`
  - `packages/llms/src/protocols/openai-codex-responses.ts`
- `packages/core/src/state/session.ts` stores `messages: Array<Message>`.
- `packages/core/src/state/store.ts` writes each message directly to `messages.jsonl` and decodes legacy rows with the `Message` schema.
- `packages/core/src/agent.ts` owns prompt submission, interruption repair, provider retries, assistant commits, model-switch replacement, tool execution, and whole-turn completion.
- A router switch replaces the assistant tool-call message with a model-switch meta user message. The replacement must retain that provider response's timing metadata.
- `packages/core/src/context/compaction.ts` performs a separate LLM request and appends a compaction meta user message.
- `packages/core/src/context/tool-result-storage.ts` reconstructs oversized `ToolResultContent`; reconstruction currently copies only identity, result, and error fields.
- `packages/core/src/tool.ts` has no tool capability for timing. `WebSearch` and `WebFetch` are defined in `packages/core/src/tools/web-search/tool.ts` and `packages/core/src/tools/web-fetch.ts`.
- `packages/core/src/orchestrator.ts` forks detached subagent execution and writes terminal state through `completeTask`/`failTask`.
- `packages/core/src/tasks.ts` persists delegated task timestamps but has no precise child-run duration. `createdAt` may predate delegation for an existing task, so deriving runtime from `createdAt`/`updatedAt` is not reliable.

## Data Contract

Newly persisted rows should have these shapes:

```json
{"role":"user","content":[{"type":"text","text":"Investigate this"}],"createdAt":"2026-07-17T10:00:00.000Z"}
{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call-1","name":"WebSearch","input":{"query":"x"}}],"createdAt":"2026-07-17T10:00:01.250Z","responseDurationMs":1250}
{"role":"user","content":[{"type":"tool-result","toolCallId":"call-1","name":"WebSearch","result":{"type":"json","value":{"results":[]}},"durationMs":420}],"createdAt":"2026-07-17T10:00:01.670Z"}
{"role":"assistant","content":[{"type":"text","text":"Done"}],"createdAt":"2026-07-17T10:00:02.000Z","responseDurationMs":330,"turnDurationMs":2000}
```

The decode schema enforces `createdAt`; the remaining runtime invariants below are placement rules the schema does not encode:

- `createdAt` is present on every persisted message and required by the decode schema.
- `responseDurationMs` appears only on assistant messages and response-replacing meta messages such as model switches and compactions.
- `turnDurationMs` appears only on the final assistant message of a successful `runTurn`.
- `ToolResultContent.durationMs` appears only for tools whose core definition opts into timing.
- `Task.durationMs` appears only on terminal delegated tasks timed by the orchestrator.

## Task 1: Extend Timing Schemas Without Changing Provider Requests

**Objective:** Make message, tool-result, and task timing metadata typed while proving it remains local.

**Files:**

- Modify: `packages/llms/src/schema/messages.ts`
- Modify: `packages/core/src/tasks.ts`
- Test: `packages/llms/test/schema.test.ts`
- Test: `packages/llms/test/anthropic-messages.test.ts`
- Test: `packages/llms/test/openai-chat.test.ts`
- Test: `packages/llms/test/openai-codex.test.ts`
- Test: `packages/core/test/tasks.test.ts`

**Steps:**

1. Write failing schema round-trip tests for:
   - a message carrying `createdAt`, `responseDurationMs`, and `turnDurationMs`
   - a tool result carrying `durationMs`
   - a terminal delegated task carrying `durationMs`
   - a message missing `createdAt` fails to decode
2. Add required `createdAt` and optional `responseDurationMs`/`turnDurationMs` fields to both message role schemas. Define the shared field object once so the user/assistant schemas cannot drift. `createdAt` being required means the decode path rejects any unstamped persisted row. Have `Message.user`/`Message.assistant` accept an optional `createdAt` and default it to current UTC at the boundary, so existing in-memory call sites (provider-lowering tests, facades) keep compiling while every persisted message still carries a timestamp.
3. Add optional `durationMs` to `ToolResultContent`.
4. Add optional `durationMs` to `Task` and `TaskSchema`. Do not add it to general `UpdateTaskInput`; only terminal orchestrator completion should write the metric.
5. Add protocol tests that pass fully timed messages/tool results into each `prepare` function and assert the request body is unchanged from an equivalent untimed request. The existing lowerers should require no implementation change because they already select wire fields explicitly.
6. Run:

```bash
bun test packages/llms/test/schema.test.ts packages/llms/test/anthropic-messages.test.ts packages/llms/test/openai-chat.test.ts packages/llms/test/openai-codex.test.ts packages/core/test/tasks.test.ts
```

Expected: timed messages decode, an unstamped message is rejected, and no timing key appears in any provider request body.

## Task 2: Timestamp Core-Committed Session Messages

**Objective:** Ensure every persisted transcript message has a commit timestamp.

**Files:**

- Create: `packages/core/src/state/messages.ts`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/src/context/compaction.ts`
- Modify: `packages/core/src/orchestrator.ts`
- Modify: `packages/core/src/state/store.ts`
- Test: `packages/core/test/agent.test.ts`
- Test: `packages/core/test/compaction.test.ts`
- Test: `packages/core/test/session-models.test.ts`

**Steps:**

1. Write failing tests proving:
   - `submitPrompt` stamps a user message
   - assistant, tool-result batch, interruption, model-switch meta, compaction meta, and synthetic notification messages are stamped at commit
   - save/load preserves explicitly supplied timestamps exactly
2. Add small core-owned constructors/helpers in `packages/core/src/state/messages.ts` that pass `createdAt` and any supplied timing fields through to `@swain/llms` `Message.user`/`Message.assistant`. Accept an explicit ISO timestamp for deterministic call sites/tests and default to current UTC time only at the helper boundary.
3. Replace core persisted-message construction sites with the helpers:
   - `submitPrompt` and `recordInterruption`
   - assistant and tool-result commits in `runTurn`
   - router model-switch meta replacement
   - compaction meta messages
   - the initial child-session prompt in the orchestrator
   The TUI's task notification path already calls `submitPrompt`, so it should inherit stamping without TUI-specific code.
4. Preserve timestamps when transforming messages. In particular, router replacement must use the completed provider response's `createdAt` rather than generating a later unrelated timestamp.
5. Keep `loadSession` as a pure decode of persisted rows.
6. Run:

```bash
bun test packages/core/test/agent.test.ts packages/core/test/compaction.test.ts packages/core/test/session-models.test.ts packages/tui/test/controller.test.ts
```

Expected: every core path is stamped and persisted timestamps round-trip.

## Task 3: Record Provider Response And Whole-Turn Durations

**Objective:** Persist per-provider-response latency and successful end-to-end `runTurn` latency using a monotonic Effect clock.

**Files:**

- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/src/context/compaction.ts`
- Test: `packages/core/test/agent.test.ts`
- Test: `packages/core/test/compaction.test.ts`

**Steps:**

1. Add failing clock-controlled tests for:
   - a text-only response with `responseDurationMs`
   - a tool loop with response duration on every provider response and `turnDurationMs` only on the final assistant response
   - a retried stream whose response duration includes the failed attempt and retry delay
   - a router switch whose replacement meta message retains `responseDurationMs`
   - a compaction marker carrying its summary request's `responseDurationMs`
   - an interrupted/failed turn not inventing response or turn duration
   - the final message of a successful turn is an assistant message before `turnDurationMs` is attached, including a turn ending after a same-turn model switch or compaction (guards against attaching to a trailing meta user message)
2. Measure response duration around stream collection plus the existing retry schedule in `loop`. Stop the response timer when the final event has been collected; summary decoding does not need to be included.
3. Attach the resulting `responseDurationMs` when committing the assistant message. If router control flow replaces that message, copy its `createdAt` and `responseDurationMs` to the model-switch meta message.
4. Start a monotonic whole-turn timer at `runTurn` entry, before registry/setup and preflight compaction. After `runWithOverflowRetry` succeeds, attach elapsed `turnDurationMs` to the last assistant message; assert that the last message is in fact an assistant message before attaching, so a trailing meta user message from a same-turn switch/compaction cannot become the target. Do not write it in error/interruption paths.
5. Measure `LLMClient.generateTurn` in `compactSession` and attach `responseDurationMs` to the compaction meta message. Continue using the existing `CompactOptions.now` override for deterministic `createdAt`/`lastCompactedAt`; duration comes from the monotonic clock.
6. Use Effect `Clock`/`Effect.timed` and `Duration.toMillis`; do not use `Date.now()` subtraction for durations. Tests should provide/advance Effect's test clock rather than sleep in wall time.
7. Run:

```bash
bun test packages/core/test/agent.test.ts packages/core/test/compaction.test.ts
```

Expected: response metrics follow provider calls, aggregate turn metrics include all successful work, retries are included, and failed turns do not fabricate metrics.

## Task 4: Add Opt-In Web Tool Durations

**Objective:** Time only `WebSearch` and `WebFetch`, preserving their duration through result transformation and persistence.

**Files:**

- Modify: `packages/core/src/tool.ts`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/src/tools/web-search/tool.ts`
- Modify: `packages/core/src/tools/web-fetch.ts`
- Modify: `packages/core/src/context/tool-result-storage.ts`
- Test: `packages/core/test/agent-tool.test.ts`
- Test: `packages/core/test/tool-result-storage.test.ts`
- Test: `packages/core/test/tools-web-fetch.test.ts`
- Test: `packages/core/test/tools-web-search-exa.test.ts`

**Steps:**

1. Write failing tests proving:
   - an opted-in tool result gets `durationMs` on success and error
   - an otherwise identical unflagged tool result has no `durationMs`
   - a tool's timer covers `callTool` but stops before oversized-result offloading
   - replacing an oversized timed result with a preview preserves `durationMs`
2. Add one optional core-only capability to `Tool`, named clearly (for example `recordDuration?: boolean`). Do not add it to the model-facing `@swain/llms` `Tool` schema or JSON tool definition.
3. Set the capability on `WebSearch` and `WebFetch` only. Leave `Agent`, `Bash`, filesystem tools, and task tools unflagged.
4. Derive the timed tool-name set from the active registry in `runTurn`. Around `callTool`, use `Effect.timed` only for opted-in tools; attach `Duration.toMillis(duration)` to the returned `ToolResultContent`. Because `callTool` converts tool errors into `isError` results, this records both success and failure without changing the error channel.
5. Keep the existing lifecycle ordering: emit start, time `callTool`, emit end, then optionally offload an oversized result. Do not include event observer work or offloading in `durationMs`.
6. When `tool-result-storage.ts` reconstructs a preview result, copy `durationMs` from the original result.
7. Run:

```bash
bun test packages/core/test/agent-tool.test.ts packages/core/test/tool-result-storage.test.ts packages/core/test/tools-web-fetch.test.ts packages/core/test/tools-web-search-exa.test.ts
```

Expected: only the two selected web tools carry durable durations, including errors and oversized outputs.

## Task 5: Persist Detached Subagent Runtime

**Objective:** Record actual child-run duration on terminal delegated tasks without mislabeling `Agent` spawn latency.

**Files:**

- Modify: `packages/core/src/orchestrator.ts`
- Modify: `packages/core/src/tasks.ts`
- Test: `packages/core/test/orchestrator.test.ts`
- Test: `packages/core/test/tasks.test.ts`
- Test: `packages/tui/test/controller.test.ts`

**Steps:**

1. Write failing tests proving:
   - successful and failed child runners persist `durationMs` on their task
   - duration measures `runChild`, not worktree setup/cleanup or parent notification delay
   - direct non-delegated task completion can omit `durationMs`
   - batched notification text remains unchanged and does not expose duration
2. Extend the terminal finish input accepted by `completeTask`/`failTask` with optional `durationMs`, and have `finish` copy it into the task record. Keep the field out of arbitrary task updates.
3. In the orchestrator's detached `finalize` effect, convert child success/failure into the existing outcome value, then time that non-failing child-run effect so duration is available for both outcomes. Stop the timer before worktree cleanup and durable task persistence.
4. Pass the measured duration into `completeTask` or `failTask`. Keep `AgentResult` as `{ status: "spawned" }` with no duration that could be mistaken for child runtime.
5. Do not modify `renderNotification` or the `<task-notification>` payload.
6. Run:

```bash
bun test packages/core/test/orchestrator.test.ts packages/core/test/tasks.test.ts packages/tui/test/controller.test.ts
```

Expected: terminal delegated tasks contain precise child-run duration, while task notifications and immediate Agent responses retain their current contract.

## Task 6: Documentation And Full Verification

**Objective:** Document the persisted contract and prove the feature does not regress message lowering, session resume, agent control flow, or formatting.

**Files:**

- Modify: `ARCHITECTURE.md`
- Modify: `README.md`
- Modify: `specs/0007-session-runtime-benchmarking.md` after implementation

**Steps:**

1. Document the JSONL timing fields, their boundaries, and units in the root README's session persistence guidance.
2. Update the architecture persistence section to distinguish:
   - message commit timestamps
   - provider response duration
   - aggregate successful turn duration
   - selected synchronous tool duration
   - detached subagent task duration
3. Add a `## Post-Implementation Changes` section to this spec describing any implementation deviation and why.
4. Run the required project checks:

```bash
bun run typecheck
bun run format:check
bun test packages/llms/test
bun test packages/core/test
bun test packages/tui/test
```

5. Inspect a saved `messages.jsonl` and `tasks.json` from a deterministic tool-loop test or manual smoke run. Verify:
   - timestamps are valid ISO strings and ordered by commit
   - provider and turn durations are non-negative numbers
   - WebSearch/WebFetch results carry `durationMs`; untimed tool results do not
   - delegated terminal tasks carry `durationMs`
   - no timing field appears in captured provider request bodies

## Acceptance Criteria

- Every persisted message has `createdAt`, enforced by the decode schema.
- Every committed normal provider response has `responseDurationMs`, including responses that cause a router switch.
- Compaction meta messages have the compaction request's `responseDurationMs`.
- The final assistant response of each successful `runTurn` has `turnDurationMs`; intermediate assistant responses do not.
- Response duration includes provider retry/backoff. Turn duration includes all work from `runTurn` entry through successful final response.
- Interrupted and failed turns do not fabricate response/turn durations.
- Only WebSearch and WebFetch tool-result blocks have `durationMs`, on both success and error.
- Oversized timed tool results retain `durationMs` after preview replacement.
- Delegated completed and failed tasks have child-run `durationMs`; the immediate Agent spawn result and notification text do not.
- Historical session/task files are deleted rather than migrated; save/load preserves any present timing metadata.
- Provider request bodies contain no local timing metadata.
- Typecheck, format check, and all required test suites pass.

## Risks And Tradeoffs

- Flat optional fields are easy to query but permit structurally valid combinations the runtime should never emit. Tests must enforce placement invariants.
- `turnDurationMs` is user-visible agent latency, not pure model latency. It intentionally includes compaction, retries, approvals, and tools; eval consumers must not compare it directly with `responseDurationMs`.
- Timed tool coverage is intentionally sparse. A missing `durationMs` means “not instrumented,” not “zero duration.” Analysis code must treat absence as unknown.
- Provider response timing aggregates retries. This exposes reliability cost but cannot diagnose individual attempts; per-attempt telemetry is deferred.
- Message timestamps use wall-clock UTC and can move backward if the system clock changes. Durations use a monotonic clock and remain valid.
- Detached child duration excludes worktree creation/cleanup and task persistence by design. It measures agent execution, while whole parent-turn timing measures user-visible orchestration latency.

## Deferred Follow-Ups

- Per-attempt provider timing, time to first token, and stream throughput.
- A structured run-attempt sidecar for failed/interrupted turns.
- Timing additional tools, including Bash and approval-heavy tools, based on observed eval needs.
- Subagent setup, cleanup, queueing, and notification-lag metrics separate from child runtime.
- Aggregate benchmark/eval reports and TUI timing display.
- Explicit schema refinements or branded non-negative duration types if invalid external data becomes a real ingestion problem.
