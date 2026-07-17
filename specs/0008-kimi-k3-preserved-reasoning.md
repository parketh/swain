# Kimi K3 and Preserved Reasoning Implementation Plan

> Use subagents to implement this plan task-by-task.

**Goal:** Add Moonshot's pay-as-you-go Kimi API as a provider, expose `kimi-k3` as a coding model, and preserve hidden reasoning across same-model and cross-model turns so K3 receives the reasoning history for every message in its context window.

**Architecture:** Keep `ReasoningContent` as the provider-neutral session representation and continue hiding it from the TUI. Add an opt-in OpenAI Chat lowering profile that serializes assistant reasoning as Kimi's message-level `reasoning_content`; mark K3 as preferring full reasoning history so core can warn when compaction would drop it. Compaction still operates on K3 exactly as on other models — lossy, but well-formed, since retained messages keep their `reasoning_content`. Successful model switches retain the switching assistant's text/reasoning while removing control tool calls and appending the existing typed switch marker.

**Tech Stack:** Bun workspace, TypeScript ESM, Effect, Effect Schema, direct OpenAI-compatible HTTP/SSE, Bun test runner, Biome.

---

## Decisions

- Provider ID: `kimi`; lab ID: `kimi`.
- API surface: Moonshot pay-as-you-go, not Kimi Code subscription.
- Base URL: `https://api.moonshot.ai/v1`.
- Standalone package credential: `MOONSHOT_API_KEY`; the TUI continues storing the entered API key in `auth.json`.
- Initial model: `kimi-k3`, labelled `Kimi K3`.
- K3 exposes one real variant, `max`. Do not invent `low` or `high`: K3 currently accepts only `reasoning_effort: "max"`.
- K3 requests use `max_completion_tokens`, not deprecated `max_tokens`, whenever Swain supplies an output limit.
- K3 does not receive `temperature`; its sampling configuration is fixed.
- Catalog limits are `1_048_576` context tokens and `131_072` default maximum output tokens. The latter is an accounting/output-reserve value, not a forced generation cap on ordinary turns.
- Reasoning stays in canonical assistant `reasoning` blocks and remains absent from transcript rendering.
- Kimi lowering concatenates an assistant message's reasoning blocks, without separators, into `reasoning_content`; normal text remains in `content`, and tool calls remain in `tool_calls` on the same assistant message.
- Emitting `reasoning_content` only when reasoning exists is wire-safe. Verified against the Moonshot thinking-model guide and Chat Completions reference (2026-07-17): `reasoning_content` is **not a required field** — omitting it on a reasoning-less historical assistant message does not error; the docs only warn the model "may lose reasoning context." The "keep every historical `reasoning_content` as-is" rule means preserve what the API returned, not fabricate an empty field. So no empty-string placeholder is needed.
- Kimi receives canonical reasoning regardless of which model produced it. This is the best available cross-model representation and is required for switching into K3.
- Other providers never receive foreign reasoning as visible text. A protocol may replay canonical reasoning only when it has a valid native wire representation; otherwise it omits the block while the session retains it. In particular, unsigned foreign reasoning cannot be fabricated as Anthropic `thinking` blocks.
- A successful `SwitchModel` retains all non-tool assistant blocks from the switching step, removes every tool-call block from that step, and then appends the typed `model-switch` meta message. This preserves reasoning while avoiding orphan tool calls/results.
- K3 replays canonical reasoning for every assistant message in its projected context, using the same compacted projection as any other model. Retained (non-compacted) messages carry their reasoning; a compaction summary legitimately supplants the turns it folds.
- Compaction operates on K3 exactly as on other models — automatic, overflow, and manual all run. Moonshot flags reasoning loss across turns as risky, so Swain surfaces a warning when compaction runs on a K3 session, but does not block it or force a new session. This is the same lossy tradeoff compaction makes for every model.
- Switching into and out of K3 remains allowed. Document that Moonshot warns switching another model's active session into K3 may still be unstable even when the wire history is complete; Swain guarantees serialization correctness, not model quality.
- Add K3 to automatic routing using current Artificial Analysis data: `capability: 57`, `avgCostPerTask: 0.94`. Record Kimi's published prices as `$3/MTok` cache-miss input and `$15/MTok` output; the existing catalog does not model cache-hit price.

## References

- [Kimi API overview](https://platform.kimi.ai/docs/api/overview): OpenAI-compatible Chat Completions at `https://api.moonshot.ai/v1`, bearer authentication.
- [Kimi thinking-mode guide](https://platform.kimi.ai/docs/guide/use-kimi-k2-thinking-model): K3 uses `reasoning_content`, requires every historical assistant reasoning field to be returned, and currently supports only `reasoning_effort: "max"`.
- [Kimi K3 technical blog](https://www.kimi.com/fr-fr/blog/kimi-k3): 1M context, pay-as-you-go model ID `kimi-k3`, prices, preserved-thinking requirement, and cross-model-switch warning.
- [Kimi Chat Completion reference](https://platform.kimi.ai/docs/api/chat): `max_completion_tokens` supersedes `max_tokens`.
- [Artificial Analysis Kimi K3](https://artificialanalysis.ai/models/kimi-k3): capability, current cost-per-task basis, pricing, and context-window cross-check.

## Acceptance Criteria

1. `/connect` lists Kimi and accepts/stores a Moonshot API key without writing it to `config.json`.
2. `/model` lists `Kimi K3`; resolving `kimi:kimi-k3:max` builds a live model for `https://api.moonshot.ai/v1/chat/completions` with `reasoning_effort: "max"` (the default).
3. K3 streamed `reasoning_content` becomes canonical `ReasoningContent`, persists in `messages.jsonl`, and remains hidden from the TUI.
4. Every K3 request returns each historical assistant message's canonical reasoning in that message's `reasoning_content`, alongside its content and tool calls.
5. A successful switch preserves the switching step's reasoning and text, removes all tool calls from that step, records the switch marker, and continues on the target without orphan calls.
6. Switching another model into K3 sends that model's prior canonical reasoning as `reasoning_content`; switching away retains K3 reasoning locally and never exposes it as ordinary text.
7. Switching back to K3 restores canonical K3 and non-K3 reasoning for every message still in the projected context.
8. Compaction runs on K3 like any other model; doing so surfaces a warning that Moonshot flags cross-turn reasoning loss as risky. Reasoning for retained messages is still replayed as `reasoning_content`.
9. K3 is available to the router as the single target `kimi:kimi-k3:max`.
10. All package tests and repository verification commands pass.

## Task 1: Add Kimi message lowering to OpenAI Chat

**Objective:** Make reasoning replay and Kimi's output-token field explicit opt-in protocol behavior without changing existing OpenAI-compatible providers.

**Files:**

- Modify: `packages/llms/src/protocols/openai-chat.ts`
- Test: `packages/llms/test/openai-chat-reasoning.test.ts`
- Test: `packages/llms/test/openai-chat.test.ts`

**Step 1: Write failing request-lowering tests**

Add focused cases that prepare a history containing an assistant message with reasoning, text, and a tool call. Assert that a Kimi-style profile produces one assistant wire message shaped like:

```ts
{
  role: "assistant",
  reasoning_content: "planstep",
  content: "answer",
  tool_calls: [expect.anything()],
}
```

Cover multiple reasoning blocks and assert exact concatenation with no inserted whitespace. Add a reasoning-only assistant case. Assert that the default profile still omits reasoning and does not emit an empty assistant wire message.

Add a generation test asserting that the Kimi profile maps `generation.maxTokens` to `max_completion_tokens` and does not also send `max_tokens`.

Run:

```bash
bun test packages/llms/test/openai-chat-reasoning.test.ts packages/llms/test/openai-chat.test.ts
```

Expected: new assertions fail because the profile and `reasoning_content` lowering do not exist.

**Step 2: Add the minimal protocol profile**

Extend `OpenAIChatProfile` with opt-in fields equivalent to:

```ts
readonly reasoningHistory?: "reasoning_content"
readonly maxTokensField?: "max_tokens" | "max_completion_tokens"
```

Default `maxTokensField` to `max_tokens`. Pass the profile into message lowering. For assistant messages:

- collect text, reasoning, and tool calls separately;
- add `reasoning_content` only for the opted-in profile and only when reasoning exists;
- omit an assistant message only when it has no text, replayable reasoning, or tool calls;
- never convert reasoning into text.

Keep existing response decoding: it already turns streamed `reasoning_content` into reasoning lifecycle events.

**Step 3: Verify the protocol tests**

Run the Task 1 test command again.

Expected: all selected tests pass; existing OpenAI, DeepSeek, and Z.AI request shapes remain unchanged.

## Task 2: Add the Kimi provider and K3 model card

**Objective:** Expose a typed, SDK-free Kimi facade configured for Moonshot's pay-as-you-go endpoint.

**Files:**

- Modify: `packages/llms/src/schema/providers.ts`
- Modify: `packages/llms/src/schema/labs.ts`
- Modify: `packages/llms/src/schema/options.ts`
- Create: `packages/llms/src/models/kimi.ts`
- Modify: `packages/llms/src/models/index.ts`
- Create: `packages/llms/src/providers/kimi.ts`
- Modify: `packages/llms/src/providers/openai-compatible.ts`
- Modify: `packages/llms/src/providers/index.ts`
- Modify: `packages/llms/scripts/smoke.ts`
- Test: `packages/llms/test/provider-facades.test.ts`
- Test: `packages/llms/test/exports.test.ts`

**Step 1: Write failing facade/export tests**

Test that:

- `Provider.Kimi` and `Lab.Kimi` are `"kimi"`;
- `KimiModel.K3` is `"kimi-k3"`;
- `Kimi.model("kimi-k3")` resolves provider/model identity and sets `warnOnReasoningLoss`;
- `Kimi.options({ reasoningEffort: "max" })` returns `{ kimi: { reasoningEffort: "max" } }`;
- a captured request uses `https://api.moonshot.ai/v1/chat/completions`, bearer auth, `reasoning_effort: "max"`, `reasoning_content`, and `max_completion_tokens`;
- the providers and models public export paths expose Kimi.

Run:

```bash
bun test packages/llms/test/provider-facades.test.ts packages/llms/test/exports.test.ts
```

Expected: imports/expectations fail because Kimi does not exist.

**Step 2: Add the model capability and facade**

Add this minimal capability flag to the llms `Model` schema (`packages/llms/src/schema/options.ts`), not to the TUI catalog — `packages/core` reads it off the resolved `Model` during compaction (Task 4), so it must live where core can see it:

```ts
readonly warnOnReasoningLoss?: boolean
```

There is no existing capability struct in `packages/llms`; this is a net-new field on `Model` (or `ModelLimits`), set by the Kimi facade. Do not introduce a general capability registry. Configure `Kimi` as a thin, typed profile over `OpenAICompatible`:

- default base URL `https://api.moonshot.ai/v1`;
- environment fallback `MOONSHOT_API_KEY`;
- provider key `kimi`;
- reasoning-history profile `reasoning_content`;
- output-token field `max_completion_tokens`;
- returned models set `warnOnReasoningLoss: true`.

Define Kimi options narrowly: only `reasoningEffort?: "max"`; do not expose temperature or the generic provider's wider effort union.

Add Kimi K3 to the manual smoke runner, gated by `MOONSHOT_API_KEY`.

**Step 3: Verify facade/export tests**

Run the Task 2 test command again.

Expected: all selected tests pass and no provider SDK dependency is added.

## Task 3: Preserve the switching assistant message

**Objective:** Stop successful model switches from deleting the reasoning/text that led to the switch.

**Files:**

- Modify: `packages/core/src/agent.ts`
- Test: `packages/core/test/switch-model.test.ts`

**Step 1: Write failing switch-history tests**

Script a provider step that emits reasoning, optional text, `SwitchModel`, and a sibling tool call. After the switch assert:

- the assistant reasoning and text blocks remain in their original order;
- the `SwitchModel` and sibling tool-call blocks are absent;
- the following message is the existing `model-switch` meta user message;
- no tool result is owed for a removed call;
- the next request goes to the selected target.

Also cover a step containing only tool calls: it should leave no empty assistant message, only the switch marker.

Run:

```bash
bun test packages/core/test/switch-model.test.ts
```

Expected: the retained reasoning assertion fails because successful switches currently replace the whole assistant message.

**Step 2: Sanitize instead of replace**

When `resolveSwitch` returns `switched`, filter the just-appended assistant content to non-tool blocks. Replace the message with the retained assistant plus the meta marker when content remains; otherwise replace it with the marker alone. Keep the current sibling-dropping and one-switch-per-turn rules.

**Step 3: Verify switch tests**

Run the Task 3 test command again.

Expected: all switch-control-flow tests pass with valid call/result pairing.

## Task 4: Warn when compacting a K3 session

**Objective:** Let compaction operate on K3 exactly as on other models, but warn the user that Moonshot flags cross-turn reasoning loss as risky. Compaction stays lossy-but-well-formed: retained messages keep their `reasoning_content`, so no projection seam or capability-gated bypass is needed.

**Files:**

- Modify: `packages/core/src/context/compaction.ts`
- Modify: `packages/core/src/agent.ts`
- Test: `packages/core/test/compaction.test.ts`
- Test: `packages/core/test/agent.test.ts`

**Step 1: Write failing tests**

Create a model with `warnOnReasoningLoss: true` and history containing reasoning that crosses a compaction trigger. Assert that:

- automatic, overflow, and manual compaction all still run — the same code path as other models — and no `CompactionError` is raised solely because the model is K3;
- compaction on this model emits a new `AgentEvent` variant `{ type: "compaction-warning", message }` noting Moonshot flags cross-turn reasoning loss as risky. This is a net-new variant on the `AgentEvent` union in `agent.ts` — there is no generic warning channel today, and `agent-error` (recoverable) would misclassify a non-error notice. Update the union's exhaustive consumers/switches accordingly;
- retained (non-compacted) assistant messages still carry canonical reasoning as `reasoning_content` in the projected request;
- the projected context remains validly tool-paired.

Run:

```bash
bun test packages/core/test/compaction.test.ts packages/core/test/agent.test.ts
```

Expected: the warning assertion fails because no compaction warning exists for `warnOnReasoningLoss` models.

**Step 2: Emit the warning**

When compaction runs (auto, overflow, or manual) on a model with `warnOnReasoningLoss` set, emit the one-time `compaction-warning` event. Do not block compaction, alter its result, or add a K3-specific projection — `deriveContext` and accounting stay shared with every other model.

**Step 3: Verify context tests**

Run the Task 4 test command again.

Expected: all selected tests pass; existing models are unaffected and K3 compacts with a warning.

## Task 5: Add Kimi K3 to the TUI catalog and router

**Objective:** Make K3 connectable, selectable, resumable, and switchable through existing TUI/router flows.

**Files:**

- Modify: `packages/tui/src/models.ts`
- Test: `packages/tui/test/config.test.ts`
- Test: `packages/tui/test/models.test.ts`
- Test: `packages/tui/test/model-resolver.test.ts`
- Test: `packages/tui/test/routing-catalog.test.ts`
- Test: `packages/tui/test/app.test.tsx`

**Step 1: Write failing catalog/UI tests**

Assert that:

- Kimi appears in `/connect` and is unconfigured by default;
- storing `{ kimi: { apiKey: "..." } }` makes `Kimi K3` available;
- `resolveModelSelection("kimi", "kimi-k3", "max", config)` returns K3 with `{ kimi: { reasoningEffort: "max" } }`, 1M limits, and `warnOnReasoningLoss` set;
- the default variant is `max`;
- `kimi:kimi-k3:max` resolves through `ModelResolver` and appears in router targets;
- the model picker and variant picker show Kimi K3/max.

Replace the catalog-wide assertion that every model has at least two variants with an assertion that every reasoning model has at least one real variant. Add a K3-specific assertion that only `max` exists.

Run:

```bash
bun test packages/tui/test/config.test.ts packages/tui/test/models.test.ts packages/tui/test/model-resolver.test.ts packages/tui/test/routing-catalog.test.ts packages/tui/test/app.test.tsx
```

Expected: Kimi is absent and the one-variant invariant fails.

**Step 2: Add the catalog entry**

Add Kimi after the popular providers with:

- `requiredFields: ["apiKey"]`;
- model `kimi-k3`, lab `Lab.Kimi`, label `Kimi K3`;
- one `max` variant carrying `providerOptions: { kimi: { reasoningEffort: "max" } }` and marked default;
- routing `{ capability: 57, avgCostPerTask: 0.94 }` added to the module-level `ROUTING` record (keyed by model id), merged onto the variant via the existing `withRouting` path — not inlined on the entry;
- price `{ input: 3, output: 15 }` added to the module-level `PRICES` record;
- limits `{ contextWindow: 1_048_576, maxOutputTokens: 131_072 }` added to the module-level `LIMITS` record (omitting it fails `models.test.ts`, which asserts every configured model resolves with positive context/output limits);
- builder `KimiProvider.configure({ apiKey, baseURL }).chat(modelId)` (OpenAI-compatible facades expose `.chat()`; `.model()` is the Anthropic-only builder method).

Reuse the generic auth/config/connect/model-picker plumbing; do not add Kimi-specific UI state.

**Step 3: Verify catalog/UI tests**

Run the Task 5 test command again.

Expected: all selected tests pass and K3 is manually selectable and router-resolvable.

## Task 6: Add end-to-end cross-model reasoning tests

**Objective:** Prove the complete history passed to K3 across switches, persistence, tool loops, and previous compaction.

**Files:**

- Modify: `packages/core/test/switch-model.test.ts`
- Modify: `packages/core/test/session-models.test.ts`
- Modify: `packages/llms/test/provider-facades.test.ts`
- Modify: `packages/tui/test/controller.test.ts`

**Step 1: Add the integration matrix**

Cover these flows with captured provider requests:

1. non-Kimi reasoning → switch to K3 → K3 receives it as `reasoning_content`;
2. K3 reasoning + tool call → tool result → next K3 request replays the complete assistant message;
3. K3 → another provider → K3 reasoning remains persisted and is not converted to text;
4. K3 → another provider → K3 again → all retained reasoning is restored to K3;
5. compaction on another model → switch to K3 → K3 receives the compacted projection (summary plus retained messages) with reasoning replayed for every retained message;
6. save/resume a K3 session → next request retains reasoning and `kimi:kimi-k3:max` identity.

Use protocol/facade capture layers rather than a live key. Assert actual outbound JSON, not only canonical session state.

Run:

```bash
bun test packages/llms/test/provider-facades.test.ts packages/core/test/switch-model.test.ts packages/core/test/session-models.test.ts packages/tui/test/controller.test.ts
```

Expected: all matrix cases pass.

**Step 2: Confirm reasoning remains hidden**

Add or extend a transcript test with persisted and live reasoning. Assert `buildItems` and rendered frames contain neither reasoning text nor a reasoning row while assistant text and switch markers remain visible.

Files:

- Modify: `packages/tui/test/transcript.test.tsx`
- Modify: `packages/tui/test/app.test.tsx`

Run:

```bash
bun test packages/tui/test/transcript.test.tsx packages/tui/test/app.test.tsx
```

Expected: tests pass without changing `packages/tui/src/components/Transcript.tsx`; if a code change is necessary, limit it to preserving the existing hidden behavior.

## Task 7: Update architecture documentation and verify

**Objective:** Record the provider, history policy, and unavoidable cross-provider limitation, then run the repository gate.

**Files:**

- Modify: `ARCHITECTURE.md`
- Modify: `README.md` only if the implementation adds a provider/model usage example

**Step 1: Update architecture facts**

Document:

- Kimi in the lab/provider/model-card and facade lists;
- Kimi's OpenAI-compatible `reasoning_content` replay profile;
- canonical reasoning is persisted but hidden;
- switch sanitization retains non-tool assistant content;
- K3 compacts like any model, with a warning that Moonshot flags cross-turn reasoning loss as risky;
- foreign reasoning is never converted to visible text and is only serialized where the target protocol supports it;
- Moonshot's warning that cross-model K3 continuation remains quality-risky despite correct serialization.

**Step 2: Run focused package gates**

```bash
bun test packages/llms/test
bun test packages/core/test
bun test packages/tui/test --path-ignore-patterns='**/live/**'
```

Expected: all non-live tests pass.

**Step 3: Run repository verification**

```bash
bun run typecheck
bun run format:check
bun test packages/llms/test
```

Expected: all commands exit zero.

**Step 4: Optional credentialed smoke test**

With explicit user authorization and a funded Moonshot key:

```bash
MOONSHOT_API_KEY='<redacted>' bun packages/llms/scripts/smoke.ts
```

Expected: the Kimi target streams reasoning/text events and finishes successfully. Never print or persist the key.

## Risks and Tradeoffs

- **Moonshot does not endorse cross-model entry into K3.** Passing all available reasoning is necessary but may not prevent instability because the foreign model's reasoning distribution differs from K3's training history. The implementation must not claim stronger compatibility than wire correctness.
- **Compaction is lossy for K3, as for every model.** Moonshot recommends replaying all historical reasoning, but bounded context makes that impossible over long sessions. Swain compacts K3 like any other model and warns; it accepts degraded quality over dead-ending the session. The warning must not overstate the risk beyond what Moonshot documents.
- **Preserved reasoning increases cost.** Historical `reasoning_content` consumes input tokens on every K3 request. This is required by K3 and should be visible through existing usage counters.
- **Anthropic reasoning is signed.** Swain currently discards Anthropic signature deltas, so Kimi reasoning cannot be replayed as native Anthropic thinking and vice versa. The canonical text remains stored; signed-thinking replay is a separate feature.
- **The max-only ladder is temporary.** When Moonshot actually enables `low`/`high`, add them from verified docs in a follow-up spec; do not predeclare them.
- **The `kimi-k3` model id and max-only ladder are not confirmed by the API reference.** As of 2026-07-17 the reachable Moonshot docs (thinking-model guide, Chat Completions reference) describe preserved thinking for `kimi-k2.6` / `kimi-k2.7-code`; the `kimi-k3` id, pay-as-you-go availability, and `reasoning_effort: "max"`-only rest on the K3 blog citation, not the API reference. <!-- UNRESOLVED: confirm `kimi-k3` id + accepted `reasoning_effort` values against the live /v1/models or a credentialed smoke call before shipping; the Task 7 Step 4 smoke test is the intended gate. -->
- **Routing data is newly published and volatile.** Record the retrieval date in the implementation comment or post-implementation notes and update it independently of protocol behavior when benchmarks change.

## Out of Scope

- Kimi Code subscription/OAuth endpoints and model ID `k3`.
- Kimi K2.x models.
- Multimodal input blocks, despite K3 supporting images.
- Anthropic signed-thinking or OpenAI encrypted-reasoning replay.
- Displaying reasoning in the TUI.
- Truncating or summarizing reasoning blocks themselves, or converting reasoning to visible text. (Ordinary conversation compaction still applies to K3 and may drop whole turns, including their reasoning.)
- More than one successful switch per user turn.
