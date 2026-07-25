# Stream-Stall Robustness Implementation Plan

> Use subagents to implement this plan task-by-task.

**Goal:** Stop the stream-idle watchdog and bounded retry from falsely killing a turn when a reasoning model legitimately produces no stream data for a while (large-context time-to-first-token or a silent reasoning gap), while still failing a genuinely dead stream in bounded time.

**Architecture:** Two coordinated, provider-agnostic changes in the streaming/retry layer: (1) raise the idle timeout in `packages/llms/src/llm.ts` and correct its rationale comment; (2) in `packages/core/src/agent.ts`, give the retry more attempts and exponential backoff instead of a single flat 1s delay. No behavior is provider- or task-specific; nothing references tests/benchmarks/evals.

**Tech Stack:** TypeScript, Bun, Effect (`Stream.timeoutFail`, `Schedule`). Tests via `bun test packages/llms/test packages/core/test`.

---

## Current context / assumptions

The LLM turn stream has two safety layers:

1. **Idle watchdog** — `packages/llms/src/llm.ts:46` `STREAM_IDLE_TIMEOUT = Duration.seconds(60)`, applied via `Stream.timeoutFail` (`llm.ts:55-63`). It resets on every emitted `LLMEvent` (including `reasoning-delta`, which the OpenAI-compatible decoder emits per SSE chunk — `packages/llms/src/protocols/openai-chat.ts:303`). So it fires only on **60s of total stream silence** — no text, no reasoning, no tool deltas. It fails with a `retryable: true` `network-error`.

2. **Bounded retry** — `packages/core/src/agent.ts:54-55` `MAX_STREAM_RETRIES = 2`, `STREAM_RETRY_DELAY = Duration.seconds(1)`, applied at `agent.ts:520-526` as `Schedule.recurs(MAX_STREAM_RETRIES)` gated by `whileInput(error.retryable)` with a flat `addDelay`. On exhaustion it emits a non-recoverable `agent-error` and fails the turn (`agent.ts:527-531`). The retry re-issues the same request (`streamOnce`, `agent.ts:499-509`); prior committed tool-uses in `session.messages` are untouched, so re-issuing is safe.

**Observed failure (current build, glm-5.2 @ `high` effort):** two turns that were actively progressing died with `Provider stream stalled: no data for 60s.`, and the stall recurred identically across the initial attempt **and** both retries (3 × 60s, then give-up). Identical recurrence indicates a **deterministic long silence** (the provider emitting nothing for >60s before the first token on a large context, or during an extended reasoning phase), not a transient network blip. The comment at `llm.ts:42-44` asserting streams "never gap more than ~10s" is the wrong assumption for a reasoning model.

**Why both levers.** Raising the idle timeout addresses the deterministic-silence case directly (give the first token more time to arrive). Exponential backoff + one or two more retries addresses the genuinely-transient case (a real drop that a slightly-later re-issue rides out). They are complementary; the timeout is the primary lever here.

**Worst case.** The watchdog is idle-based (`Stream.timeoutFail` resets on every emitted event), so it bounds only the *fully-silent* failure mode: 5 attempts × 120s idle + backoff (1+2+4+8 = 15s) ≈ **615s**. A stream that dribbles one event every <120s never trips it, so a single attempt has no absolute deadline; there is no per-attempt or total-retry wall cap in `packages/` (the 1800s limit lives only in the eval harness). This is unchanged by this plan — it is a property of the existing idle watchdog — and an absolute outer deadline is out of scope here.

**Constraints (from user, unchanged):** general reliability change only; no eval/benchmark awareness in code or comments; `packages/` only, no `evals/` changes.

**Key facts (verified):**
- `packages/llms/test/llm.test.ts` has **no** idle-timeout test — a real timer test would need `TestClock`; not adding one (see Risks).
- `packages/core/test/agent.test.ts:473-529` already covers retry via a `flakyLLM(failures, retryable, success)` harness:
  - `:505` "retries a retryable stream stall and recovers" — `flakyLLM(1, true, …)`, asserts `calls() === 2` and `responseDurationMs > 900` (spans one ~1s backoff).
  - `:519` "gives up after the retry budget" — `flakyLLM(5, true, …)`, asserts `calls() === 3` (**hardcodes** `initial + MAX_STREAM_RETRIES`). This assertion must be updated when the budget changes.
  - `:531` "does not retry a non-retryable error" — unaffected.

## Proposed approach

Concrete values:
- `STREAM_IDLE_TIMEOUT`: **60s → 120s** (tolerate a reasoning model's legitimate long silence before/between streamed tokens; still fail a dead stream in bounded time).
- `MAX_STREAM_RETRIES`: **2 → 4**.
- Retry delay: flat 1s → **exponential**, base 1s (delays 1s, 2s, 4s, 8s), still gated on `error.retryable`.

---

### Task 1: Raise the idle timeout and fix its rationale

**Objective:** A reasoning model that goes silent for up to ~2 minutes before/between streamed tokens is not falsely failed.

**Files:**
- Modify: `packages/llms/src/llm.ts:39-46` (the `STREAM_IDLE_TIMEOUT` constant and its doc comment)

**Step 1: Change the constant**

Replace the constant and its comment (`llm.ts:39-46`) with:

```typescript
/**
 * Fail a turn whose provider stream goes fully silent for this long instead of
 * hanging the loop indefinitely. Idle-based: the timer resets on every emitted
 * event (text, reasoning, or tool deltas), so it catches only a stream that
 * produces nothing at all — not one that is streaming slowly. A reasoning model
 * on a large context can legitimately emit nothing for over a minute while it
 * processes the prompt or reasons before the first token, so the window is set
 * well above a healthy stream's cadence while still failing a dead stream fast
 * enough for the agent's bounded retry to recover.
 */
const STREAM_IDLE_TIMEOUT = Duration.seconds(120)
```

**Step 2: Verify no test hardcodes 60**

Run: `grep -rn "60s\|seconds(60)\|no data for" packages/llms/test packages/core/test`
Expected: no assertion depends on the literal 60s idle window (the message text is generated from `Duration.toSeconds(STREAM_IDLE_TIMEOUT)`, so any trace-string test would already read the new value). If a hit exists, update it to the new value.

**Step 3: Typecheck**

Run: `bun run typecheck`
Expected: clean.

---

### Task 2: Exponential backoff and a larger retry budget

**Objective:** A transient retryable stream failure gets more attempts, spaced by exponential backoff, before the turn is failed.

**Files:**
- Modify: `packages/core/src/agent.ts:51-55` (constants) and `agent.ts:520-526` (the retry `Schedule`)
- Test: `packages/core/test/agent.test.ts:519-529` (update the hardcoded budget assertion)

**Step 1: Update the constants**

Replace `agent.ts:51-55` with:

```typescript
// Bounded retry for a single LLM request that fails with a retryable error
// (network stall, rate-limit, overload, 5xx). Intermittent provider drops
// usually succeed on a later attempt, so a few retries with exponential backoff
// keep a turn alive; a non-retryable or persistently-dead stream still fails in
// bounded time.
const MAX_STREAM_RETRIES = 4
const STREAM_RETRY_BASE_DELAY = Duration.seconds(1)
```

(Removes `STREAM_RETRY_DELAY`; renames to `STREAM_RETRY_BASE_DELAY`.)

**Step 2: Update the retry schedule**

At `agent.ts:520-526`, replace the `Schedule` passed to `Effect.retry` so it uses exponential backoff bounded by the retry count and still gated on retryability:

```typescript
      Effect.retry(
        Schedule.exponential(STREAM_RETRY_BASE_DELAY).pipe(
          Schedule.intersect(Schedule.recurs(MAX_STREAM_RETRIES)),
          Schedule.whileInput((error: LLMError) => error.retryable),
        ),
      ),
```

Note for implementer: `Schedule.intersect` recurs only while **both** schedules continue, so `recurs(MAX_STREAM_RETRIES)` bounds the attempt count while `exponential` supplies the delay; `whileInput` stops early on a non-retryable error. Confirm `Schedule` is already imported in `agent.ts` (it is — used by the current code) and that `intersect`/`exponential` exist in the installed Effect version; if the combinator shape differs, achieve the same result (≤4 retries, delays 1s→2s→4s→8s, retryable-gated) with the version's API.

**Step 3: Update the budget assertion**

In `packages/core/test/agent.test.ts`, the "gives up after the retry budget" test (`:519`) hardcodes the old budget. Update:

```typescript
  test(
    "gives up after the retry budget and fails the turn",
    async () => {
      const flaky = flakyLLM(10, true, textTurn("never"))
      const state = session()
      submitPrompt(state, "hi")
      const exit = await Effect.runPromiseExit(runFlaky(flaky, state))
      expect(exit._tag).toBe("Failure")
      expect(flaky.calls()).toBe(5) // initial + MAX_STREAM_RETRIES (4)
      expect(state.messages.every((m) => m.turnDurationMs === undefined)).toBe(true)
      expect(state.messages.every((m) => m.responseDurationMs === undefined)).toBe(true)
    },
    20000,
  )
```

Two changes from the current test:
- **Budget:** attempts = initial + `MAX_STREAM_RETRIES(4)` = **5**. `flakyLLM(n)` fails while `calls <= n` (`agent.test.ts:483`), so `flakyLLM(5)` would exhaust at the boundary (calls 1–5 all fail, the 6th/success is never reached) — it does *not* recover. Use `flakyLLM(10)` for clear margin and assert `calls() === 5`.
- **Explicit 20s timeout arg (required).** The retry runs on the **real clock** (like the existing recovery test at `:516`, which deliberately sleeps ~1s). Exhausting 4 retries sleeps the full exponential backoff `1+2+4+8 = 15s`; the `flakyLLM` failures are instantaneous, so total wall ≈ 15s. There is no `bunfig.toml` / per-test timeout override in the repo, so Bun's default **5000ms** per-test timeout applies and the test would otherwise time out and fail. The third arg to `test(...)` raises it to 20000ms.

**Step 4: Confirm the recovery test still holds**

The "retries a retryable stream stall and recovers" test (`:505`) uses `flakyLLM(1, …)` → recovers on the 2nd attempt after one backoff. The first backoff is still ~1s under exponential base 1s, so `responseDurationMs > 900` (`:516`) holds unchanged. No edit expected; verify by running.

**Step 5: Run the retry tests**

Run: `bun test packages/core/test/agent.test.ts -t "retry"`
Expected: PASS (recover, give-up, non-retryable).

---

### Task 3: Full verification

**Objective:** No regressions across the suites touching these layers.

**Steps:**
1. `bun run typecheck` — clean.
2. `bun run format:check` — clean (run `bun run format` if needed).
3. `bun test packages/llms/test packages/core/test --path-ignore-patterns='**/live/**'` — all pass.

## Files likely to change

- `packages/llms/src/llm.ts` (idle-timeout constant + comment)
- `packages/core/src/agent.ts` (retry constants + schedule)
- `packages/core/test/agent.test.ts` (budget assertion)

No `evals/` changes.

## Tests / validation

- Unit: retry recover / give-up / non-retryable in `agent.test.ts` pass with the new budget.
- Regression: full `llms` + `core` suites green.
- End-to-end (post-release, separate step): cut a throwaway pre-release, re-run the 10-task TB2 set. Compare pass count to the current 3/10 baseline. Keep if it recovers the stall-killed tasks (or is neutral); roll back if it regresses. The two install-failure tasks and the genuine task failures are out of scope for this change and are not expected to move.

## Risks, tradeoffs, and open questions

- **Slower failure on a truly-dead stream.** Worst case rises to ~615s (bounded, rare). Acceptable against the 1800s wall; the timeout is idle-based so a stream making any progress never trips it.
- **Timer test omitted.** A real `STREAM_IDLE_TIMEOUT` assertion needs Effect `TestClock` wiring that `llm.test.ts` doesn't currently set up; the value is a tuning constant, not logic, so a unit test would only re-assert the literal. Not adding one (YAGNI). The retry-budget behavior *is* covered.
- **Hypothesis is probabilistic.** If the silence is longer than 120s (not just over 60s), the timeout raise alone won't recover it; the extra retries are the fallback. Judged empirically by the re-run. If it doesn't move, the next hypothesis is context size / provider-side limits rather than the watchdog.
- **Partial events re-emit on retry (pre-existing, widened).** `streamOnce` uses a fresh `events` buffer per attempt, so the committed transcript is correct — `session.messages` only ever gets the `summary` from the final attempt (`agent.ts:499-508, 536-549`). But `ctx.emit({type:"llm-event"})` fires per event *as it streams* (`agent.ts:502-506`); if an attempt emits some reasoning/text and then stalls, those events were already pushed to the UI/trace, and the retry re-streams from scratch → duplicated/orphaned partial output in the *event stream* (not in `session.messages`). This is pre-existing; raising the idle window to 120s and adding retries widens the window. De-duplication, if wanted, belongs at the event consumer and is out of scope here.
- **Not gaming.** Purely a general streaming/retry reliability change; no eval/benchmark awareness, no task-specific behavior.

## Post-Implementation Changes

_(to be filled in after implementation + eval re-run)_
