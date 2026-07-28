# Per-Turn Wall-Clock Watchdog Implementation Plan

> Use subagents to implement this plan task-by-task.

**Goal:** Bound a single model turn's total streaming time so a runaway generation (a model that streams continuously for many minutes) is aborted and retried instead of consuming the whole run's wall-clock budget. (The retry re-issue relies on runaway being stochastic; the cap is sized so even a persistently-runaway turn exhausts its retry budget in bounded time — see Proposed approach.)

**Architecture:** Wrap the per-attempt stream drain in `packages/core/src/agent.ts` with a total-duration `Effect.timeoutFail` that raises a **retryable** `LLMError`, placed inside the existing `Effect.retry`. A runaway turn trips the cap, fails retryably, and the existing exponential backoff re-issues it; because runaway is stochastic per request, a retry usually lands a fast turn. The cap is a module constant, threaded as an optional `RunTurnOptions.maxTurnDuration` purely for test injection — exactly mirroring how `maxIterations` is threaded.

**Tech Stack:** TypeScript, Bun, Effect (`Effect.timeoutFail`, `Duration`). Tests via `bun test packages/core/test`.

---

## Current context / assumptions

A turn's provider stream has one watchdog today: the **idle** timeout in `packages/llms/src/llm.ts` (`STREAM_IDLE_TIMEOUT = 120s`, via `Stream.timeoutFail`), which resets on every emitted event. It catches a stream that goes *silent*, but **not** one that streams continuously without finishing.

**Observed failure (diagnosed via a faithful local replay probe, recorded in spec 0015):** glm-5.2 at `high` reasoning effort stochastically "runs away" — one observed turn streamed **53,717 events over ~587s** of continuous output (max inter-event gap ~5s, so the idle watchdog never fires). This burns the run's wall-clock budget and starves multi-turn tasks. It is **stochastic for the identical request** (in one batch, 3 of 4 identical requests were fast, 1 ran away), so aborting a runaway turn and retrying usually lands a fast turn.

**Constraints (from user, unchanged):** general reliability change only; no eval/benchmark awareness in code or comments; `packages/` only.

**Key code facts (verified):**
- `packages/core/src/agent.ts:501-511` — `streamOnce` is the per-attempt drain: `LLMClient.streamTurn(request).pipe(Stream.runForEach(... push + ctx.emit ...), Effect.as(events))`. A fresh `events` buffer per attempt.
- `agent.ts:522-534` — `streamOnce.pipe(Effect.retry(<exponential∩recurs(4), whileInput retryable>), Effect.catchAll(<emit agent-error, fail>), Effect.timed)`. Retryable errors are retried; the wall-cap error must be retryable to use this path.
- `Duration` and `LLMError` are already imported (`agent.ts:12`, `agent.ts:3`).
- Threading pattern to mirror (`maxIterations`): `RunTurnOptions.maxIterations?: number` (`:163`) → `LoopContext.maxIterations: number` (`:183`) → `ctx.maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS` (`:395`) → read as `ctx.maxIterations` in the loop (`:472`). `streamOnce` runs inside the same loop body, so `ctx` is in scope there.
- Test harness `agent.test.ts:473-535`: `flakyLLM(failures, retryable, success)` returns a layer whose `streamTurn` fails `failures` times then replays `success`; `runFlaky(flaky, state)` provides it. Retry tests run on the **real clock**.
- `AUTO_COMPACT`/idle timeout are unrelated and untouched.

## Proposed approach

Concrete values:
- `DEFAULT_MAX_TURN_DURATION = Duration.seconds(180)`. Generous vs. normal turns (seconds) yet below the observed ~587s runaway, so it catches runaways with margin. **Worst case is bounded but not small:** the wall-cap error shares the `MAX_STREAM_RETRIES = 4` budget (5 attempts), so a *persistently* runaway turn costs up to `5 × 180s + backoff(1+2+4+8) ≈ 915s` before failing. That is deliberately under half the 1800s run wall so real task work still has budget even in the pathological all-runaway case. The design relies on runaway being **stochastic** (~1/3 per the probe): the *typical* cost is one ~180s abort plus a fast retry (P(k consecutive runaways) ≈ (1/3)^k). 180s (not 300s) is chosen specifically to keep that worst case well under the wall.
- New retryable error message: `Turn exceeded max duration of <n>s.` (distinct from the idle-stall message for diagnosability).

---

### Task 1: Add the constant and thread `maxTurnDuration`

**Objective:** A `maxTurnDuration` is available in the loop context, defaulting to `DEFAULT_MAX_TURN_DURATION`, overridable via `RunTurnOptions` (for tests).

**Files:**
- Modify: `packages/core/src/agent.ts`

**Steps (no behavior change yet — plumbing):**

1. Add the constant near `DEFAULT_MAX_ITERATIONS` (`agent.ts:49`):
   ```typescript
   const DEFAULT_MAX_TURN_DURATION = Duration.seconds(180)
   ```
2. Add to `RunTurnOptions` (after `maxIterations`, `:163`):
   ```typescript
     /**
      * Hard cap on a single turn's total streaming time. A turn that streams
      * continuously past this (a runaway generation) is aborted with a retryable
      * error so the bounded retry re-issues it. Defaults to
      * DEFAULT_MAX_TURN_DURATION; overridable mainly for tests.
      */
     readonly maxTurnDuration?: Duration.Duration
   ```
3. Add to `LoopContext` (after `maxIterations`, `:183`):
   ```typescript
     readonly maxTurnDuration: Duration.Duration
   ```
4. Set it in the `ctx` object (after `maxIterations:`, `:395`):
   ```typescript
     maxTurnDuration: options.maxTurnDuration ?? DEFAULT_MAX_TURN_DURATION,
   ```

**Verify:** `bun run typecheck` — clean (a new required `LoopContext` field with a matching assignment; no call site omits it).

---

### Task 2: Apply the wall-clock cap to each stream attempt

**Objective:** Each `streamOnce` attempt fails with a retryable `LLMError` if it streams longer than `ctx.maxTurnDuration`; the existing retry re-issues it.

**Files:**
- Modify: `packages/core/src/agent.ts:522-528` (the `streamOnce.pipe(Effect.retry(...))` chain)
- Test: `packages/core/test/agent.test.ts`

**Step 1: Write failing test**

Add alongside the retry tests (after the "does not retry a non-retryable error" test, ~`agent.test.ts:535`). It needs a fake whose stream *hangs* (never completes) for the first attempt, then recovers — reusing the existing `session`/`runFlaky` helpers but with a hanging stream:

```typescript
// LLM whose stream hangs (emits nothing and never completes) for the first
// `hangs` attempts, then replays `success`. Exercises the turn wall-clock cap.
const hangingLLM = (hangs: number, success: ReadonlyArray<LLMEvent>) => {
  let calls = 0
  return {
    calls: () => calls,
    layer: Layer.succeed(LLMClient.Service, {
      request: LLMClient.request,
      streamTurn: () => {
        calls += 1
        return calls <= hangs ? Stream.never : Stream.fromIterable(success)
      },
      generateTurn: () => Effect.succeed({ events: [] }),
    }),
  }
}

test("aborts a runaway turn on the wall-clock cap and retries", async () => {
  const flaky = hangingLLM(1, textTurn("recovered"))
  const state = session()
  submitPrompt(state, "hi")
  await Effect.runPromise(
    runTurn(state, { maxTurnDuration: Duration.millis(50) }).pipe(
      Effect.provide(flaky.layer),
      Effect.provide(toolContextLayer(state)),
      Effect.provide(toolRegistryLayer([])),
    ),
  )
  expect(flaky.calls()).toBe(2) // one runaway (timed out) + one success
  expect(state.messages.at(-1)).toMatchObject({
    role: "assistant",
    content: [{ type: "text", text: "recovered" }],
  })
})
```

Note for implementer:
- `runFlaky` hardcodes the options arg to `{}`; this test calls `runTurn(state, { maxTurnDuration: … })` directly (same provides as `runFlaky`) to inject the tiny cap.
- `Duration` is imported in the test file? Confirm — `agent.test.ts` imports from `effect` (`Effect, Layer, Schema, Stream`); **add `Duration`** to that import.
- `Stream.never` (type `Stream<never>`) is assignable to the client's `streamTurn` return (`Stream<LLMEvent, LLMError>`) by covariance.

**Step 2: Run to verify failure**

Run: `bun test packages/core/test/agent.test.ts -t "runaway"`
Expected: FAIL — without the cap, `Stream.never` hangs forever and the test times out (no wall cap exists yet).

**Step 3: Implement**

Insert `Effect.timeoutFail` as the first pipe stage on `streamOnce`, before `Effect.retry` (`agent.ts:522`):

```typescript
    const [responseElapsed, collected] = yield* streamOnce.pipe(
      Effect.timeoutFail({
        duration: ctx.maxTurnDuration,
        onTimeout: () =>
          new LLMError({
            reason: "network-error",
            message: `Turn exceeded max duration of ${Duration.toSeconds(ctx.maxTurnDuration)}s.`,
            retryable: true,
          }),
      }),
      Effect.retry(
        Schedule.exponential(STREAM_RETRY_BASE_DELAY).pipe(
          Schedule.intersect(Schedule.recurs(MAX_STREAM_RETRIES)),
          Schedule.whileInput((error: LLMError) => error.retryable),
        ),
      ),
      Effect.catchAll((error) =>
        ctx
          .emit({ type: "agent-error", source: "llm", message: error.message, recoverable: false })
          .pipe(Effect.andThen(Effect.fail(error))),
      ),
      Effect.timed,
    )
```

Placement rationale: inside the retry, so a timed-out (runaway) attempt is retried; the produced error is `retryable`, so `Schedule.whileInput` continues. Interrupting `streamOnce` on timeout discards that attempt's `events` buffer (fresh per attempt), so `session.messages` is unaffected — same abort semantics as the idle stall.

Add a short comment above the chain noting the two complementary watchdogs (idle silence in `llm.ts` vs. this total-duration cap on continuous runaways).

**Step 4: Run to verify pass**

Run: `bun test packages/core/test/agent.test.ts -t "runaway"`
Expected: PASS — attempt 1 times out at 50ms (retryable), attempt 2 replays `recovered`; `calls() === 2`.

**Step 5: Add the exhaustion test (symmetric to the idle give-up test)**

A persistently-runaway turn must exhaust the retry budget and fail, mirroring `agent.test.ts:519` for the stall path. Add:

```typescript
test(
  "gives up when the wall-clock cap trips every attempt",
  async () => {
    const flaky = hangingLLM(10, textTurn("never"))
    const state = session()
    submitPrompt(state, "hi")
    const exit = await Effect.runPromiseExit(
      runTurn(state, { maxTurnDuration: Duration.millis(50) }).pipe(
        Effect.provide(flaky.layer),
        Effect.provide(toolContextLayer(state)),
        Effect.provide(toolRegistryLayer([])),
      ),
    )
    expect(exit._tag).toBe("Failure")
    expect(flaky.calls()).toBe(5) // initial + 4 retries (MAX_STREAM_RETRIES)
    expect(state.messages.every((m) => m.responseDurationMs === undefined)).toBe(true)
  },
  // 5 aborts at 50ms + exponential backoff (1+2+4+8s) on the real clock.
  20000,
)
```

Run: `bun test packages/core/test/agent.test.ts -t "wall-clock cap trips"`
Expected: PASS — 5 attempts, all time out (retryable), budget exhausted, turn fails.

---

### Task 3: Full verification

**Objective:** No regressions.

**Steps:**
1. `bun run typecheck` — clean.
2. `bun run format:check` — clean (run `bun run format` if needed).
3. `bun test packages/core/test packages/llms/test --path-ignore-patterns='**/live/**'` — all pass (existing retry tests unaffected: their streams complete or fail fast, well under the 180s cap and the tiny test cap is only injected in the new test).

## Files likely to change

- `packages/core/src/agent.ts` (constant + option + context field + `Effect.timeoutFail` stage)
- `packages/core/test/agent.test.ts` (one test + `Duration` import)

No `evals/` changes.

## Tests / validation

- Unit: a hanging turn aborts on the injected 50ms cap and the retry recovers (`calls() === 2`).
- Regression: full `core` + `llms` suites green.
- End-to-end (post-release, separate step): cut a throwaway pre-release, re-run the 10-task TB2 set (at a low concurrency to avoid the provider-load confound). Compare pass count to the 3/10 baseline; keep if it recovers the runaway-timeout task(s) (e.g. path-tracing) or is neutral, roll back if it regresses.

## Risks, tradeoffs, and open questions

- **Aborting a legitimately long turn.** A turn genuinely needing >180s of continuous streaming would be aborted. Mitigated by the generous cap (normal turns are seconds) and by scoping it to headless exec only (see Post-Implementation Changes): interactive turns are uncapped, so a long reasoning stream in the TUI is never cut off. If a real exec workload needs longer, the cap is overridable via `RunTurnOptions`.
- **Retry may re-run away.** If the runaway were deterministic for a request, retries would repeatedly time out and exhaust the budget (~180s × up to 5 attempts ≈ 915s with backoff). The probe showed it is stochastic (3/4 identical requests were fast), so a retry usually recovers; worst-case remains bounded by the retry budget and is sized (via the 180s cap) to stay under half the run wall. A future refinement, if a persistent runaway is ever observed, is a *smaller* retry budget for this error class specifically (out of scope now — the shared budget keeps the change minimal).
- **Interrupt-based connection release.** The wall-cap interrupts `Stream.runForEach` from *outside* the stream (the idle timeout fails from *inside* it), relying on stream finalizers running on interruption to close the provider HTTP connection. This is the runtime's standard interruption machinery, but during implementation do a one-line sanity check that the aborted attempt does not leak a connection.
- **Partial emitted events on abort.** Interrupting mid-stream orphans already-`emit`ted partial events in the event stream (not in `session.messages`). Pre-existing behavior shared with the idle-stall abort (see 0015); de-dup belongs at the event consumer and is out of scope.
- **`Effect.timeoutFail` API.** Assumes the pipeable `Effect.timeoutFail({ duration, onTimeout })` form exists in the installed Effect version; if the signature differs, achieve the same (fail with the retryable `LLMError` after `ctx.maxTurnDuration`) with the version's API.
- **Not gaming.** General streaming-reliability change; no eval/benchmark awareness, no task-specific behavior.

## Post-Implementation Changes

Implemented as specified: `DEFAULT_MAX_TURN_DURATION = 180s` constant, threaded as `RunTurnOptions.maxTurnDuration` → `LoopContext`; `Effect.timeoutFail` per-attempt inside the existing retry; `LLMError` moved to a value import. Two tests (recover, exhaustion). 387 core+llms tests pass; typecheck/format clean. Released as `v0.2.1-eval.5`.

**Measured effect (glm-5.2, TB2, partial — background runs repeatedly killed externally; single-task and partial-batch data):**
- **The wall-cap works.** circuit-fibsqrt's trace shows `Turn exceeded max duration of 180s.` — the watchdog fires and bounds a runaway. It converts what was an eval.3 **crash** (circuit-fibsqrt `ConversionError`: NDJSON had no terminal result event) into a **graceful, scorable failure** (reward 0.0). Robustness win, no regression: the 3 consistently-passing tasks (break-filter-js-from-html, build-pov-ray, distribution-search) still pass.
- **But it does not flip a pass, and revealed the runaway is often *deterministic*.** circuit-fibsqrt ran away on *all 5 attempts* (initial + 4 retries) and exhausted the budget — glm-5.2 is genuinely stuck on that hard task, so the retry (which assumes stochastic recovery) cannot help; the cap only bounds the wasted ~900s.
- **The remaining failures are model-/provider-bound, not harness bugs.** Across runs the hard tasks fail from *different* transient causes: deterministic runaway (circuit-fibsqrt), idle stall (make-mips, `no data for 120s`), and a zai transport outage (path-tracing, `RequestError` — already retryable, but zai was unreachable across the whole retry window). The local replay probe proved context/TTFT handling is fine; it is glm capability + zai API reliability.

**Decision: KEEP.** A general robustness improvement — bounds runaway per-turn generation, prevents single-turn wall-clock exhaustion (the eval.3 path-tracing 1800s timeout mode), and turns crashes into graceful scorable failures — with no regression. It does not raise the pass count because the residual failures are glm-5.2 capability limits on hard tasks plus zai API reliability, which are outside `packages/`. A possible future refinement (out of scope): a smaller retry budget for the wall-cap error class, since a deterministic runaway wastes retries.

### Post-review revision (PR #39)

Review flagged two things about the original implementation, both addressed:

- **The cap is per *attempt*, not per turn.** Because `Effect.timeoutFail` sits *inside* `Effect.retry`, it re-arms on every attempt: it bounds a single provider-stream attempt at 180s, and a persistently-runaway turn can consume up to `5 × 180s + backoff ≈ 915s` across the retry budget. The constant, option doc, and error message ("Provider stream exceeded max duration…") now describe per-attempt semantics; earlier "single turn's total streaming time" wording was imprecise.
- **Scoped to headless exec only.** The cap was originally a core default (`DEFAULT_MAX_TURN_DURATION`) applied to every turn, so it also reached the interactive TUI. Since opencode's experience shows a hard wall-clock cap harms legitimately long interactive reasoning (they reverted a 60s cap for that reason) and the runaway only burns a hard budget on the eval/exec path, the constant moved to `headless.ts` as `EXEC_MAX_TURN_DURATION` and is threaded through `ControllerDeps` — mirroring `maxIterations`. `RunTurnOptions.maxTurnDuration` is now truly optional (omitted → no cap); interactive relies on the idle `STREAM_IDLE_TIMEOUT` alone. Related: the orphaned-partial-events risk above is tracked as issue #40.
