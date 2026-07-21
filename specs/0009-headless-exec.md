# Headless Exec Implementation Plan

> Use subagents to implement this plan task-by-task.
>
> Binary distribution (standalone release archives, curl install/uninstall, semantic-release)
> is a deferred follow-on — see `specs/draft/binary-distribution.md`. It is not needed to
> build or validate headless exec, nor to run Harbor locally where the environment is under
> your control (Harbor can invoke `bun run packages/tui/bin/swain.tsx exec ...` or a shell
> alias). Promote it before running evals inside a clean container with no Bun present.

**Goal:** Add a deterministic, non-interactive `swain exec` mode suitable for Harbor-style agent evaluations.

**Architecture:** Split the current TUI startup path into reusable configuration/model bootstrap and command-specific frontends. Interactive startup continues to mount Ink; `exec` creates an ephemeral session, runs the existing controller/core loop without interactive tools, waits for parent and subagent work to quiesce, prints only the final assistant text, and exits with a stable status.

**Tech Stack:** Bun 1.3.14, TypeScript ESM/TSX, Effect, Ink/React, Bun test runner.

---

## Current Context

- `packages/tui/bin/swain.tsx` currently calls `run()` unconditionally; `packages/tui/src/index.ts` parses only interactive flags and mounts Ink.
- `packages/tui/src/controller.ts` already owns the complete parent loop, task store, detached subagent orchestration, completion notification injection, interruption, and optional persistence. Reuse it rather than duplicating the agent loop in a second frontend.
- `packages/tui/src/runtime.ts` always registers `builtinTools`, including interactive `Ask`.
- The TUI deliberately considers only credentials stored in `auth.json` when deciding whether a provider is configured. Provider transports already support standard environment fallbacks, but the model catalog rejects them before a request can start.
- `Controller.submitPrompt()` resolves after the current parent turn, not necessarily after detached subagents finish and their results have been injected into a follow-up parent turn.
- Session/task/tool-result storage is derived from the config path. A headless invocation that simply sets `persist: false` would still leave task and tool-result artifacts under the normal session directory.
- Harbor installed agents run a quoted instruction non-interactively inside the task environment. Harbor does not require a special stdout schema; the adapter can run `swain exec --permission-mode auto --model ... "<instruction>"` and use the process status plus verifier results.

## Resolved Product Decisions

### Headless command contract

```text
swain exec --permission-mode auto [--model provider:model[:variant]] [--router] "<prompt>"
swain exec --permission-mode plan [--model provider:model[:variant]] [--router] -
```

- `exec` accepts exactly one prompt source: a positional string or `-` for all of stdin.
- `--permission-mode` is mandatory. Only `auto` and `plan` are accepted; `ask` is invalid because there is no interactive approval surface.
- Model precedence is `--model` then the saved active TUI model. There is no catalog-order fallback in headless mode. Fail before starting the runtime when neither exists.
- `--model` accepts `provider:modelId` and `provider:modelId:variant`; omitted variants use the catalog's recommended default.
- Saved Swain auth remains the first credential source. `exec` fills missing credentials from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_CODEX_ACCESS_TOKEN`, `DEEPSEEK_API_KEY`, and `ZAI_API_KEY` without persisting those values. Interactive TUI credential policy is unchanged.
- Existing Codex CLI credential discovery remains between saved Swain auth and the environment fallback.
- `Ask` is absent from the headless tool registry and system prompt. The headless prompt tells the model that no user is available and to make reasonable assumptions.
- A run starts a fresh, non-resumable session. Task and tool-result files use a process-owned temporary directory which is removed after the runtime and subagents shut down.
- Routing is **off by default** in headless mode. `--router` opts in and honors the saved router configuration; without it, the run is a deterministic single model (`--model` or the saved active model), which is the reproducible default an eval wants unless routing itself is under test. This flag is exec-only and never persisted; the interactive TUI is unchanged (its saved router config stays effective).
- `exec` has no internal wall-clock or turn-count timeout. It runs until the parent/subagent graph quiesces or a signal arrives; bounding runtime is the caller's responsibility (Harbor imposes its own per-task timeout).
- The current working directory is the agent workspace. Do not add a second cwd flag in this slice.
- On success, stdout contains only the final non-meta assistant text followed by one newline. Intermediate assistant turns, tool output, progress, and decoration never go to stdout.
- Recoverable diagnostics and fatal errors go to stderr. Do not introduce JSONL or ATIF output in this slice.
- Exit statuses:
  - `0`: the complete parent/subagent run quiesced successfully, even if the final text is empty.
  - `1`: startup, auth, provider, model, or agent runtime failure.
  - `2`: invalid CLI usage, including missing/invalid permission mode or prompt.
  - `130`: interrupted by `SIGINT`.
  - `143`: terminated by `SIGTERM`.

## Reference Behavior

- Harbor installed-agent integration: <https://www.harborframework.com/docs/agents>

## Proposed Layout

```text
packages/tui/
  src/
    cli.ts
    headless.ts
    startup.ts
    version.ts
  test/
    cli.test.ts
    headless.test.ts
    startup.test.ts
```

Existing files remain authoritative for model catalog, auth persistence, runtime wiring, and controller behavior; new modules extract shared startup and add the command boundary only. `version.ts` returns `dev` in source runs; the distribution follow-on injects the real tag at build time.

---

## Task 1: Define the CLI grammar and embedded version

**Objective:** Dispatch interactive and headless commands predictably without starting a runtime for invalid input.

**Files:**

- Create: `packages/tui/src/cli.ts`
- Create: `packages/tui/src/version.ts`
- Create: `packages/tui/test/cli.test.ts`
- Modify: `packages/tui/bin/swain.tsx`
- Modify: `packages/tui/src/index.ts`
- Modify: `packages/tui/package.json`

**Design:**

1. Keep `packages/tui/bin/swain.tsx` as a tiny executable shim:

   ```ts
   #!/usr/bin/env bun
   import { runCli } from "../src/cli"

   process.exitCode = await runCli()
   ```

2. Move interactive flag parsing behind a named `runInteractive()` export. Preserve existing `swain`, `--resume`, `--model`, and `--permission-mode` behavior.
3. Implement a small typed parser without adding a CLI dependency. The parser must:
   - recognize `exec`, `--help`, and `--version`;
   - recognize the exec-only boolean `--router` (default off);
   - accept exec options before or after its positional prompt and honor `--`;
   - reject unknown flags, duplicate prompt sources, empty prompt text, missing stdin, malformed model refs, missing permission mode, and `ask` mode;
   - return data or a typed usage error rather than calling `process.exit()`.
4. Put the build-time version in `version.ts`. Development/source runs return `dev`; release builds replace a declared constant through Bun `--define` with the version semantic-release computes for the run (passed via the build script's `--version`).
5. `runCli()` receives injectable argv/stdin/stdout/stderr/env/cwd dependencies for unit tests. It returns an exit code; only the binary assigns `process.exitCode`.

**Tests first:**

- Interactive argv still dispatches to the existing frontend.
- Both prompt forms parse.
- `--router` parses as a boolean and defaults off when omitted.
- `provider:model:variant` parses without losing the variant.
- Missing permission, `ask`, missing prompt, multiple prompts, unknown flags, and empty piped input return usage errors without invoking headless startup.
- `--help` documents both modes and returns `0`.
- `--version` prints only the version and returns `0`.

**Verify:**

```bash
bun test packages/tui/test/cli.test.ts
bun run --cwd packages/tui typecheck
```

**Commit:** `feat(tui): add exec command grammar`

## Task 2: Extract shared startup and add exec-only environment auth

**Objective:** Reuse config/auth/model resolution across Ink and headless modes while keeping their credential policies explicit.

**Files:**

- Create: `packages/tui/src/startup.ts`
- Create: `packages/tui/test/startup.test.ts`
- Modify: `packages/tui/src/index.ts`
- Modify: `packages/tui/src/models.ts`
- Modify: `packages/tui/src/codex-auth.ts`
- Modify: `packages/tui/test/models.test.ts`
- Modify: `packages/tui/test/auth.test.ts`

**Design:**

1. Extract the current config path, config/auth load, legacy credential merge, Codex CLI bootstrap, model precedence, default variant, and model construction into typed functions in `startup.ts`.
2. Make credential policy an input, not ambient behavior:

   ```ts
   type CredentialPolicy = "stored-only" | "stored-then-environment"
   ```

   Interactive startup uses `stored-only`; exec uses `stored-then-environment`.
3. For exec, fill only missing required fields from the standard environment variables. Never overwrite a saved credential, copy environment values into the config/auth files, log them, or include them in errors.
4. Preserve current Codex precedence and refresh behavior:
   - Swain auth;
   - Codex CLI auth fallback/bootstrap;
   - `OPENAI_CODEX_ACCESS_TOKEN` fallback.
5. Split read/resolve from migrations. Interactive startup may perform today's one-time auth migration; headless startup must not rewrite config merely because it loaded environment credentials.
6. Resolve headless models as `flag -> saved active model -> error`. Interactive startup retains its current `flag -> saved -> first configured -> placeholder` behavior.
7. Apply a recommended variant when the selected model ref omits one.

**Tests first:**

- Every provider's environment variable makes that provider resolvable under the exec policy and remains ignored under the interactive policy.
- Stored credentials win over environment credentials.
- Environment credentials are absent from files after resolution.
- Headless startup fails clearly without a flag or saved active model.
- A saved active model can use an environment credential when its stored auth is missing.
- Codex Swain auth, CLI auth, and environment fallback retain the stated precedence.
- Existing interactive startup/model/auth tests remain unchanged in behavior.

**Verify:**

```bash
bun test packages/tui/test/startup.test.ts packages/tui/test/models.test.ts packages/tui/test/auth.test.ts
bun run --cwd packages/tui typecheck
```

**Commit:** `refactor(tui): share startup resolution`

## Task 3: Make the controller safely usable by a headless frontend

**Objective:** Run the existing agent/controller lifecycle without interactive tools or persistent session history and know when all parent/subagent work is finished.

**Files:**

- Modify: `packages/tui/src/runtime.ts`
- Modify: `packages/tui/src/controller.ts`
- Modify: `packages/tui/test/controller.test.ts`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/src/prompt.ts`
- Modify: `packages/core/test/agent.test.ts`
- Modify: `packages/core/test/prompt-router.test.ts`

**Design:**

1. Allow `makeRuntime()`/`ControllerDeps` to accept a tool list, defaulting to today's `builtinTools`. The headless caller supplies `builtinTools` without `Ask`; interactive callers require no changes.
2. Add a non-interactive prompt option to `runTurn()`/system prompt assembly. It must state that no user is available and reasonable assumptions should be made. Do not fake this as a user transcript message.
3. Pass that option through controller parent turns. Child registries inherit the already-filtered main registry, so `Ask` remains unavailable to subagents too.
4. Add a session-storage-root override to `ControllerDeps`. Keep the config path for settings/auth; route tasks and tool-result storage through the override when supplied.
5. Add `Controller.waitUntilIdle(): Promise<void>` as a **fixpoint loop, not a single check→drain→recheck**. A drained follow-up parent turn can itself spawn a new subagent (the model reads a task result and delegates again), arbitrarily deep, so quiescence must be re-established until an entire pass finds no work. Each pass:
   - awaits any in-flight parent/follow-up turn and any in-flight drain to settle;
   - triggers one **awaited** completion drain — inject durable notifications, then run and settle the follow-up parent turn they cause;
   - if `orchestrator.activeCount > 0`, awaits the active subagents to reach zero, then repeats;
   - otherwise resolves only when, simultaneously: no parent turn running, no drain running or deferred, `activeCount` zero, and the durable task store reports zero pending parent notifications.
   Termination: each non-idle pass does real work (injects a notification, runs a turn); when the model stops delegating, a follow-up turn spawns nothing, the next pass sees `activeCount === 0 ∧ pending === 0`, and the loop converges. A finite agent graph yields a finite loop. (Unbounded delegation cannot converge — see Risks; that is bounded by the caller, not here.)
6. Two ordering rules make each pass **sound**, not a lucky snapshot; serialize drains (no fire-and-forget competing drains) so the loop observes a single consistent drain state:
   - Read/await `activeCount → 0` **before** reading pending notifications. A subagent is removed from `active` only in `Effect.ensuring`, *after* it has persisted its task and offered its completion (the "durable-before-visible" ordering at `packages/core/src/orchestrator.ts` ~L299–318). So observing `activeCount === 0` guarantees every finished result is already durable and enqueued — a `pending` read taken afterward cannot miss a completed-but-unnotified result.
   - With `activeCount === 0` and no parent turn running, nothing remains to ring the completion doorbell or spawn new work, so no completion can appear between the final check and resolution.
7. Make controller shutdown awaitable. It must interrupt parent/subagent fibers, stop the completion listener, resolve/cancel pending bridges, and dispose the managed runtime before a headless temporary directory is removed. Interactive React cleanup may intentionally ignore the returned promise with `void`.
8. Preserve all current TUI controller behavior and session persistence defaults.

**Tests first:** drive all timing deterministically — inject a test-specific mock LLM via the `llmLayer` override (Effect layer injection) that only responds/completes when the test tells it to. No `sleep`/wall-clock in race or fixpoint tests.

- A custom runtime registry omits `Ask` from the LLM request.
- The non-interactive instruction is present only when requested.
- `waitUntilIdle()` returns after a simple parent turn.
- A scripted `Agent` call proves it waits for child completion, injects the durable task notification, runs the parent follow-up, and only then returns.
- A follow-up turn that itself spawns a second subagent reaches idle only after the whole chain drains — the fixpoint loop, not a single recheck.
- A completion racing the initial turn boundary is neither lost nor processed twice.
- Awaited shutdown interrupts outstanding fibers and leaves no listener using disposed state.
- Existing controller/subagent tests continue to pass.

**Verify:**

```bash
bun test packages/core/test/agent.test.ts packages/core/test/prompt-router.test.ts
bun test packages/tui/test/controller.test.ts
bun run typecheck
```

**Commit:** `feat(tui): support headless controller lifecycle`

## Task 4: Implement one-shot headless execution

**Objective:** Execute one prompt to quiescence with clean I/O, ephemeral artifacts, and stable failures/signals.

**Files:**

- Create: `packages/tui/src/headless.ts`
- Create: `packages/tui/test/headless.test.ts`
- Modify: `packages/tui/src/cli.ts`
- Modify: `packages/tui/src/index.ts`

**Design:**

1. `runHeadless()` must:
   - resolve startup using Task 2;
   - create a temporary session root with `mkdtemp`;
   - construct a fresh session at the requested cwd and explicit permission mode;
   - build a controller with `persist: false`, the temporary storage root, non-interactive prompting, and `Ask` removed;
   - honor `--router`: when absent (default), disable routing in the in-memory config before building the controller so the run uses the single resolved model deterministically; when present, leave the saved router configuration effective. Never persist this change;
   - subscribe before submission and retain fatal `agent-error` events;
   - submit the prompt, then await `waitUntilIdle()`;
   - extract the last non-meta assistant text only after idle;
   - await controller shutdown and remove the exact temporary directory in `finally`.
2. Print the final text once. Do not reconstruct it from streamed deltas, because retry/partial events can duplicate text; use committed session messages as the authority.
3. Print recoverable `agent-error` diagnostics to stderr as they occur. On a non-recoverable error, suppress stdout and return `1` with one concise stderr message.
4. Install temporary `SIGINT`/`SIGTERM` handlers around the run. Interrupt the controller, await shutdown/cleanup, restore previous handlers, and return `130`/`143`.
5. Never load Ink, query terminal background, enter the alternate screen, enable mouse input, or require TTY streams in exec mode.

**Tests first:** use the injected mock LLM (via `llmLayer`) to park a run mid-turn. Signal tests do not actually `kill` the process — they invoke the registered `SIGINT`/`SIGTERM` handler directly and assert the resolved code (`130`/`143`) plus that `orchestrator.interruptAll` ran and no fiber survives.

- One successful turn emits exactly final text plus newline to stdout and nothing to stderr.
- A tool-call turn followed by a final turn prints only the final turn.
- stdin mode preserves multiline text exactly.
- Missing auth/model and fatal LLM failures produce no stdout and exit `1`.
- Recoverable diagnostics use stderr but do not change a successful exit.
- `Ask` is absent from tools and the non-interactive instruction reaches the model.
- With `--router` off (default) a saved router config does not switch models; `--router` re-enables routing. Neither path persists a config change.
- A detached subagent completes and informs the parent's final response before stdout is written.
- No resumable session appears beneath the real config directory; the temporary root is removed on success, failure, and interruption.
- Signal tests verify `130`/`143` and no orphan child fibers.

**Manual smoke:**

```bash
bun run packages/tui/bin/swain.tsx exec --permission-mode plan --model anthropic:claude-opus-4-8 "Inspect this repo and summarize it"
printf 'Inspect this repo\nDo not modify files\n' | bun run packages/tui/bin/swain.tsx exec --permission-mode plan --model anthropic:claude-opus-4-8 -
```

**Verify:**

```bash
bun test packages/tui/test/headless.test.ts packages/tui/test/cli.test.ts
bun run --cwd packages/tui typecheck
```

**Commit:** `feat(tui): run prompts headlessly`

---

## Files Likely to Change

```text
packages/core/src/agent.ts
packages/core/src/prompt.ts
packages/core/test/agent.test.ts
packages/core/test/prompt-router.test.ts
packages/tui/bin/swain.tsx
packages/tui/package.json
packages/tui/src/cli.ts
packages/tui/src/codex-auth.ts
packages/tui/src/controller.ts
packages/tui/src/headless.ts
packages/tui/src/index.ts
packages/tui/src/models.ts
packages/tui/src/runtime.ts
packages/tui/src/startup.ts
packages/tui/src/version.ts
packages/tui/test/auth.test.ts
packages/tui/test/cli.test.ts
packages/tui/test/controller.test.ts
packages/tui/test/headless.test.ts
packages/tui/test/models.test.ts
packages/tui/test/startup.test.ts
```

## Risks and Mitigations

- **False idle while a detached child completes:** use durable pending notifications plus active-count checks and serialized drains; do not infer idle from React/controller display state alone. Rely on the durable-before-`active`-removal ordering (`orchestrator.ts`) so `activeCount === 0` implies every result is already persisted and enqueued.
- **Non-terminating idle:** a model that delegates without bound never quiesces. `waitUntilIdle` is a fixpoint loop with no internal wall-clock timeout by design; exec relies on the calling harness (Harbor) or `SIGTERM`/`SIGINT` to bound runtime. The ordering guarantee prevents *false* idle; capping unbounded *real* work is the caller's responsibility, not this slice's.
- **Headless deadlock:** remove `Ask`, reject `ask` permission mode before runtime construction, and make signal/shutdown paths awaitable.
- **Duplicate/partial stdout after provider retries:** derive output from committed final session messages, not event deltas.
- **Credential leakage:** keep environment auth as an in-memory exec-only overlay, preserve saved-over-env precedence, and assert files/logs never contain injected secrets.
- **Eval cross-contamination:** separate config reads from ephemeral task/tool storage and clean the exact temp root in `finally`.

## Explicit Non-Goals

- ATIF/JSONL trajectory export or Harbor-native Python adapter code.
- Multi-prompt stdin protocols, resume support, interactive follow-up questions, or headless approval prompts.
- Binary distribution — standalone archives, curl install/uninstall, semantic-release. Deferred to `specs/draft/binary-release.md`.
- An internal wall-clock or turn-count timeout on a run — bounding runtime is the caller's responsibility.
- Changing interactive TUI credential, permission, output, or persistence defaults.

## Acceptance Criteria

- `swain exec --permission-mode auto --model ... "prompt"` can complete a coding task without a TTY, including detached subagents, and returns only after all completion notifications have been handled.
- Exec never waits for `Ask`/approval input, never writes environment credentials, and leaves no resumable session or temporary task/tool artifacts.
- Stdout, stderr, and exit statuses match the documented contract under success, usage error, runtime failure, SIGINT, and SIGTERM.
- All targeted tests plus `bun run typecheck`, `bun run format:check`, and `bun test packages/llms/test` pass.

## Post-Implementation Changes

### Streamed output (`--output-format text|stream-json`)

Added after the initial four tasks so an eval harness can observe a run's progress, not just its final answer. Default (`text`) is unchanged — only the final assistant text plus a newline.

- **Motivation.** A programmatic consumer (e.g. autoir2, which spawns `claude --output-format stream-json --verbose` and parses its JSONL) needs incremental, structured events, not a human stream. `text` stays the default because plain-answer callers want a clean single value on stdout; streaming is opt-in.
- **Schema.** `stream-json` writes newline-delimited JSON to stdout — an `init` line, one line per committed assistant/tool message, then a terminal `result` line. Structure loosely mirrors Claude Code's stream (init/assistant/result) so a Claude-shaped consumer adapts easily, but it is deliberately not a field-for-field copy: swain-native block names, camelCase fields, only the data swain actually has (no session id, cost, cache tokens, or hook events).
  - `{"type":"init","model":"provider:model[:variant]","permissionMode":"auto|plan","cwd":...,"router":bool}`
  - `{"type":"assistant","content":[…]}` per committed assistant message. Blocks: `text`, `reasoning`, and `tool-call` (`toolCallId`→`id`, plus `name`/`input`).
  - `{"type":"user","content":[…]}` only when a committed user message carries tool results; each `tool-result` block is `{id,name?,isError,result}` with the tool value unwrapped. The initial prompt echo and meta rows (model-switch, compaction) are skipped.
  - `{"type":"result","subtype":"success|error_during_execution|interrupted","isError":bool,"result"?:string}`. `success` carries the final text (exit 0); `error_during_execution` carries the fatal message (exit 1); `interrupted` fires on SIGINT/SIGTERM (exit 130/143) with no `result`.
- **Granularity is committed-part, never token deltas.** Events derive from `session.messages` via a cursor, so retries never re-emit — the same dedup guarantee the `text` path relies on. The cursor is flushed on each `controller.onEvent` (agent events fire per iteration during the turn), **not** on `subscribe`/`notify` (which only fires at turn start/end, so messages would otherwise batch out all at once at the end). Recoverable diagnostics still go to stderr, keeping stdout pure NDJSON.
