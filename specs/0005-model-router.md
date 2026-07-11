# Automated Model Router Implementation Plan

> Use subagents to implement this plan task-by-task.

**Goal:** Add an automated model router that lets users enable routing globally with `/router`, choose which connected models and effort variants are routable, and let the active model switch or delegate subagents to enabled model targets when the task calls for it.

**Architecture:** Router state is global TUI config, while the effective model for a conversation is session-local state. The active model receives a compact list of enabled routable targets in the system prompt and can call a normal model-visible `SwitchModel` tool. Core treats that tool as a special control-flow result: it records a typed/meta transcript switch event, updates the session current model, and immediately continues the same user turn on the selected target. Subagents use an optional `Agent.model` target override; omitted overrides inherit the parent session's current model.

**Tech Stack:** Bun workspace, TypeScript ESM, Effect, Effect Schema, `@effect/platform(-bun)`, `@swain/llms`, Ink/React, Bun test runner, Biome.

---

## Decisions

- `/router` opens a TUI dialog only. No command arguments.
- Router config is global user config in `~/.config/swain/config.json`, like `/model` and `/connect` state.
- New sessions start from the global active model. Existing conversations resume on their last session-local current model, which may be different from the global active model.
- `/model` keeps today's behavior of updating the global default, and also records an explicit session-local model switch for the current conversation, allowing the user to "steer" the conversation to a different model and trigger a `SwitchModel` tool call.
- `SwitchModel` is a normal model-visible tool, not a provider protocol action. Core intercepts it as control flow instead of letting it behave like an ordinary tool result.
- `SwitchModel` is not a fork primitive; it updates the current session's model and records a trace event.
- Each routable target is identified as `provider:modelId[:variant]`.
- `/router` is model-first: the main view lists connected models, shows enabled variants in brackets, and opens a one-level submenu for effort/variant toggles.
- Connected models default to routable with all catalog variants enabled. For models with provider effort controls, the catalog exposes the full discrete effort ladder; for models without effort controls, the only variant is `[default]`. Users opt models or variants out.
- Router is effectively inactive unless the global toggle is on and at least two enabled connected targets exist.
- Only enabled connected targets are shown to the model. Disabled targets are invisible to prompt guidance and rejected by runtime validation.
- `SwitchModel` can be in the built-in registry, but it is only exposed in the LLM tool list when router status is `on`; runtime validation still rejects inactive or disallowed targets.
- The current target is included in router prompt metadata with `current: true`, but instructions say not to call `SwitchModel` for it. Same-target `SwitchModel` calls are no-op.
- At most one successful model switch is allowed per user turn. Multiple switches are allowed across the conversation.
- After a successful switch, the next model request in the same user turn reassembles the system prompt so `current` and routing guidance reflect the new model.
- `SwitchModel` requires a short `reason`.
- Switches are traceable in transcript history as typed/meta events so the UI can render them differently from user messages.
- Session metadata tracks `currentModel` and `pastModels`. `pastModels` contains targets used earlier in the conversation but no longer active.
- `Agent.model` is optional. If omitted, the child inherits the parent session's current model. If supplied, it must be the current model or an enabled router target.
- `Agent.model` uses a static string schema with runtime validation. Dynamic per-turn enum schemas are deferred.
- Routing policy is correctness-first within reasonable cost. The prompt should encourage selecting the right target at the start of a conversation before substantive work. Later switches should be uncommon and mostly upward escalation when the task becomes more complex, risky, or correctness-sensitive; avoid late down-routing just to save cost.
- Router prompt entries use `capability` plus `relCostEstimate` as the primary comparison signal when cost estimates are available. `relCostEstimate` is catalog metadata, rendered approximately (for example `~1x`, `~2x`, `~5x`) because effort-level token uplift is real but task-dependent and not publicly standardized.
- Hard-coded model metadata is acceptable in v1. Token costs, effort-level token multipliers, and benchmark figures are supplied during implementation; the schema must make missing or estimated metadata explicit.
- Wiring provider reasoning and effort controls is in scope as Task 1 so effort variants are real request options, not inert catalog rows. Reasoning is unwired today for all three catalog providers that support it: Anthropic (declared but not encoded), DeepSeek, and Z.ai. Each uses a different request shape, and their effort ladders differ — Anthropic exposes `low`, `medium`, `high`, `xhigh`, and `max`; DeepSeek and Z.ai expose only `high` and `max`.
- `SwitchModel` is allowed in plan permission mode.
- If a target disappears because credentials/config changed between prompt assembly and tool execution, return a recoverable no-op tool error and continue on the current model. Add a test for this race.
- Status line shows a minimal router state: off, on, or inactive.

## Architecture Rationale

- Core stays catalog-agnostic. `SwitchModel` and `Agent.model` resolve target IDs through an injected `ModelResolver`; TUI owns catalog/config details.
- Router metadata is structured catalog data, rendered into the system prompt only for enabled targets.
- Session model state is separate from global config so auto-routing never mutates the user's default model.

## Current Context

- TUI model catalog and active-model resolution live in `packages/tui/src/models.ts`.
- Global config lives in `packages/tui/src/config.ts`; `saveConfig` currently persists only non-secret `activeModel`.
- Slash commands are parsed in `packages/tui/src/commands.ts` and mostly dispatched from `packages/tui/src/components/App.tsx`.
- The controller owns active model selection and request options in `packages/tui/src/controller.ts`.
- Core session state is in `packages/core/src/state/session.ts`; persistence is in `packages/core/src/state/store.ts`.
- The agent loop in `packages/core/src/agent.ts` currently assembles the system prompt once per `runTurn`, builds each request from `session.systemContext.model`, then executes tool calls normally. Router implementation must reassemble after a successful switch.
- The system prompt is assembled in `packages/core/src/prompt.ts`.
- Built-in tools are registered in `packages/core/src/tools/index.ts`.
- `Agent` is implemented in `packages/core/src/tools/agent.ts`; child sessions inherit `parent.session.systemContext.model` in `packages/core/src/orchestrator.ts`.
- Child tool filtering is in `packages/core/src/subagents/tools.ts`.

## Data Model

### Router Targets

Create target helpers in `packages/tui/src/router.ts`:

```ts
export interface RouterTargetRef {
  readonly provider: string
  readonly modelId: string
  readonly variant?: string
}

export type RouterTargetId = string // provider:modelId[:variant]
```

Rules:

- `targetId({ provider, modelId })` -> `provider:modelId`
- `targetId({ provider, modelId, variant })` -> `provider:modelId:variant`
- Parsing validates exactly two or three non-empty segments.
- Target IDs are the only strings accepted by `SwitchModel.model` and `Agent.model`.

### Router Metadata

Extend the existing catalog in `packages/tui/src/models.ts`:

```ts
interface RoutingBenchmark {
  readonly name: string
  readonly score: number // normalized 0-100, higher is always better
}

interface RoutingProfile {
  readonly inputCostPerMTok?: number
  readonly outputCostPerMTok?: number
  readonly contextWindow?: number
  readonly capability?: number
  readonly relCostEstimate?: number
  readonly relCostBasis?: "published-price" | "measured-usage" | "manual-estimate"
  readonly benchmarks: ReadonlyArray<RoutingBenchmark>
}
```

### Derived comparison signals

The harness computes aggregates from `RoutingProfile` and shows the model only the aggregates, never the raw arrays/prices:

- `benchmarkAvg` = mean of `benchmarks[].score` (already normalized 0–100, higher better).
- `aggregateCost` = `relCostEstimate × tokenCost`, where `tokenCost = inputCostPerMTok × 4 + outputCostPerMTok × 1` (fixed volume-weight blend). Not split by effort variant — `relCostEstimate` already carries the effort signal.
- Performance is presented as three signals: `capability`, `benchmarkAvg`, `contextWindow`.

This aggregation is a pure catalog helper (Task 2) with its own tests; Task 8 only renders the results.

Attach `routing?: RoutingProfile` to each model default and variant. Initial benchmark/cost data is hard-coded from values supplied during implementation. If any field is unknown, it must be represented explicitly and prompt text must say the data is unknown, not infer it.

Prompt-facing `relCostEstimate` is stored in catalog metadata when there is a defensible basis. It is a unitless approximate multiplier such as `~1x`, `~2x`, or `~5x`, chosen from supplied model pricing and expected effort-token volume. For effort ladders, the lowest/default effort for that model/provider is usually `~1x`; higher efforts may get larger multipliers. `relCostBasis` records whether the estimate came from published token prices only, measured Swain usage, or a manual estimate.

If `relCostEstimate` is absent, prompt rendering shows token prices and states that effort-token uplift is unknown rather than inventing a multiplier.

Variant coverage:

- Models with a provider-native effort setting expose every supported effort rung as catalog variants — all real API values, no Swain-invented buckets, so no interpolation/estimation for the effort mapping itself. Ladders are ragged and that is fine (the unified frontier absorbs it):
  - Anthropic Opus 4.8 / Sonnet 5: five adaptive-thinking effort levels (`low`, `medium`, `high`, `xhigh`, `max`).
  - Codex: native `low`, `medium`, `high`.
  - DeepSeek V4 flash/pro and Z.ai GLM-5.2: `off`, `high`, `max` only (`low`/`medium` clamp to `high`).
- Models with no effort API expose a single default target.
- `/router` starts with all catalog variants enabled for every connected model.

### Router Config

Extend `TuiConfig` in `packages/tui/src/config.ts`:

```ts
export const RouterConfig = Schema.Struct({
  enabled: Schema.Boolean,
  disabledModels: Schema.Array(Schema.String),
  disabledTargets: Schema.Array(Schema.String),
})
```

Semantics:

- `enabled` is the global master toggle, default `false`.
- `disabledModels` stores `provider:modelId` for whole-model opt-outs.
- `disabledTargets` stores full target IDs for variant opt-outs.
- Omitted `router` loads as disabled with empty opt-out sets.
- New connected models/variants are enabled by default because config stores opt-outs only.
- `saveConfig` must include `router` in the non-secret persisted object.

### Session Model State

Add serializable target identity to core session state without importing TUI types:

```ts
export interface SessionModelRef {
  readonly provider: string
  readonly modelId: string
  readonly variant?: string
}

export interface SystemContext {
  readonly model: Model
  readonly requestOptions: RequestOptions
  readonly modelRef: SessionModelRef
  readonly pastModels: ReadonlyArray<SessionModelRef>
  readonly permissionMode: PermissionMode
  readonly currentDate: string
}
```

Rules:

- `modelRef` is the current conversation model target.
- `requestOptions` is runtime state for the current model target (`providerOptions`/`generation`). `runTurn` reads it from the session every iteration.
- `pastModels` is deduped by target ID and ordered by first time it stopped being current. In v1 it is write-only: persisted for manual inspection/debugging of session model history, with no runtime reader.
- `createSessionState` requires `modelRef`; tests/helpers can derive `{ provider: model.provider, modelId: model.id }` when no variant exists.
- `saveSession` persists `modelRef` and `pastModels`.
- `requestOptions` is not persisted separately; TUI resume resolves persisted `modelRef` and rebuilds the live `Model` plus request options.
- `loadSession` remains caller-supplied with a live `Model` and request options, but also accepts the persisted `modelRef` used to create that live model. TUI resume must resolve the persisted `modelRef`, not the global active model.
- For legacy sessions without `modelRef`, load falls back to the model supplied by the caller and empty `pastModels`.

### Typed Switch Transcript Event

Extend `@swain/llms` message schema with a meta user content block:

```ts
export const ModelSwitchContent = Schema.Struct({
  type: Schema.Literal("model-switch"),
  from: Schema.Struct({ provider: Schema.String, modelId: Schema.String, variant: Schema.optional(Schema.String) }),
  to: Schema.Struct({ provider: Schema.String, modelId: Schema.String, variant: Schema.optional(Schema.String) }),
  reason: Schema.String,
  requestedBy: Schema.Literal("router", "user"),
})
```

Add it to `UserContent`. Persist it as a user `isMeta: true` message. Transcript rendering can later display it as a distinct switch row.

## Tracer Bullet

Before investing in catalog metadata (T2), config persistence (T3), or transcript/dialog UI (T6, T10), prove the riskiest mechanism end-to-end: a mid-turn model switch that reassembles the prompt, replaces request options, and continues the same turn on a possibly cross-provider model.

Build the thinnest vertical slice first — a reduced form of T4 + T5 + T7:

- Session-local `modelRef`/current model (minimal T4).
- A hard-coded two-target stub `ModelResolver` (no catalog, no config) that resolves exactly two live models, ideally cross-provider (minimal T5).
- `SwitchModel` control-flow interception in `runTurn`: reassemble prompt, replace request options, continue on the target (minimal T7).

Verify the loop actually switches mid-turn and the continued request is valid on the new provider. Only once this holds, layer the full catalog metadata, config, prompt block, `Agent.model`, and dialog behind it. The task numbering below is dependency order for the full build; the tracer slice cuts across T4/T5/T7 and runs first.

## Task 1: Wire provider reasoning and effort controls

**Objective:** Make effort selection actually change the request for every reasoning-capable provider in the catalog.

Reasoning is unwired today across all three providers: Anthropic declares a thinking variant that is never encoded, and DeepSeek and Z.ai carry no reasoning fields at all. Each provider uses a different request shape, so the work splits per provider. DeepSeek and Z.ai share one OpenAI-compatible protocol path, so 1.3 builds directly on 1.2.

Each subtask follows the same loop: write a failing test asserting the provider's request encodes the right reasoning fields for a given effort, run the subtask's test file to confirm it fails, add the provider option plus its encoding, then rerun to green. Each subtask below states only what differs — its files, the facts that drive it, what the test asserts, and what to implement. Keep every change SDK-free and local to the protocol and provider.

### Task 1.1: Anthropic adaptive thinking and effort

**Files:**
- Modify: `packages/llms/src/protocols/anthropic-messages.ts`
- Test: `packages/llms/test/anthropic-thinking.test.ts`

**Model variants:**
- Opus 4.8 and Sonnet 5 support adaptive thinking only. Manual budget-token thinking is rejected outright, so it is not used.
- Effort is a soft guidance level with five rungs: `low`, `medium`, `high`, `xhigh`, and `max`, defaulting to `high`. Both models support all five. The product UI labels `xhigh` as "Extra".
- Adaptive thinking must be enabled explicitly on Opus 4.8, and is on by default on Sonnet 5.
- These models reject any non-default temperature, top-p, or top-k on every request. The protocol sends those unconditionally today, so it must stop sending them for these models — a latent bug this feature exposes.

**Test asserts:** for each of the five effort levels, the request encodes adaptive thinking plus that effort; a non-default temperature, top-p, or top-k is not sent; existing thinking-delta stream decoding still passes.

**Implement:** add an adaptive-thinking provider option carrying an optional effort level and display mode; encode it into the request; drop non-default sampling parameters for these models.

### Task 1.2: DeepSeek reasoning and effort

**Files:**
- Modify: `packages/llms/src/protocols/openai-chat.ts`
- Modify: `packages/llms/src/providers/deepseek.ts`
- Test: `packages/llms/test/openai-chat-reasoning.test.ts`

**Model variants:**
- DeepSeek V4 flash and pro enable reasoning with a thinking flag and grade it with an effort parameter. Only `high` and `max` are distinct; lower requests clamp up to `high`. The catalog therefore exposes `off`, `high`, and `max`.
- DeepSeek silently ignores sampling parameters while reasoning, so no stripping is needed.
- Whether the effort parameter alone enables reasoning or must be paired with the thinking flag is unconfirmed; send both and confirm against the live API during implementation.

**Test asserts:** a request carrying reasoning at `high` or `max` encodes both the thinking flag and the effort level; a request without reasoning options encodes neither.

**Implement:** add optional thinking and effort fields to the shared OpenAI-chat options and to the DeepSeek options; encode them into the request body when present.

### Task 1.3: Z.ai reasoning and effort

**Files:**
- Modify: `packages/llms/src/providers/zai.ts`
- Test: extend `packages/llms/test/openai-chat-reasoning.test.ts`

**Model variants:**
- GLM-5.2 enables reasoning with a thinking flag and grades it with the same `high` and `max` levels as DeepSeek. Graded effort is specific to 5.2, so it is scoped to that model. The catalog exposes `off`, `high`, and `max`.

**Test asserts:** a request carrying reasoning at `high` or `max` encodes the thinking flag and effort level.

**Implement:** add the same optional thinking and effort fields to the Z.ai options; the shared protocol change from 1.2 already encodes them.

## Task 2: Router target helpers and catalog metadata

**Objective:** Define canonical target IDs and attach routing metadata to catalog entries.

**Files:**
- Create: `packages/tui/src/router.ts`
- Modify: `packages/tui/src/models.ts`
- Test: `packages/tui/test/router.test.ts`
- Test: `packages/tui/test/routing-catalog.test.ts`

**Step 1: Write failing tests**

- `targetId` encodes `provider:modelId[:variant]`.
- `parseTargetId` rejects malformed IDs.
- Every non-deprecated connected catalog model exposes at least one routable target.
- Every routable target has explicit routing metadata or an explicit unknown marker.
- Every routable target with complete metadata has `capability` in `[0, 100]`, positive `relCostEstimate` when supplied, a valid `relCostBasis` when `relCostEstimate` is supplied, positive `contextWindow` when supplied, and non-negative token costs.
- Effort variants for the same model can have distinct `relCostEstimate` so low-effort and high-effort variants can compare correctly even when per-token prices match.
- Models with effort controls expose the full catalog ladder by default; models without effort controls expose only a default target.
- The aggregation helper returns `benchmarkAvg` as the mean of benchmark scores and `aggregateCost` as `relCostEstimate × blended tokenCost`; missing inputs surface as explicit unknown, not silently zeroed.

**Step 2: Run tests to verify failure**

Run:

```bash
bun test packages/tui/test/router.test.ts packages/tui/test/routing-catalog.test.ts
```

Expected: FAIL because helpers and metadata do not exist.

**Step 3: Implement**

- Add target ID helpers.
- Add routing metadata interfaces.
- Add catalog traversal helpers that return all target refs for a model: default target when no variants exist, variant targets when variants exist.
- Add a pure aggregation helper computing `benchmarkAvg`, `aggregateCost`, and the performance-signal triple for a target's `RoutingProfile`.
- Attach supplied cost/benchmark metadata. Do not invent benchmark values.
- Add Anthropic effort helper variants only after Task 1.1 wires the provider option.
- Mark interpolated Anthropic bucket cost with `relCostBasis: "manual-estimate"` and leave `benchmarks` empty.

**Step 4: Verify**

Run:

```bash
bun test packages/tui/test/router.test.ts packages/tui/test/routing-catalog.test.ts
```

Expected: PASS.

## Task 3: Router config persistence and derived routing state

**Objective:** Persist global router settings and compute enabled connected targets.

**Files:**
- Modify: `packages/tui/src/config.ts`
- Modify: `packages/tui/src/router.ts`
- Test: `packages/tui/test/router-config.test.ts`

**Step 1: Write failing tests**

- `loadConfig` defaults missing `router` to off and empty opt-outs.
- `saveConfig` persists `router` and still never writes credentials.
- `enabledRouterTargets(config)` includes only configured providers.
- Disabled models remove all their variants.
- Disabled targets remove only that variant.
- `routerStatus(config)` returns `off`, `inactive`, or `on`; `inactive` means global on but fewer than two enabled connected targets.

**Step 2: Verify failure**

Run:

```bash
bun test packages/tui/test/router-config.test.ts
```

**Step 3: Implement**

- Extend `TuiConfig` schema.
- Update `emptyConfig`.
- Add pure router derivation helpers in `packages/tui/src/router.ts`.
- Keep opt-out arrays stable and deduped.

**Step 4: Verify**

Run the router config test.

## Task 4: Session-local current and past models

**Objective:** Separate the global default model from the current model of a persisted conversation.

**Files:**
- Modify: `packages/core/src/state/session.ts`
- Modify: `packages/core/src/state/store.ts`
- Modify: `packages/tui/src/controller.ts`
- Test: `packages/core/test/session-models.test.ts`
- Test: `packages/tui/test/controller.test.ts`

**Step 1: Write failing tests**

- Creating a session seeds `systemContext.modelRef` from the startup active model.
- Saving/loading preserves `modelRef` and `pastModels`.
- Resuming rebuilds `systemContext.requestOptions` from persisted `modelRef`.
- Legacy session metadata without `modelRef` still loads.
- Calling `/model` updates global config and records a session-local user model transition: previous `modelRef` moves into `pastModels`, new selection becomes `modelRef`.
- New conversation after `/clear` starts from the current global default, not from a previous session's auto-routed model.
- Resuming a routed session resolves and uses persisted `modelRef`, not global `activeModel`.

**Step 2: Verify failure**

Run:

```bash
bun test packages/core/test/session-models.test.ts packages/tui/test/controller.test.ts
```

**Step 3: Implement**

- Add `SessionModelRef` and `modelRef`/`pastModels`.
- Add a small core helper like `recordModelTransition(session, next, requestedBy)` that updates `modelRef` and `pastModels`.
- Persist fields in `session.json`.
- Update TUI session creation, clear, model selection, and resume paths to pass/resolve model refs.

**Step 4: Verify**

Run the tests above.

## Task 5: Model resolver bridge

**Objective:** Let core tools resolve router target IDs without importing TUI catalog code.

**Files:**
- Create: `packages/core/src/model-resolver.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/tui/src/controller.ts`
- Test: `packages/tui/test/model-resolver.test.ts`

**Step 1: Write failing tests**

- Resolving an enabled target returns a live `Model`, request options, and `SessionModelRef`.
- Unknown target ID returns a tagged `unknown-target` error.
- Disabled target returns a tagged `not-enabled` error.
- Target with credentials removed after prompt assembly returns a tagged `unavailable` error.

**Step 2: Verify failure**

Run:

```bash
bun test packages/tui/test/model-resolver.test.ts
```

**Step 3: Implement**

- Add `ModelResolver` `Context.Tag`.
- Define `ModelResolveError` with `unknown-target | not-enabled | unavailable`.
- TUI provides the resolver layer using `parseTargetId`, `enabledRouterTargets`, and `resolveModelSelection`.
- Resolver must replace request options for the target; never merge old provider options.

**Step 4: Verify**

Run the model resolver test.

## Task 6: Typed switch transcript rendering foundation

**Objective:** Persist model switches as structured meta transcript content.

**Files:**
- Modify: `packages/llms/src/schema/messages.ts`
- Modify: `packages/tui/src/components/Transcript.tsx`
- Test: `packages/llms/test/schema.test.ts`
- Test: `packages/tui/test/app.test.tsx` or create `packages/tui/test/transcript.test.tsx`

**Step 1: Write failing tests**

- `Message.user([{ type: "model-switch", ... }], true)` round-trips through schema decode.
- Transcript renders model switch blocks differently from normal user text and does not show them as plain user prompts.

**Step 2: Verify failure**

Run:

```bash
bun test packages/llms/test/schema.test.ts packages/tui/test/app.test.tsx
```

**Step 3: Implement**

- Add `ModelSwitchContent` to `UserContent`.
- Update transcript rendering with a compact switch row containing from, to, reason, and whether it was `router` or `user`.

**Step 4: Verify**

Run the tests above.

## Task 7: `SwitchModel` control-flow tool

**Objective:** Add model-visible `SwitchModel({ model, reason })` and intercept it as routing control flow.

**Files:**
- Create: `packages/core/src/tools/switch-model.ts`
- Modify: `packages/core/src/tools/index.ts`
- Modify: `packages/core/src/subagents/tools.ts`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/src/state/session.ts`
- Test: `packages/core/test/switch-model.test.ts`
- Test: `packages/core/test/agent.test.ts`

**Step 1: Write failing tests**

- `SwitchModel` input requires `model` and `reason`.
- A valid switch appends a typed meta model-switch message and updates `session.systemContext.model`, `modelRef`, and `pastModels`.
- A valid switch replaces `session.systemContext.requestOptions` with the target's request options; it never merges provider-specific options from the previous model.
- Same-target switch is a no-op success and does not append duplicate switch history.
- `SwitchModel` emitted alongside sibling tool calls: only the switch is applied, siblings are not executed, and the assistant message is replaced by the meta switch message (no orphan `tool_use`, no `tool_result` owed).
- `unavailable` resolver errors return a recoverable tool error and leave session unchanged.
- At most one successful switch is allowed per submitted user turn; a second switch in the same turn is a no-op or recoverable tool error per implementation choice, but it must not switch again.
- Child registries exclude `SwitchModel`.
- Plan permission mode does not deny `SwitchModel`.

**Step 2: Verify failure**

Run:

```bash
bun test packages/core/test/switch-model.test.ts packages/core/test/agent.test.ts
```

**Step 3: Implement**

- Define `SwitchModel` as a read-only/non-mutating tool from the permission-system perspective.
- Add it to built-in tools.
- Add it to child denylist.
- Filter the LLM-visible tool list so `SwitchModel` is sent only when router status is `on`; keep runtime validation for defense in depth.
- In `runTurn`, detect `SwitchModel` tool calls before ordinary tool continuation:
  - execute only the first successful switch for the current user turn;
  - if `SwitchModel` arrives alongside sibling tool calls in the same assistant message, honor only the switch and drop the siblings unexecuted; the next iteration on the target model regenerates any needed work;
  - replace the entire switching assistant message with the typed switch meta message, so no orphan `tool_use` blocks (switch or sibling) survive into history and no `tool_result` is owed;
  - replace active request options with the resolved target's request options;
  - reassemble the system prompt with the new current target;
  - continue the same user turn on the target model;
  - do not append an ordinary `tool-result` message for successful switches.
- Keep ordinary recoverable tool errors visible if resolution fails.

**Step 4: Verify**

Run the switch and agent loop tests.

## Task 8: Router prompt block

**Objective:** Inject enabled target metadata and routing policy only when router is active.

**Files:**
- Modify: `packages/core/src/prompt.ts`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/tui/src/controller.ts`
- Test: `packages/core/test/prompt-router.test.ts`

**Step 1: Write failing tests**

- With no router context, `assembleSystemPrompt` output matches current baseline.
- With router context, prompt includes only enabled targets.
- Current target row includes `current: true`.
- Disabled targets are absent.
- Instructions say same-target switches are unnecessary/no-op, max one switch per user turn, initial routing is encouraged before substantive work, and later switches should usually be upward escalation for complexity/correctness rather than cost-only down-routing.
- Instructions say to emit `SwitchModel` as its own sole tool call and stop generating; any sibling tool calls in the same message will be dropped and must be reissued after the switch.
- Instructions describe `Agent.model` and its default inheritance.

**Step 2: Verify failure**

Run:

```bash
bun test packages/core/test/prompt-router.test.ts
```

**Step 3: Implement**

- Add optional router context to `RunTurnOptions` or session context.
- Store model metadata as structured TS/JSON data, then render it into a compact markdown list or table in the system prompt.
- Include one prompt entry per enabled target, rendering computed aggregates (not raw benchmark scores or per-MTok prices):
  - `id`
  - label
  - current
  - performance signals: `capability`, `benchmarkAvg`, `contextWindow`
  - `aggregateCost` (`relCostEstimate × blended tokenCost`), rendered approximately
  - `relCostBasis` when `relCostEstimate` is present
  - unknown/unmeasured markers (empty `benchmarks`, absent cost)
- Append router guidance only when status is `on`.
- Recompute router context at the start of each user turn and again after a successful switch.

**Step 4: Verify**

Run the prompt router test.

## Task 9: `Agent.model` target override

**Objective:** Allow parent agents to delegate subagents to an enabled target.

**Files:**
- Modify: `packages/core/src/tools/agent.ts`
- Modify: `packages/core/src/orchestrator.ts`
- Modify: `packages/core/src/subagents/definitions.ts`
- Test: `packages/core/test/agent-model.test.ts`

**Step 1: Write failing tests**

- `Agent({ ..., model: "provider:model:variant" })` resolves the target and creates the child session with that model and model ref.
- Omitting `model` inherits the parent session's current model and request options.
- Disabled or unknown target returns a recoverable `Agent` tool error.
- If routing is inactive, supplied `model` is rejected unless it equals the current model.

**Step 2: Verify failure**

Run:

```bash
bun test packages/core/test/agent-model.test.ts
```

**Step 3: Implement**

- Add optional `model?: string` to `AgentInput`.
- Resolve supplied targets through `ModelResolver`.
- Pass resolved model/request options/model ref into `SpawnInput`.
- Ensure child session state carries the resolved or inherited request options; child `runTurn` reads them from session state.
- Update `Agent` description to explain model inheritance and router allowlist.

**Step 4: Verify**

Run the agent model test.

## Task 10: `/router` dialog and status line

**Objective:** Add user-facing router setup and a minimal status indicator.

**Files:**
- Modify: `packages/tui/src/commands.ts`
- Modify: `packages/tui/src/components/App.tsx`
- Modify: `packages/tui/src/controller.ts`
- Modify: `packages/tui/src/components/StatusLine.tsx`
- Create: `packages/tui/src/components/RouterDialog.tsx`
- Test: `packages/tui/test/commands.test.ts`
- Test: `packages/tui/test/router-command.test.ts`
- Test: `packages/tui/test/app.test.tsx`

**Step 1: Write failing tests**

- `/router` parses as a known command.
- `/router anything` is ignored or opens the dialog; no arg grammar is interpreted.
- Controller actions toggle global router enabled, model opt-out, and target opt-out.
- Status line displays `router off`, `router inactive`, or `router on`.
- Dialog model rows show bracketed enabled variants, e.g. `[low, medium, high]`.

**Step 2: Verify failure**

Run:

```bash
bun test packages/tui/test/commands.test.ts packages/tui/test/router-command.test.ts packages/tui/test/app.test.tsx
```

**Step 3: Implement**

- Add `router` command metadata.
- Add `Dialog` branch in `App`.
- Implement `RouterDialog`:
  - top row/global toggle;
  - connected model rows only;
  - row label includes bracketed enabled variant IDs or `[default]`;
  - Enter toggles whole model;
  - Right opens one-level variant submenu;
  - Escape cancels/closes.
- Add controller methods to persist router config through `persistConfig`.
- Add minimal status indicator.

**Step 4: Verify**

Run the TUI tests and manually smoke `/router`.

## Task 11: Verification sweep

**Objective:** Prove the router works without regressing current single-model behavior.

**Testability boundary:** routing-decision *quality* (does the model pick the right target) is non-deterministic and not unit-tested. Automated tests cover only mechanics — switch plumbing, target validation, one-switch-per-turn, mixed-batch drop, and the credential-race no-op. Decision quality is validated by the manual smoke below and deferred to a future eval harness.

**Files:**
- Existing tests only unless gaps require focused additions.

**Step 1: Run package checks**

```bash
bun run typecheck
bun run format:check
bun test packages/llms/test packages/core/test packages/tui/test
```

**Step 2: Manual TUI smoke**

- Start with one connected model and router on: status shows inactive; no router prompt block; no `SwitchModel` available.
- Connect or enable at least two targets: status shows on; prompt includes only enabled targets.
- Confirm router prompt entries include `capability` and catalog `relCostEstimate` when known, e.g. `low ~1x`, `medium ~2x`, `high ~5x`.
- Confirm Anthropic effort targets encode `thinking: {type: "adaptive"}` + `output_config.effort` (not `budget_tokens`) and omit non-default sampling params.
- Confirm DeepSeek and Z.ai effort targets encode top-level `thinking: {type: "enabled"}` + `reasoning_effort` (`high`/`max`).
- Ask a first-turn trivial prompt from an expensive default: observe either no switch with a reasoned answer or an early traceable down-route before substantive work.
- Ask a conversation that grows harder after a cheap current model: observe a traceable up-route when appropriate.
- Use `/model` mid-conversation: global default updates and the transcript shows a user-driven switch.
- Resume the session: it starts on the last current model from session metadata.
- Remove credentials or disable a target between prompt and switch in a test harness: `SwitchModel` returns a recoverable no-op error.

## Risks

- Self-routing may under-route because the active model judges its own suitability. The plan mitigates this with explicit prompt guidance and traceable outcomes; a dedicated router model is deferred.
- Hard-coded benchmark and cost data will become stale. The schema isolates it so a hosted metadata feed can replace it later.
- `relCostEstimate` is only as good as the supplied pricing and effort-token assumptions. Wrong multipliers can mis-rank variants; tests should catch missing or invalid values, not business accuracy.
- Cross-provider switches rely on provider-neutral message history. Existing schema supports this, but request options must be replaced, not merged. **Assumption:** provider adapters can translate an accumulated history (including thinking/tool blocks from another provider) into the target provider's request format. Invalidation: if an adapter rejects a foreign mid-conversation history, cross-provider routing is constrained to same-provider targets until adapters normalize. The tracer bullet verifies this before the full build commits to it.
- Thinking blocks are tied to the model that produced them. On any `SwitchModel` (including Anthropic→Anthropic effort changes and cross-provider), prior-turn `thinking`/`redacted_thinking` blocks must be stripped from the history sent to the new target — foreign models ignore them but still bill them as input tokens, and a mismatched producer can be rejected. The switch path must drop them.
- Relocating `requestOptions` from per-turn `RunTurnOptions` into `session.systemContext` touches every session, not just routed ones — broad blast radius. Mitigation: non-routed sessions seed `requestOptions` from the same source used today, and the existing single-model turn tests must pass unchanged (Task 11).
- Dynamic tool schemas would reduce invalid target calls, but current static registry makes runtime validation the lower-risk implementation.

## Deferred

- Hosted model metadata API and cache.
- Dedicated small router model before the main model runs.
- Dynamic per-turn enum schemas for `SwitchModel.model` and `Agent.model`.
- Cost caps or user-selectable routing objective profiles.
- More detailed router telemetry beyond transcript switch events and session `pastModels`.

---

## Post-Implementation Changes

Changes made after the implementation of this spec (commit `2e63d53`). These supersede the original spec where they conflict.

### Lab / provider / model / variant taxonomy

The catalog was refactored to separate a **lab** (who trains a model) from a **provider** (who serves it). A single model can be reachable through multiple providers — e.g. `gpt-5.5` is served by both the `openai` and `openai-codex` providers.

- New shared enums live in `@swain/llms`:
  - `packages/llms/src/schema/labs.ts` — `Lab` (`anthropic`, `openai`, `deepseek`, `zai`).
  - `packages/llms/src/schema/providers.ts` — `Provider` (adds `openai-codex`, `pollinations`).
- New per-lab model-card modules in `packages/llms/src/models/` (`anthropic.ts`, `openai.ts`, `deepseek.ts`, `zai.ts`, re-exported from `index.ts`) hold model ids, the effort/variant vocabulary, and each model's supported-variant list (`*ModelVariants`) as `as const satisfies` records.
- The TUI catalog in `packages/tui/src/models.ts` now consumes these enums instead of defining model/variant strings inline.

### Simplified model data

The `RoutingProfile` from the Data Model section (benchmarks array, `relCostEstimate`, `relCostBasis`, per-MTok token costs, `contextWindow`, plus derived `benchmarkAvg`/`aggregateCost`) was replaced by a two-field profile:

```ts
export interface RoutingProfile {
  readonly capability?: number     // 0–100 tier, higher is better
  readonly avgCostPerTask?: number // weighted average USD/task, lower is cheaper
}
```

- Figures are hard-coded from [Artificial Analysis](https://artificialanalysis.ai). Anthropic effort-variant capability is scaled from the `Max` variant using per-effort Humanity's Last Exam scores from Anthropic's system card, since AA does not publish per-effort Anthropic benchmarks. Gaps are documented inline (e.g. GPT-5.5 vs Pro, DeepSeek High cost).
- The Task 2 aggregation helper (`benchmarkAvg`, `aggregateCost`, performance triple) is gone. The prompt renders `capability N, avg cost ~$X/task` directly.

### Pareto-frontier target filtering

`enabledRouterTargets` now also drops targets with no routing data (`hasRoutingData`), and `routerPromptTargets` filters the enabled set through `paretoFrontier` before rendering. A target is dropped if another target `dominates` it (≥ capability and ≤ cost, strictly better on one axis), so the router only ever sees non-dominated capability/cost tradeoffs. Targets without routing data stay usable via `/model` but are never shown to the router.

### Tier-based routing prompt

`ROUTER_GUIDANCE` was rewritten to classify each request into an explicit tier — **Simple**, **Routine**, **Complex** (default), **Critical** — and pick the routable target that best fits that tier by weighing capability and cost together, rather than free-form "pick the best model" guidance.

### GPT-5.5 / 5.6 model cards

Added OpenAI model cards for `gpt-5.6` family (`sol`, `terra`, `luna`), and fixed `gpt-5.5` figures.

### Live routing eval harness

`packages/tui/test/live/router-eval.test.ts` drives the real Codex `gpt-5.5` model as the router's picker and asserts the tier prompt right-sizes the choice — cheap tasks stay cheap, only critical work reaches the top, with a monotonic Simple ≤ Routine ≤ Complex < Critical ordering. It hits a live backend and costs tokens, so it lives under `test/live/`, is excluded from the default `test` script via `--path-ignore-patterns`, and runs explicitly via `bun run test:live` (needs `OPENAI_CODEX_ACCESS_TOKEN`). This partially realizes the eval harness deferred in Task 11.
