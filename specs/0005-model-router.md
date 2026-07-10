# Automated Model Router Implementation Plan

> Use subagents to implement this plan task-by-task.

**Goal:** Add an automated model router that lets users enable routing globally with `/router`, choose which connected models and effort variants are routable, and let the active model switch or delegate to enabled model targets when the task calls for it.

**Architecture:** Router state is global TUI config, while the effective model for a conversation is session-local state. The active model receives a compact list of enabled routable targets in the system prompt and can call a normal model-visible `SwitchModel` tool. Core treats that tool as a special control-flow result: it records a typed/meta transcript switch event, updates the session current model, and immediately continues the same user turn on the selected target. Subagents use an optional `Agent.model` target override; omitted overrides inherit the parent session's current model.

**Tech Stack:** Bun workspace, TypeScript ESM, Effect, Effect Schema, `@effect/platform(-bun)`, `@swain/llms`, Ink/React, Bun test runner, Biome.

---

## Decisions

- `/router` opens a TUI dialog only. No v1 command argument grammar.
- Router config is global user config in `~/.config/swain/config.json`, like `/model` and `/connect` state.
- New sessions start from the global active model. Existing conversations resume on their last session-local current model.
- `/model` keeps today's behavior of updating the global default, and also records an explicit session-local model switch for the current conversation.
- `SwitchModel` is a normal model-visible tool, not a provider protocol action. Core intercepts it as control flow instead of letting it behave like an ordinary tool result.
- `SwitchModel` is not a fork primitive; it updates the current session's model and records a trace event.
- Each routable target is identified as `provider:modelId[:variant]`.
- `/router` is model-first: the main view lists connected models, shows enabled variants in brackets, and opens a one-level submenu for effort/variant toggles.
- Connected models default to routable with all catalog variants enabled. For models with provider effort controls, the catalog exposes the full discrete effort ladder; for models without effort controls, the only variant is `[default]`. Users opt models or variants out.
- Router is effectively inactive unless the global toggle is on and at least two enabled connected targets exist.
- Only enabled connected targets are shown to the model. Disabled targets are invisible to prompt guidance and rejected by runtime validation.
- `SwitchModel` can be in the built-in registry, but it is only exposed in the LLM tool list when router status is `on`; runtime validation still rejects inactive or disallowed targets.
- The current target is included in router prompt metadata with `current: true`, but instructions say not to call `SwitchModel` for it. Same-target `SwitchModel` calls are no-op success.
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
- Fixing Anthropic extended-thinking effort levels is in scope as Task 0 so Anthropic variants are real request options, not inert catalog rows.
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
  readonly score: number
  readonly higherIsBetter?: boolean
}

interface RoutingProfile {
  readonly inputCostPerMillion?: number
  readonly outputCostPerMillion?: number
  readonly avgTokensPerTask?: number
  readonly capability?: number
  readonly relCostEstimate?: number
  readonly relCostBasis?: "published-price" | "measured-usage" | "manual-estimate"
  readonly benchmarks: ReadonlyArray<RoutingBenchmark>
  readonly capabilitySummary: string
  readonly estimated?: boolean
}
```

Attach `routing?: RoutingProfile` to each model default and variant. Initial benchmark/cost data is hard-coded from values supplied during implementation. If any field is unknown, it must be represented explicitly and prompt text must say the data is unknown, not infer it.

Prompt-facing `relCostEstimate` is stored in catalog metadata when there is a defensible basis. It is a unitless approximate multiplier such as `~1x`, `~2x`, or `~5x`, chosen from supplied model pricing and expected effort-token volume. For effort ladders, the lowest/default effort for that model/provider is usually `~1x`; higher efforts may get larger multipliers. `relCostBasis` records whether the estimate came from published token prices only, measured Swain usage, or a manual estimate.

Evidence behind the estimate:

- OpenAI documents that hidden reasoning tokens are billed as output tokens and can range from hundreds to tens of thousands depending on task complexity.
- Azure OpenAI documents that higher `reasoning_effort` generally produces more reasoning tokens.
- Anthropic documents `budget_tokens` as a maximum/target, not guaranteed usage, and says Claude may not use the entire budget.
- AWS/Anthropic guidance recommends monitoring actual thinking token usage because actual usage varies by task.

Conclusion: effort cost uplift is real, but exact multipliers are estimates. If `relCostEstimate` is absent, prompt rendering should show token prices and say effort-token uplift is unknown rather than inventing a multiplier.

Variant coverage:

- Models with a provider-native effort setting expose every supported discrete effort rung as catalog variants.
- Anthropic thinking is continuous, so Swain defines discrete budget buckets in the catalog; benchmark/cost estimates for interpolated buckets must set `estimated: true`.
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
- `pastModels` is deduped by target ID and ordered by first time it stopped being current.
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

## Task 0: Wire Anthropic extended thinking

**Objective:** Make Anthropic effort variants actually affect the request body.

**Files:**
- Modify: `packages/llms/src/protocols/anthropic-messages.ts`
- Test: `packages/llms/test/anthropic-thinking.test.ts`

**Step 1: Write failing tests**

- A request with `providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } } }` emits `thinking: { type: "enabled", budget_tokens: 4096 }` in the Anthropic request body.
- Existing Anthropic streaming decode for thinking deltas still passes.

**Step 2: Run tests to verify failure**

Run:

```bash
bun test packages/llms/test/anthropic-thinking.test.ts packages/llms/test/anthropic-messages.test.ts
```

Expected: FAIL because `thinking` is currently not encoded.

**Step 3: Implement**

- Extend Anthropic provider options with `thinking?: { type: "enabled"; budgetTokens: number }`.
- In request preparation, lower it to Anthropic wire format `thinking: { type: "enabled", budget_tokens: budgetTokens }`.
- Keep this SDK-free and protocol-local.

**Step 4: Verify**

Run:

```bash
bun test packages/llms/test/anthropic-thinking.test.ts packages/llms/test/anthropic-messages.test.ts
```

Expected: PASS.

## Task 1: Router target helpers and catalog metadata

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
- Every routable target with complete metadata has `capability` in `[0, 100]`, positive `relCostEstimate` when supplied, a valid `relCostBasis` when `relCostEstimate` is supplied, positive `avgTokensPerTask` when supplied, and non-negative token costs.
- Effort variants for the same model can have distinct `relCostEstimate` so low-effort and high-effort variants can compare correctly even when per-token prices match.
- Models with effort controls expose the full catalog ladder by default; models without effort controls expose only a default target.

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
- Attach supplied cost/benchmark metadata. Do not invent benchmark values.
- Add Anthropic effort helper variants only after Task 0 wires the provider option.
- Mark interpolated Anthropic bucket metadata with `estimated: true`.

**Step 4: Verify**

Run:

```bash
bun test packages/tui/test/router.test.ts packages/tui/test/routing-catalog.test.ts
```

Expected: PASS.

## Task 2: Router config persistence and derived routing state

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

## Task 3: Session-local current and past models

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

## Task 4: Model resolver bridge

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

## Task 5: Typed switch transcript rendering foundation

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

## Task 6: `SwitchModel` control-flow tool

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
  - append the typed switch meta message;
  - replace active request options with the resolved target's request options;
  - discard free-text assistant content from the switching model before the switch trace;
  - reassemble the system prompt with the new current target;
  - continue the same user turn on the target model;
  - do not append an ordinary `tool-result` message for successful switches.
- Keep ordinary recoverable tool errors visible if resolution fails.

**Step 4: Verify**

Run the switch and agent loop tests.

## Task 7: Router prompt block

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
- Instructions describe `Agent.model` and its default inheritance.

**Step 2: Verify failure**

Run:

```bash
bun test packages/core/test/prompt-router.test.ts
```

**Step 3: Implement**

- Add optional router context to `RunTurnOptions` or session context.
- Store model metadata as structured TS/JSON data, then render it into a compact markdown list or table in the system prompt.
- Include one prompt entry per enabled target:
  - `id`
  - label
  - current
  - `capability`
  - `relCostEstimate` when known, rendered approximately
  - `relCostBasis` when `relCostEstimate` is present
  - optional raw costs and benchmark references when useful
  - capability summary
  - estimated/unknown markers
- Append router guidance only when status is `on`.
- Recompute router context at the start of each user turn and again after a successful switch.

**Step 4: Verify**

Run the prompt router test.

## Task 8: `Agent.model` target override

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

## Task 9: `/router` dialog and status line

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

## Task 10: Verification sweep

**Objective:** Prove the router works without regressing current single-model behavior.

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
- Confirm Anthropic effort targets carry `thinking.budget_tokens` in encoded requests.
- Ask a first-turn trivial prompt from an expensive default: observe either no switch with a reasoned answer or an early traceable down-route before substantive work.
- Ask a conversation that grows harder after a cheap current model: observe a traceable up-route when appropriate.
- Use `/model` mid-conversation: global default updates and the transcript shows a user-driven switch.
- Resume the session: it starts on the last current model from session metadata.
- Remove credentials or disable a target between prompt and switch in a test harness: `SwitchModel` returns a recoverable no-op error.

## Risks

- Self-routing may under-route because the active model judges its own suitability. The plan mitigates this with explicit prompt guidance and traceable outcomes; a dedicated router model is deferred.
- Hard-coded benchmark and cost data will become stale. The schema isolates it so a hosted metadata feed can replace it later.
- `relCostEstimate` is only as good as the supplied pricing and effort-token assumptions. Wrong multipliers can mis-rank variants; tests should catch missing or invalid values, not business accuracy.
- Cross-provider switches rely on provider-neutral message history. Existing schema supports this, but request options must be replaced, not merged.
- Dynamic tool schemas would reduce invalid target calls, but current static registry makes runtime validation the lower-risk implementation.

## Deferred

- Hosted model metadata API and cache.
- Dedicated small router model before the main model runs.
- Dynamic per-turn enum schemas for `SwitchModel.model` and `Agent.model`.
- Cost caps or user-selectable routing objective profiles.
- More detailed router telemetry beyond transcript switch events and session `pastModels`.
