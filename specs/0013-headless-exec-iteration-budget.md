# Headless Exec Iteration Budget Implementation Plan

> Use subagents to implement this plan task-by-task.

**Goal:** Give `swain exec` (headless, non-interactive) a much higher tool-iteration budget than the interactive TUI, so autonomous long-horizon tasks (SWE-bench-style) are not force-concluded before the model writes or commits any code.

**Architecture:** `runTurn` already accepts an optional `maxIterations` (defaults to `DEFAULT_MAX_ITERATIONS = 20`). Thread a new optional `maxIterations` through `ControllerDeps` → `runTurnNow`'s `runTurn` call, and have the headless entrypoint pass a high exec budget. The interactive TUI entrypoint (`index.ts`) passes nothing and keeps the default 20.

**Tech Stack:** TypeScript, Bun, Effect, ink. Tests via `bun test`.

---

## Current context / assumptions

- Confirmed root cause (DeepSWE `abs-module-cache-flags` baseline, Swain v0.2.0, glm-5.2): the loop hit exactly 20 assistant turns spent entirely on read-only exploration (Grep×7, Read×6, Bash×6, **zero Write/Edit**), then the final-iteration "withhold tools" path force-concluded it as `success` with an **empty `model.patch`** (f2p 0/20, partial 0.13).
- The eval invokes `swain exec --permission-mode auto --model … --output-format stream-json --trace-dir …` — **no iteration flag**, and `evals/` is off-limits. So the higher budget must be the **code default** for the exec path.
- TB2 `cancel-async-tasks` used ~7 iterations; it is unaffected by this change (its failure is a separate verification-rigor issue, out of scope here).

**Key code facts (verified):**
- `packages/core/src/agent.ts:49` — `const DEFAULT_MAX_ITERATIONS = 20`.
- `packages/core/src/agent.ts:160-161` — `RunTurnOptions.maxIterations?: number` (already supported).
- `packages/core/src/agent.ts:393` — `maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS`.
- `packages/tui/src/controller.ts:154` — `interface ControllerDeps` (has `nonInteractive?: boolean` at :172).
- `packages/tui/src/controller.ts:764` — `runTurnNow` calls `runTurn(session, { onEvent, …router…, …nonInteractive… })` — does **not** pass `maxIterations`.
- `makeController` callers: `packages/tui/src/index.ts:109` (interactive) and `packages/tui/src/headless.ts:125` (exec).

## Proposed approach

Minimal, exec-scoped change:
1. Add `readonly maxIterations?: number` to `ControllerDeps`.
2. In `runTurnNow`, forward it to `runTurn` when defined (mirroring the existing `nonInteractive` spread pattern).
3. In `headless.ts`, pass `maxIterations: EXEC_MAX_ITERATIONS` (a named constant) into `makeController`.
4. Leave `index.ts` (interactive) untouched → interactive stays at the default 20.

**Budget value:** `EXEC_MAX_ITERATIONS = 200`. This is a *backstop*, not a target — the model still emits a final text and stops when done; the real wall-clock bound is the harness agent timeout (DeepSWE = 5400s). 200 leaves ample room for explore → implement → test → fix → commit on a large multi-file task while still preventing an unbounded runaway loop.

---

### Task 1: Thread `maxIterations` through the controller

**Objective:** `ControllerDeps.maxIterations`, when set, is forwarded to `runTurn`.

**Files:**
- Modify: `packages/tui/src/controller.ts` (add field to `ControllerDeps` near :172; spread into the `runTurn` options in `runTurnNow` near :764)
- Test: `packages/tui/test/controller.test.ts`

**Step 1: Write failing test**

Add a test that drives a controller whose scripted LLM emits more than 20 tool-call turns then a final text turn, with `maxIterations` set high, and asserts the turn completes with the final assistant text (no `max-iterations` `agent-error`).

> **Verified helper facts (from adversarial review — use these exactly):**
> - `toolCallTurn(name, input)` is **2-arg** (`controller.test.ts:47`) — e.g. `toolCallTurn("Bash", { command: "echo 1" })`. `textTurn(text)` exists.
> - The `build(llm, permissionMode?, persist?)` fixture (`controller.test.ts:88-108`) takes a `scripted(...)` result and does **not** thread `maxIterations`. So construct the controller **directly via `makeController({...})`** the way the existing direct-construction test does (`controller.test.ts:129-137`), adding `maxIterations`. (Alternatively extend `build` to accept an optional `maxIterations` and forward it — pick whichever is least noisy against the file.)
> - The live session is reached via `c.getState().session` (`getState` at `controller.test.ts` usages `:167`, `:855`) — **there is no `controller.session`**.
> - Drive to completion with the same submit/settle pattern the surrounding tests use (`submitPrompt` + the file's existing idle/settle await), not an invented `waitUntilIdle`.

Sketch (align field names to the direct `makeController` call at `controller.test.ts:129-137`):

```typescript
test("forwards maxIterations to runTurn (exec budget exceeds 20)", async () => {
  const turns = [
    ...Array.from({ length: 25 }, (_, i) => toolCallTurn("Bash", { command: `echo ${i}` })),
    textTurn("done"),
  ]
  const c = makeController({ /* …same deps as controller.test.ts:129-137… */, maxIterations: 200 })
  await c.submitPrompt("go")
  // …await the file's existing turn-settled condition…
  const last = c.getState().session.messages.at(-1)
  expect(last).toMatchObject({ role: "assistant", content: [{ type: "text", text: "done" }] })
})
```

**Step 2: Run test to verify failure**

Run: `bun test packages/tui/test/controller.test.ts`
Expected: FAIL — without the wiring, the run stops at the 20-iteration cap (`AgentError{reason:"max-iterations"}`, mirrored by `agent.test.ts:658-666`), so the final message is not `"done"`.

**Step 3: Write minimal implementation**

In `ControllerDeps` (after the `nonInteractive?` field):
```typescript
  /**
   * Upper bound on tool-call iterations per turn. Omitted → runTurn's default
   * (20). Headless exec sets this high for autonomous long-horizon tasks.
   */
  readonly maxIterations?: number
```

In `runTurnNow`, inside the `runTurn(session, { … })` options object, add alongside the existing `nonInteractive` spread:
```typescript
      ...(deps.maxIterations !== undefined && { maxIterations: deps.maxIterations }),
```

**Step 4: Run test to verify pass**

Run: `bun test packages/tui/test/controller.test.ts`
Expected: PASS.

---

### Task 2: Set the high exec budget in headless

**Objective:** `swain exec` runs with `EXEC_MAX_ITERATIONS = 200`; interactive TUI unchanged.

**Files:**
- Modify: `packages/tui/src/headless.ts` (add the constant; pass `maxIterations` in the `makeController({ … })` call at :125)
- Test: `packages/tui/test/headless.test.ts`

**Step 1: Write failing test**

Add a `runHeadless` test that scripts >20 tool-call turns then a final text, asserting exit 0 with the final text emitted (proving exec exceeds the 20-iteration cap).

> **Verified helper facts (from adversarial review — use these exactly):**
> - Call **`seedAuth()` first** — without it the provider is unconfigured and `runHeadless` returns 1 before any turn runs (`headless.test.ts:141-147`). Every passing test seeds auth first.
> - `toolCallTurn(name, input)` is **2-arg** (`headless.test.ts:29`): `toolCallTurn("Bash", { command: … })`.
> - stdout is captured by the **describe-scoped `out` string** wired through the `options(...)` helper's `stdout` callback (`headless.test.ts:69, 97-99`). There is **no** stdout seam in `testDeps` (which only carries `llmLayer`, `headless.ts:20-22`). Assert against `out`.
> - `scripted(turns).layer` is the llm layer; `scripted.next()` repeats the last turn forever, so with default 20 the withheld-tools final iteration still returns a tool-call → loop hits the cap → `fatal` → exit 1.

```typescript
test("exec allows more than 20 tool iterations", async () => {
  seedAuth()
  const turns = [
    ...Array.from({ length: 25 }, (_, i) => toolCallTurn("Bash", { command: `echo ${i}` })),
    textTurn("finished"),
  ]
  const code = await runHeadless(options("go"), { llmLayer: scripted(turns).layer })
  expect(code).toBe(0)
  expect(out).toContain("finished")   // `out` = describe-scoped capture from options()
})
```

**Step 2: Run test to verify failure**

Run: `bun test packages/tui/test/headless.test.ts`
Expected: FAIL — before the constant is wired, exec caps at 20, the turn ends in `max-iterations` (exit 1), and `out` never contains `"finished"`.

**Step 3: Write minimal implementation**

Near the top of `headless.ts` (module scope):
```typescript
/**
 * Tool-iteration backstop for autonomous exec runs. Much higher than the
 * interactive default (20): long-horizon tasks must not be force-concluded
 * mid-work. The real wall-clock bound is the caller's agent timeout.
 */
const EXEC_MAX_ITERATIONS = 200
```

In the `makeController({ … })` call, add:
```typescript
      maxIterations: EXEC_MAX_ITERATIONS,
```

**Step 4: Run test to verify pass**

Run: `bun test packages/tui/test/headless.test.ts`
Expected: PASS.

---

### Task 3: Full verification

**Objective:** No regressions; interactive default preserved.

**Steps:**
1. Run: `bun run typecheck` — Expected: clean.
2. Run: `bun run format:check` — Expected: clean (run `bun run format` if needed).
3. Run: `bun test packages/core/test packages/tui/test --path-ignore-patterns='**/live/**'` — Expected: all pass, including the existing `agent.test.ts` max-iterations tests (interactive default 20 unchanged) and `index.ts` still constructs the controller with no `maxIterations`.

## Files likely to change

- `packages/tui/src/controller.ts` (+ ~4 lines: field + spread)
- `packages/tui/src/headless.ts` (+ ~3 lines: constant + arg)
- `packages/tui/test/controller.test.ts` (+1 test)
- `packages/tui/test/headless.test.ts` (+1 test)

No changes to `packages/core` (runTurn already supports the option). No changes to `index.ts`. No changes to `evals/`.

## Tests / validation

- Unit: controller forwards `maxIterations`; headless exec exceeds 20 iterations.
- Regression: `agent.test.ts` max-iterations tests still pass (default preserved).
- End-to-end (post-release, separate step): cut `0.2.1-eval.N`, run the DeepSWE single task; expect a **non-empty `model.patch`** and f2p > 0 (baseline was empty / 0-20). Success target is reward=1.0, but even partial f2p confirms the truncation is fixed.

## Risks, tradeoffs, and open questions

- **Context overflow:** 200 iterations accumulate large context. The loop compacts once on overflow (`runWithOverflowRetry`) and large tool results are offloaded (`tool-result-storage`). A second overflow still fails the turn. If, post-fix, DeepSWE fails on context rather than iterations, that is the *next* lever (out of scope here) — do not pre-optimize.
- **Cost/time:** a higher cap means a stuck model could burn more tokens/time before the harness timeout. Accepted: the cap is a backstop; the model normally concludes when done, and the harness agent timeout bounds wall-clock.
- **Value choice:** 200 is a judgment call. If DeepSWE still truncates at 200 (unlikely for this task size), raise further; if runs are wastefully long, lower. Tunable in one constant.
- **Not sufficient alone:** raising iterations unblocks implementation but does not guarantee reward=1.0 — glm must still implement all 20 hidden behaviors correctly and commit. Measured empirically after release.
- **Subagent iteration cap (deliberately deferred).** `orchestrator.ts:182` (`defaultRunner`) hardcodes `runTurn(ctx.session, { maxIterations: 20 })` for every Agent-tool subagent; it is **not** threaded from `ControllerDeps`, so a subagent spawned during exec still truncates at 20. **Decision: out of scope for this spec.** Rationale: the confirmed baseline did the work in the *main* loop (Grep/Read/Bash directly, zero Agent calls), so the main-loop fix addresses the observed failure; extending the budget to subagents needs separate plumbing through `OrchestratorConfig`/`defaultRunner`, worse attribution, and isn't justified by current evidence (YAGNI). **Verification hook:** after the release run, inspect the trace — if glm delegated implementation to a subagent and that subagent hit `max-iterations`, promote the subagent-budget change to its own follow-up spec.

## Post-Implementation Changes

Implemented as specified: `ControllerDeps.maxIterations` threaded into `runTurnNow`'s `runTurn` call; `headless.ts` sets `EXEC_MAX_ITERATIONS = 200`. Interactive TUI (`index.ts`) unchanged. 587 core+tui tests pass; typecheck/format clean.

**Measured effect (glm-5.2, released as `0.2.1-eval.1`):**
- DeepSWE `abs-module-cache-flags`: **f2p 0/20 → 19/20** (partial 0.13 → 0.96). Baseline (v0.2.0, cap 20) produced an **empty patch** — 19 read-only exploration calls, force-concluded before any Write/Edit. With the 200 budget glm used **135 iterations**, ran `go test` 21×, committed to a branch, and implemented almost the whole task. The one remaining miss (`TestChallengeRequireCycleDetection`) is a glm capability/convention choice (it returned a bespoke `*object.CycleError` instead of the standard `*object.Error`), not an iteration issue — left as-is.
- TB2 `cancel-async-tasks`: unaffected (uses ~11–14 iterations, well under both caps); its pass rate is glm-variance-bound.

Kept — clearly correct, general improvement (any long-horizon task benefits; nothing eval-specific).

**Deferred (per Risks):** subagent iteration cap still hardcoded at 20 (`orchestrator.ts:182`); only matters if a run delegates implementation to an Agent subagent (observed runs did not).
