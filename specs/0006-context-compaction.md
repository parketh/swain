# Context Compaction Implementation Plan

> Use subagents to implement this plan task-by-task.

**Goal:** Add bounded context management for Swain: automatic and manual full compaction, large tool-result persistence, and best-estimate context accounting. (Independent tool-result body clearing is deferred — see Deferred Follow-Ups.)

**Architecture:** `@swain/llms` normalizes provider usage into `activeContextTokens`; `@swain/core` owns compaction policy, context accounting, transcript mutation, and tool-result replacement logic; the TUI owns `/compact`, status/errors, and concrete session artifact locations. Full compaction uses the current session model to update one compound anchored summary and preserves a recent verbatim tail. Token pressure is measured with a hybrid approach: provider-reported active context usage from the last completed turn plus local estimates for unsent transcript deltas.

**Tech Stack:** Bun workspace, TypeScript ESM, Effect, Effect Schema, `@effect/platform`, `@effect/platform-bun`, `@swain/llms`, Ink/React, Bun test runner, Biome.

---

## Decisions

- V1 is local/transcript-based only. Do not implement provider-native context editing (`clear_tool_uses`, `clear_thinking`) in v1.
- Automatic full compaction triggers at about 90% of the effective context window. Manual `/compact` can run at any time. The 10% margin (plus `outputReserve`) absorbs local-estimator error (the `length/4` counter can under- or over-count); the provider `context-overflow` retry path is the hard backstop when the estimate is wrong enough to still overflow.
- Effective window is `contextWindow - outputReserve`, where `outputReserve = min(maxOutputTokens, 20_000)`.
- Full compaction keeps a 20k-token recent tail, clamped lower for small model windows.
- No "first N raw messages" preservation. The system prompt and AGENTS.md are regenerated each turn; original intent is captured in the summary template.
- Full compaction uses a fixed six-section template: `Goal`, `Decisions and constraints`, `Key Context`, `Progress so far`, `Remaining work`, and `All user messages`.
- Summaries are compound and bounded: keep exactly one anchored compaction summary and update it on each later compaction. Do not stack unbounded summaries.
- The summary request must not itself overflow. Default: summarize everything older than the recent tail (produces a clean `[summary][tail]` transcript). Fallback: if that older region's estimated tokens exceed the summary input budget (`effectiveWindow - outputReserve - summaryPromptOverhead`), summarize only a bounded prefix — the oldest messages that fit within the budget, preserving tool-call/tool-result pairing at the cut point — and leave the messages between that prefix and the tail verbatim. The bounded-prefix fallback mainly matters on the overflow-recovery path, where the transcript already exceeded the window. A single bounded-prefix pass may not drop context below the trigger threshold; v1 does not loop compaction — if one pass is insufficient, the overflow-retry path (compact once, retry once, else surface typed `context-overflow` error) is the escape. Multi-pass/hierarchical summarization is a deferred follow-up.
- The summary model is the current session model with the current session request options.
- If a provider rejects a turn for context overflow, run one full compaction and retry the same turn once.
- If automatic compaction fails once, disable automatic compaction for that session and surface a clear error. Manual `/compact` remains allowed.
- Large tool results are persisted separately before they bloat the transcript. The model-visible tool result is replaced with a path plus preview.
- Persist oversized tool-result bodies under the persisted session directory, not in the project tree or OS temp.
- Compaction writes persisted meta/boundary events. Earlier message ranges may be replaced with a compact placeholder such as `N messages compacted`.
- Token accounting uses provider-reported active context usage where available, plus estimates for messages added since the last provider response.
- Model catalog entries should include manually populated placeholder `contextWindow` and `maxOutputTokens` values. These are correctness inputs and should be easy to audit/update.
- Add a token counter abstraction, but do not add exact model tokenizer dependencies in v1 unless implementation proves the local estimator is the dominant failure mode.

## Current Context

- Session state lives in `packages/core/src/state/session.ts`.
- Session persistence writes `session.json` and `messages.jsonl` from `packages/core/src/state/store.ts`.
- The agent loop lives in `packages/core/src/agent.ts`; it appends assistant messages, tool results, and provider usage counters.
- LLM usage schema is currently only `{ inputTokens, outputTokens }` in `packages/llms/src/schema/events.ts`.
- Provider protocol decoders currently discard provider-native usage details needed to compute `activeContextTokens`:
  - `packages/llms/src/protocols/anthropic-messages.ts`
  - `packages/llms/src/protocols/openai-chat.ts`
  - `packages/llms/src/protocols/openai-codex-responses.ts`
- Tool results are constructed in `packages/core/src/tools/results.ts`.
- Built-in tools live in `packages/core/src/tools/*`.
- Slash commands are declared in `packages/tui/src/commands.ts` and dispatched in `packages/tui/src/controller.ts`.
- Model catalog and request options live in `packages/tui/src/models.ts`.
- The system prompt is assembled in `packages/core/src/prompt.ts`.

## Data Model

### Rich Usage

Extend `Usage` in `packages/llms/src/schema/events.ts`:

```ts
export const Usage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  activeContextTokens: Schema.optional(Schema.Number),
})
```

Provider protocols are responsible for translating provider-native usage into `activeContextTokens`. Core should not know provider-specific cache or reasoning fields.

Provider mapping guidance:

- Anthropic:
  - `inputTokens = input_tokens`
  - `outputTokens = output_tokens`
  - `activeContextTokens = input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens`
- OpenAI Chat:
  - `inputTokens = prompt_tokens`
  - `outputTokens = completion_tokens`
  - `activeContextTokens = input + output`
- OpenAI Codex Responses:
  - `inputTokens = input_tokens`
  - `outputTokens = output_tokens`
  - `activeContextTokens = input + output`

Core must treat missing `activeContextTokens` as `inputTokens + outputTokens`.

### Context Window And Output Reserve

Populate explicit `contextWindow` and `maxOutputTokens` values in catalog construction. No limits/context-window field exists in `packages/tui/src/models.ts` today (`ModelSpec` carries only `{ id, lab, label, variants, deprecated? }`); this is a new field. Add a `limits` object to the per-model spec with this shape:

```ts
interface ModelLimits {
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
}
```

Scaffold clearly marked placeholder values in `packages/tui/src/models.ts`. The important invariant is that every selectable catalog model can carry a context window and max output reserve into `@swain/core`. The user will replace/audit these placeholders before manual end-to-end testing.

### Token Counter

Create `packages/core/src/context/token-counter.ts`:

```ts
export interface TokenCounter {
  estimateText(text: string): number
  estimateJson(value: unknown): number
  estimateMessage(message: Message): number
  estimateMessages(messages: ReadonlyArray<Message>): number
}
```

V1 implementation:

- Default text estimate: `Math.ceil(text.length / 4)`.
- JSON-ish payload estimate: `Math.ceil(JSON.stringify(value).length / 2)` for dense JSON tool inputs/results.
- Fallback JSON estimate: `Math.ceil(JSON.stringify(value).length / 4)`.

Use this estimator only for content not already covered by provider-reported `activeContextTokens`: pending user input, tool results, meta messages, local transcript mutations, and full-request fallback before the first provider usage snapshot. Do not estimate the entire retained transcript and add it to `activeContextTokens`; that double-counts history the provider already measured.

This is intentionally an abstraction so exact tokenizers or provider count-token APIs can replace the estimator later without changing compaction policy.

### Context Accounting

Add session-level context accounting:

```ts
export interface ContextUsageState {
  readonly activeContextTokens: number
  readonly measuredAtMessageIndex: number
}
```

Implementation guidance:

- `measuredAtMessageIndex` is the `session.messages.length` immediately after appending the assistant response whose provider usage produced `activeContextTokens`.
- Before each request, estimate `session.messages.slice(measuredAtMessageIndex)` and add those local messages to the recorded active context.
- If an older message is mutated after the usage snapshot, clear the snapshot or reset `measuredAtMessageIndex` to force a full local estimate. Do not pretend the index still identifies all unmeasured content.
- If no provider usage exists yet, estimate the full request locally.
- Include system prompt and tool schema estimates in preflight checks when no provider usage exists or when those inputs changed materially.

### Compaction Metadata

Add session compaction state:

```ts
export interface SessionCompactionState {
  readonly autoEnabled: boolean
  readonly failureReason?: string
  readonly lastCompactedAt?: string
  readonly summary?: string
}
```

Rules:

- `autoEnabled` starts true for new sessions.
- On first automatic compaction failure, set `autoEnabled = false` and persist `failureReason`.
- Manual `/compact` ignores `autoEnabled` but updates `summary` on success.
- Keep one compound summary only.

### Compaction Meta Messages

Extend `@swain/llms` user content with a model-visible compaction marker:

```ts
export const CompactionContent = Schema.Struct({
  type: Schema.Literal("compaction"),
  reason: Schema.Literal("auto", "manual", "overflow"),
  compactedMessages: Schema.Number,
  summary: Schema.String,
})
```

Render it to providers as concise text, for example:

```text
[Conversation compacted: 42 earlier messages summarized.]
<summary>
...
</summary>
```

Persist it as a user `isMeta: true` message. The TUI can render it as a boundary row instead of normal user text.

### Large Tool Result Records

Store files under:

```text
<sessionsDir>/<sessionId>/tool-results/<toolCallId>.txt
<sessionsDir>/<sessionId>/tool-results/<toolCallId>.json
```

Add replacement records to `session.json` or a `tool-results.json` sidecar:

```ts
export interface ToolResultReplacement {
  readonly toolCallId: string
  readonly name?: string
  readonly path: string
  readonly originalBytes: number
  readonly previewBytes: number
  readonly createdAt: string
}
```

Model-visible replacement format:

```text
<persisted-tool-result>
Output too large (<size>). Full output saved to: <path>

Preview:
<prefix preview>
...
</persisted-tool-result>
```

Do not persist binary/image tool results in v1. Leave them unchanged.

## Summary Template

Use a fixed template and reject empty summaries. The exact wording can be tuned during implementation, but the sections must be stable:

```markdown
## Goal

## Decisions and constraints

## Key Context (files, code references, etc)

## Progress so far

## Remaining work

## All user messages
```

Rules for the summary prompt:

- Respond with text only. Do not call tools; compaction requests must send an empty tool list, and any tool call is a compaction failure.
- Output exactly the requested Markdown sections in the requested order. Do not wrap the summary in extra XML tags, prose prefaces, or explanations.
- Keep the summary self-contained for a future model resuming the task.
- Preserve every user instruction in `All user messages`.
- Preserve exact file paths, commands, error strings, identifiers, and model/tool names.
- Preserve active tasks, blockers, approvals, and pending user questions.
- `Remaining work` must be specific enough for the next model to continue without asking what to do next.
- If a previous summary exists, update it: keep still-true facts, remove stale facts, merge new facts.
- Do not mention the compaction process except inside the persisted boundary marker.

## Implementation Order (tracer bullet first)

The tasks below are numbered by subsystem, not by build order. Build a vertical slice first, then layer:

1. **Tracer slice:** Task 5 (manual path only — `CompactionContent` schema, provider lowerers, six-section template, transcript mutation with summarize-all-older-than-tail, persist single summary) **plus** Task 7 (`/compact` command, boundary rendering). The manual path depends on none of the usage/accounting work. This proves the risky transcript-mutation + provider-lowering + resume path end-to-end and is the first user-observable result.
2. Task 1 (rich usage) → Task 2 (accounting) — prerequisites for the auto trigger only.
3. Task 3 (large tool-result persistence).
4. Task 6 (automatic + reactive compaction) — wires accounting to the trigger, adds the bounded-prefix fallback and overflow retry.
5. Task 8 (resume/persistence hardening) → Task 9 (end-to-end validation).

## Task 1: Enrich Usage And Context Windows

**Objective:** Make provider usage expressive enough to represent active context pressure and populate model context windows/output reserves for compaction policy.

**Files:**

- Modify: `packages/llms/src/schema/events.ts`
- Modify: `packages/llms/src/protocols/anthropic-messages.ts`
- Modify: `packages/llms/src/protocols/openai-chat.ts`
- Modify: `packages/llms/src/protocols/openai-codex-responses.ts`
- Modify: `packages/tui/src/models.ts`
- Test: `packages/llms/test/anthropic-messages.test.ts`
- Test: `packages/llms/test/openai-chat.test.ts`
- Test: `packages/llms/test/openai-codex.test.ts`
- Test: `packages/tui/test/models.test.ts`

**Steps:**

1. Add failing protocol tests asserting provider-native usage fields are condensed into `activeContextTokens`.
2. Extend `Usage` schema with optional context fields.
3. Update each provider decoder to fill the richer fields.
4. Scaffold clearly marked placeholder `contextWindow` and `maxOutputTokens` values for every catalog model.
5. Verify with:

```bash
bun test packages/llms/test/anthropic-messages.test.ts packages/llms/test/openai-chat.test.ts packages/llms/test/openai-codex.test.ts packages/tui/test/models.test.ts
```

## Task 2: Add Token Counter And Context Pressure Accounting

**Objective:** Estimate current request pressure from provider-reported context plus local transcript deltas.

**Files:**

- Create: `packages/core/src/context/token-counter.ts`
- Create: `packages/core/src/context/accounting.ts`
- Modify: `packages/core/src/state/session.ts`
- Modify: `packages/core/src/state/store.ts`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/context-accounting.test.ts`
- Test: `packages/core/test/agent.test.ts`

**Steps:**

1. Add failing tests for:
   - no provider usage means full local estimate
   - provider active context plus new user/tool messages
   - Anthropic cache tokens included via `activeContextTokens`
   - mutation before `measuredAtMessageIndex` invalidates the usage snapshot
2. Implement the default `TokenCounter`.
3. Add session context accounting state.
4. Update `runTurn` to record provider usage after each assistant finish.
5. Expose helpers:

```ts
estimateCurrentContextTokens(session, requestShape, counter): number
effectiveContextWindow(model): number | undefined
shouldAutoCompact(session, requestShape, counter): boolean
```

6. Verify with:

```bash
bun test packages/core/test/context-accounting.test.ts packages/core/test/agent.test.ts
```

## Task 3: Persist Large Tool Results

**Objective:** Prevent oversized tool outputs from entering the transcript as full model-visible bodies.

**Files:**

- Create: `packages/core/src/context/tool-result-storage.ts`
- Modify: `packages/core/src/tools/results.ts`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/src/state/session.ts`
- Modify: `packages/core/src/state/store.ts`
- Test: `packages/core/test/tool-result-storage.test.ts`
- Test: `packages/core/test/tools-filesystem.test.ts`
- Test: `packages/core/test/tools-bash.test.ts`

**Steps:**

1. Add failing tests for text/json persistence, preview replacement, sidecar persistence, resume, and non-text passthrough.
2. Introduce a configurable threshold. Start with `50_000` characters unless implementation evidence suggests a better default.
3. Write full text/json output under `<session>/tool-results/`.
4. Replace the tool-result body with the persisted-output wrapper and preview.
5. Store replacement metadata durably.
6. Ensure repeated saves/resumes do not rewrite or duplicate persisted outputs.
7. Verify with:

```bash
bun test packages/core/test/tool-result-storage.test.ts packages/core/test/tools-filesystem.test.ts packages/core/test/tools-bash.test.ts
```

## Task 5: Full Compaction Engine

**Objective:** Summarize older transcript into one bounded compound summary and preserve a recent verbatim tail.

**Files:**

- Create: `packages/core/src/context/compaction.ts`
- Modify: `packages/core/src/state/session.ts`
- Modify: `packages/core/src/state/store.ts`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/llms/src/schema/messages.ts`
- Modify: `packages/llms/src/protocols/anthropic-messages.ts`
- Modify: `packages/llms/src/protocols/openai-chat.ts`
- Modify: `packages/llms/src/protocols/openai-codex-responses.ts`
- Test: `packages/core/test/compaction.test.ts`
- Test: `packages/llms/test/schema.test.ts`

**Steps:**

1. Add failing tests for:
   - manual compaction with no prior summary
   - second compaction updates the existing summary instead of stacking
   - 20k recent tail selection
   - boundary split inside a message is allowed only when provider invariants remain valid
   - tool-call/tool-result pairs are not split into invalid history
   - the mutated transcript passes a pairing-validity assertion before it can be submitted (guard, not just a test)
   - meta boundary is persisted and provider-rendered as text
2. Add `SessionCompactionState`.
3. Add `CompactionContent` to `UserContent` and provider lowerers.
4. Implement summary prompt construction with the fixed six-section template.
5. Call the current session model with no tools and a summary output cap of `min(current max output, 20_000)`.
6. Replace the summarized prefix with one compaction meta message, then the (possibly empty) middle-verbatim region, then the recent tail.
7. Persist `summary` as the single compound summary.
8. Verify with:

```bash
bun test packages/core/test/compaction.test.ts packages/llms/test/schema.test.ts
```

## Task 6: Automatic And Reactive Compaction

**Objective:** Run compaction before requests that exceed context pressure and recover once from provider overflow.

**Files:**

- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/src/errors.ts`
- Modify: `packages/llms/src/schema/errors.ts`
- Modify: `packages/llms/src/transport/http.ts`
- Modify: `packages/llms/src/protocols/anthropic-messages.ts`
- Modify: `packages/llms/src/protocols/openai-chat.ts`
- Modify: `packages/llms/src/protocols/openai-codex-responses.ts`
- Test: `packages/core/test/agent.test.ts`
- Test: `packages/core/test/compaction.test.ts`
- Test: `packages/llms/test/http.test.ts`

**Steps:**

1. Add failing tests for:
   - auto compaction at 90% effective window
   - auto disabled after one failed auto attempt
   - manual still works after auto disable
   - context overflow error triggers compact and retry once
   - second overflow surfaces typed error
2. Normalize provider context overflow into a typed `LLMError` reason, for example `context-overflow`.
3. In `runTurn`, run auto full compaction if needed, then submit the request.
4. On `context-overflow`, run full compaction with reason `overflow` and retry once.
5. Verify with:

```bash
bun test packages/core/test/agent.test.ts packages/core/test/compaction.test.ts packages/llms/test/http.test.ts
```

## Task 7: TUI Command And Status

**Objective:** Expose manual compaction and make automatic compaction visible.

**Files:**

- Modify: `packages/tui/src/commands.ts`
- Modify: `packages/tui/src/controller.ts`
- Modify: `packages/tui/src/components/StatusLine.tsx`
- Modify: `packages/tui/src/components/Transcript.tsx`
- Modify: `packages/tui/src/components/HelpView.tsx`
- Test: `packages/tui/test/commands.test.ts`
- Test: `packages/tui/test/controller.test.ts`
- Test: `packages/tui/test/transcript.test.tsx`

**Steps:**

1. Add `/compact` to command parsing (`CommandName` union, `COMMAND_NAMES`, `COMMANDS`) and help.
2. Add `controller.compact(reason: "manual")` and dispatch `/compact` from the `executeCommand` switch in `controller.ts` (the same path as `clear`/`plan`/`model`/`variants`), not the UI-overlay path.
3. Render compaction meta messages as a distinct boundary row.
4. Show minimal status when auto compaction is disabled after failure.
5. Verify with:

```bash
bun test packages/tui/test/commands.test.ts packages/tui/test/controller.test.ts packages/tui/test/transcript.test.tsx
```

## Task 8: Resume And Persistence Hardening

**Objective:** Ensure compacted sessions, persisted tool outputs, and context accounting survive process restart.

**Files:**

- Modify: `packages/core/src/state/store.ts`
- Modify: `packages/tui/src/controller.ts`
- Test: `packages/core/test/session-models.test.ts`
- Test: `packages/tui/test/controller.test.ts`
- Test: `packages/tui/test/history.test.ts`

**Steps:**

1. Add load/save round-trip tests for:
   - `compaction.summary`
   - `compaction.autoEnabled`
   - compaction meta messages
   - tool-result replacement metadata
   - resumed context accounting starts from available provider usage or estimates full current history
2. Ensure missing sidecar files degrade to the preview/path message, not a hard load failure.
3. Verify with:

```bash
bun test packages/core/test/session-models.test.ts packages/tui/test/controller.test.ts packages/tui/test/history.test.ts
```

## Task 9: End-To-End Validation

**Objective:** Prove the feature works across providers and does not regress existing agent loop behavior.

**Files:**

- Test: focused tests added above
- Existing verification suite

**Steps:**

1. Run focused tests from Tasks 1-8.
2. Hand off placeholder `contextWindow` and `maxOutputTokens` values in `packages/tui/src/models.ts` for user replacement/audit before manual testing.
3. Run required project checks:

```bash
bun run typecheck
bun run format:check
bun test packages/llms/test
bun test packages/core/test
bun test packages/tui/test
```

4. Manually exercise:
   - large Bash output gets persisted and previewed
   - `/compact` creates a boundary
   - a second `/compact` updates one summary
   - auto compaction disables after a forced summary failure
   - resume preserves compacted transcript and persisted output paths

## Risks And Tradeoffs

- Provider-reported usage is more accurate than pure estimation, but it is still a last-response snapshot. Local mutations after that snapshot must be tracked carefully.
- Adding exact tokenizers now would add dependency and model-family maintenance without eliminating provider-side differences in tool/schema rendering.
- Large tool-result persistence adds filesystem lifecycle concerns. Keeping artifacts under the session directory makes cleanup and resume tractable.
- Full compaction discards verbatim history older than the tail; anything the model still needs must survive in the summary. The six-section template (esp. `Key Context` and `All user messages`) and the recent-tail preservation reduce this risk.
- Fail-once auto disable avoids runaway token spend but can make transient summary failures user-visible. Manual `/compact` is the escape hatch.

## Deferred Follow-Ups

- Independent tool-result body clearing (keep-last-N compactable bodies, count-pressure and idle-gap eviction, `[Old tool result content cleared]` placeholder, and the prompt warning that old tool results may be cleared). Deferred from v1 because large-result persistence (Task 3) removes the biggest offenders at write time and full compaction (Task 5) summarizes old turns; revisit if real sessions show medium-result bloat that neither catches.
- Multi-pass / hierarchical full compaction for transcripts too large to summarize in a single bounded-prefix pass.
- Provider-native context editing (`clear_tool_uses`, `clear_thinking`) for providers that support it.
- Exact model tokenizers or provider count-token APIs behind `TokenCounter`.
- Configurable compaction thresholds and tool-result thresholds.
- UI for browsing persisted tool-result files.
- Post-compaction fresh reread of recently accessed files, capped by file count and token budget.
- Session cleanup for old `tool-results/` artifacts.

## Post-Implementation Changes

Deviations from the plan made during implementation, and why:

- **Overflow error reason.** Reused the existing `context-length-exceeded` `LLMErrorReason` instead of adding a new `context-overflow`; the plan wrote `context-overflow` only "for example".
- **Overflow normalization site.** Centralized in `packages/llms/src/transport/http.ts` (`isContextOverflow` matches the HTTP 400 error body), which covers every provider since all overflow responses arrive as a 400 through `Http.streamSseJson`. Also handled the Anthropic in-stream `invalid_request_error` path. The OpenAI Chat/Codex in-stream error paths were left unchanged because their overflow surfaces as an HTTP 400, already normalized.
- **Model limits location.** Instead of a `limits` field on each per-model `ModelSpec`, placeholder limits live in one auditable `LIMITS` map in `packages/tui/src/models.ts`, keyed by model id and attached to the built `Model` in `resolveModelSelection`. This keeps every serving provider of a shared model on one entry and is easier to audit/update.
- **`ModelLimits` already existed.** `packages/llms/src/schema/options.ts` already carried `ModelLimits`/`Model.limits`, so no llms schema change was needed for context windows — only population in the TUI catalog.
- **Token counter.** `estimateJson` uses `length/4`, not the plan's `length/2`. The `~2` heuristic roughly doubled tool-result pressure versus real BPE tokenization, which drove auto-compaction to trigger far too early on read-heavy turns; `~4` chars/token holds for both dense JSON and prose, so `estimateText` and `estimateJson` share it and the separate JSON fallback was dropped.
- **Summary request shape.** The six-section template lives in the summary system prompt and the prefix messages are sent as-is (ending on a user message); no extra instruction message is appended, preserving provider role alternation.
- **Context accounting persistence.** `contextUsage` is intentionally not persisted; on resume it is `undefined`, so accounting re-estimates the full current history (permitted by the plan).
- **Token counter built before Task 2.** `token-counter.ts` and the model-window helpers in `accounting.ts` were created as part of the Task 5 tracer slice because full compaction depends on them; the remaining accounting helpers landed in Task 2.
- **Independent tool-result body clearing (Task 4)** remains deferred as planned; task numbering skips 4.
