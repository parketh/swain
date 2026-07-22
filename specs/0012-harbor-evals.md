# Harbor Evals Integration Implementation Plan

> Use subagents to implement this plan task-by-task.

**Goal:** Run Swain reproducibly as a custom installed agent against Terminal-Bench 2 through Harbor and DeepSWE through Pier, producing complete ATIF v1.7 parent/subagent trajectories and verified trial metrics.

**Architecture:** Swain gains an opt-in native trace bundle for headless runs: one root snapshot plus one snapshot per completed child session, with committed reasoning, tool calls/results, timestamps, durations, and per-response token usage. Shared Python code installs an exact artifact from `specs/0011-standalone-release-artifacts.md`, maps Harbor/Pier model notation to `swain exec`, redacts known secrets, and converts the native bundle into ATIF. Two thin framework-specific wrappers inherit their respective installed-agent bases because Harbor and Pier expose different install/network APIs.

**Tech Stack:** TypeScript, Bun 1.3.14, Effect, Python 3.12, uv 0.11.11, Harbor 0.20.0, datacurve-pier 0.3.0, ATIF v1.7, pytest 9.1.1, Ruff 0.15.22, Docker; Modal is supported through Pier but is not an acceptance dependency.

---

## Dependencies and Scope

- Implement `specs/0011-standalone-release-artifacts.md` first and publish a real Swain release. The adapters never install a host-local binary or build Swain from source inside a task.
- Reuse the merged `swain exec` implementation from `specs/0009-headless-exec.md`:

  ```text
  swain exec --permission-mode auto \
    --model provider:model[:variant] \
    --output-format stream-json \
    --trace-dir /logs/agent/swain \
    "<benchmark instruction>"
  ```

- Routing is off. The Harbor/Pier `model_name` is the single model used by the parent and every Swain subagent. All normal noninteractive tools remain available; only `Ask` stays omitted by existing headless behavior.
- Initial provider support is official API-key endpoints only:

  | Model prefix | Credential | Pier runtime domain |
  | --- | --- | --- |
  | `anthropic/` | `ANTHROPIC_API_KEY` | `api.anthropic.com` |
  | `openai/` | `OPENAI_API_KEY` | `api.openai.com` |
  | `kimi/` | `MOONSHOT_API_KEY` | `api.moonshot.ai` |
  | `deepseek/` | `DEEPSEEK_API_KEY` | `api.deepseek.com` |
  | `zai/` | `ZAI_API_KEY` | `api.z.ai` |

- Custom base URLs, gateways, routers, and ChatGPT/Codex OAuth are rejected in v1. Parallel Codex OAuth needs coordinated refresh-token rotation and belongs in a follow-on spec.
- Terminal-Bench uses Harbor. DeepSWE uses Pier because its tasks set `allow_internet = false` and Pier grants only the selected provider domain during the agent phase.
- Benchmark instructions are passed unchanged. DeepSWE already instructs the agent to create a branch and commit; its `pre_artifacts.sh` grades `base_commit..HEAD`. Do not auto-commit or append Swain-specific instructions.
- Full benchmark jobs are manual/opt-in. Acceptance requires one pinned live task from each benchmark, not every task and not a minimum reward.

## Repository Layout

```text
evals/
  __init__.py
  pyproject.toml
  uv.lock
  README.md
  benchmarks.lock.json
  common/
    __init__.py
    artifacts.py
    models.py
    redaction.py
    trajectory.py
  harbor/
    __init__.py
    agent.py
  pier/
    __init__.py
    agent.py
  scripts/
    fetch-deep-swe.sh
    run-terminal-bench-2.sh
    run-deep-swe.sh
  tests/
    fixtures/
      root-trace.json
      child-trace.json
    test_artifacts.py
    test_models.py
    test_trajectory.py
    test_wrappers.py
```

Custom import paths:

```text
Harbor: evals.harbor.agent:SwainHarborAgent
Pier:   evals.pier.agent:SwainPierAgent
```

## Native and ATIF Trace Contracts

With `--trace-dir /logs/agent/swain`, Swain writes atomically:

```text
/logs/agent/swain/
  manifest.json
  root.json
  subagents/
    <agent-id>.json
```

The native schema is versioned independently (`schemaVersion: 1`) and contains only serializable facts needed for conversion:

- session/trajectory identity, parent identity, `agentId`, `taskId`, and agent type;
- exact Swain version, model ref, reasoning variant, permission mode, working directory, and assembled system prompt;
- committed user/assistant messages, including reasoning and tool blocks;
- per-message `createdAt`, `responseDurationMs`, `turnDurationMs`, and assistant `usage`;
- parent- or child-local counters and terminal outcome.

The adapter writes:

```text
/logs/agent/
  trajectory.json
  subagents/
    <agent-id>.json
```

ATIF mapping rules:

1. Emit the captured system prompt as the first `source: "system"` step.
2. Emit genuine prompts as user steps. Preserve Swain meta-user messages as `source: "system"` with `extra.swain_is_meta = true`.
3. Map each committed assistant response to one agent step: text to `message`, preserved reasoning to `reasoning_content`, tool calls to `tool_calls`, usage to prompt/completion token metrics, and timing/duration to timestamp plus `extra`.
4. Pair the following tool-result message into that agent step's `observation`; never emit a disconnected observation whose `source_call_id` cannot validate.
5. When an `Agent` result contains an `agentId`, attach `subagent_trajectory_ref: [{"trajectory_path": "subagents/<agent-id>.json", ...}]` to that observation result.
6. Every child file is a complete, independently valid ATIF-v1.7 trajectory with step IDs starting at 1. Do not embed children in the parent JSON.
7. Each file's `final_metrics` is local to that file. The wrapper sums root and child token totals into Harbor/Pier `AgentContext`, preventing both under-reporting and double-counting.
8. Omit cached-token and USD cost fields because Swain does not receive authoritative values for them. List-price estimates must not be presented as billed cost.
9. Validate generated JSON with both `harbor.models.trajectories.Trajectory` and `pier.models.trajectories.Trajectory` in tests. A missing referenced child is a conversion failure even if Pydantic accepts the path string.

## Reference Sources

- Harbor custom installed agents: <https://www.harborframework.com/docs/agents>
- Harbor ATIF v1.7 guide: <https://www.harborframework.com/docs/agents/trajectory-format>
- Harbor Terminal-Bench tutorial: <https://www.harborframework.com/docs/tutorials/running-terminal-bench>
- Terminal-Bench 2 registry package: <https://hub.harborframework.com/datasets/terminal-bench/terminal-bench-2>
- DeepSWE benchmark and Pier quickstart: <https://github.com/datacurve-ai/deep-swe>
- Harbor 0.20.0 package: <https://pypi.org/project/harbor/0.20.0/>
- datacurve-pier 0.3.0 package: <https://pypi.org/project/datacurve-pier/0.3.0/>

## Task 1: Preserve per-response usage on committed messages

**Objective:** Make every root/child assistant response self-contained enough to convert into ATIF metrics after the run.

**Files:**

- Modify: `packages/llms/src/schema/messages.ts`
- Modify: `packages/llms/src/index.ts`
- Modify: `packages/core/src/state/messages.ts`
- Modify: `packages/core/src/agent.ts`
- Modify: `packages/core/src/context/compaction.ts`
- Modify: `packages/core/test/agent.test.ts`
- Modify: `packages/core/test/compaction.test.ts`
- Modify: `packages/core/test/session-models.test.ts`

**Step 1: Write failing tests**

- Assistant messages accept optional `usage` matching the existing `Usage` schema; user messages reject it.
- `runTurn()` stores exactly the `step-end` usage on the assistant message committed for that inference.
- Compaction-generated assistant responses also retain their provider usage when available.
- Session save/load round-trips usage, while legacy messages without it still decode.

**Step 2: Verify failure**

Run:

```bash
bun test packages/core/test/agent.test.ts packages/core/test/compaction.test.ts packages/core/test/session-models.test.ts
```

Expected: FAIL because assistant messages do not persist usage.

**Step 3: Implement**

- Add `usage?: Usage` only to `AssistantMessage` and its constructor options.
- Attach `summary.usage` at the same commit point that updates session counters; do not reconstruct usage later from cumulative counters.
- Keep usage local-only: provider request lowerers must continue ignoring timing/usage metadata.

**Step 4: Verify**

Run the Task 1 command again. Expected: PASS.

**Commit:** `feat(core): retain per-response usage`

## Task 2: Capture root and child native traces

**Objective:** Add an opt-in trace directory to `swain exec` and capture every session before headless teardown discards it.

**Files:**

- Create: `packages/core/src/trace.ts`
- Create: `packages/core/test/trace.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/orchestrator.ts`
- Modify: `packages/core/test/orchestrator.test.ts`
- Modify: `packages/tui/src/controller.ts`
- Create: `packages/tui/src/exec-trace.ts`
- Create: `packages/tui/test/exec-trace.test.ts`
- Modify: `packages/tui/src/cli.ts`
- Modify: `packages/tui/src/headless.ts`
- Modify: `packages/tui/test/cli.test.ts`
- Modify: `packages/tui/test/headless.test.ts`

**Step 1: Write failing tests**

- CLI parses `--trace-dir PATH` only for `exec`, rejects a missing/empty value, and leaves existing calls unchanged when absent.
- The pure trace projector produces schema v1, a stable system prompt, exact model/session metadata, messages, usage, counters, and outcome without serializing model functions, locks, or file caches.
- An optional orchestrator child sink receives both successful and failed child snapshots, including `agentId`/`taskId`, before cleanup/discard; no normal TUI event contains the full transcript.
- Headless success, fatal error, SIGINT, and SIGTERM all leave a root snapshot. Completed children leave separate files with safe UUID-derived names.
- Trace writes use sibling temporary files plus rename. An unwritable requested trace directory fails the exec instead of silently claiming ATIF support.
- Runs without `--trace-dir` perform no trace I/O and preserve current output/exit behavior.

**Step 2: Verify failure**

Run:

```bash
bun test packages/core/test/trace.test.ts packages/core/test/orchestrator.test.ts packages/tui/test/exec-trace.test.ts packages/tui/test/cli.test.ts packages/tui/test/headless.test.ts
```

Expected: FAIL because trace projection, sink, writer, and CLI option do not exist.

**Step 3: Implement the core trace seam**

- `packages/core/src/trace.ts` owns the serializable schema/projection and exact system-prompt assembly from the session plus the effective tool registry.
- Extend `OrchestratorConfig` with one optional trace callback. Invoke it once after each child outcome is known and before the local session becomes unreachable. The sink records its first write error without interrupting task persistence or the orchestrator completion queue; after the graph becomes idle, headless exec checks that error and fails the traced run. Interactive callers omit the sink.
- Pass this callback through `ControllerDeps` only when headless tracing is enabled.
- Do not make child sessions recursively spawn agents; the existing restricted child registries remain unchanged.

**Step 4: Implement headless output**

- `exec-trace.ts` owns directory creation, atomic JSON, the manifest, child filenames, and root finalization.
- Initialize the trace directory before starting the model so path errors spend no tokens.
- Write child snapshots as they complete; write the root snapshot after quiescence or during bounded shutdown on failure/signal.
- Keep ordinary NDJSON stdout and exit codes unchanged.

**Step 5: Verify**

Run the Task 2 command again. Expected: PASS.

**Commit:** `feat(tui): capture headless session traces`

## Task 3: Redact known credentials and complete headless provider auth

**Objective:** Ensure eval logs/traces do not contain exact credentials and every supported API-key provider can be selected from a clean container.

**Files:**

- Create: `packages/tui/src/redaction.ts`
- Create: `packages/tui/test/redaction.test.ts`
- Modify: `packages/tui/src/models.ts`
- Modify: `packages/tui/src/headless.ts`
- Modify: `packages/tui/src/exec-events.ts`
- Modify: `packages/tui/test/startup.test.ts`
- Modify: `packages/tui/test/exec-events.test.ts`
- Modify: `packages/tui/test/headless.test.ts`
- Modify: `.env.example`

**Step 1: Write failing tests**

- `MOONSHOT_API_KEY` configures `kimi` under headless `stored-then-environment` policy without persisting it.
- Collect exact non-empty `apiKey`, `accessToken`, and `refreshToken` values from loaded config plus supported env overlays, deduplicate them, and redact them recursively from strings in NDJSON/native trace values.
- A tool result containing a selected provider key is replaced with `[REDACTED]` in both stdout and trace files.
- Keys are absent from error text and are never written to `config.json`/`auth.json`.
- Values shorter than a conservative threshold are not globally replaced to avoid corrupting ordinary text; API keys used in tests exceed the threshold.

**Step 2: Verify failure**

Run:

```bash
bun test packages/tui/test/redaction.test.ts packages/tui/test/startup.test.ts packages/tui/test/exec-events.test.ts packages/tui/test/headless.test.ts
```

Expected: FAIL because Kimi is missing from the headless env overlay and output redaction is absent.

**Step 3: Implement**

- Add `{ provider: Provider.Kimi, field: "apiKey", envVar: "MOONSHOT_API_KEY" }` to the existing credential-source table.
- Apply one shared exact-value redactor immediately before NDJSON serialization and native trace writes.
- Do not claim protection if the model transforms/splits a secret; the guarantee is exact known-value redaction, matching what can be deterministically tested.

**Step 4: Verify**

Run the Task 3 command again. Expected: PASS.

**Commit:** `fix(tui): redact headless eval credentials`

## Task 4: Create the locked Python eval project and shared helpers

**Objective:** Establish one dependency-locked home for artifact selection, model mapping, secret forwarding, and ATIF conversion.

**Files:**

- Create: `evals/__init__.py`
- Create: `evals/pyproject.toml`
- Create: `evals/uv.lock`
- Create: `evals/common/__init__.py`
- Create: `evals/common/artifacts.py`
- Create: `evals/common/models.py`
- Create: `evals/common/redaction.py`
- Create: `evals/common/trajectory.py`
- Create: `evals/tests/fixtures/root-trace.json`
- Create: `evals/tests/fixtures/child-trace.json`
- Create: `evals/tests/test_artifacts.py`
- Create: `evals/tests/test_models.py`
- Create: `evals/tests/test_trajectory.py`
- Modify: `.gitignore`

**Step 1: Lock dependencies**

`evals/pyproject.toml` requires Python `>=3.12,<3.13` and pins direct dependencies exactly:

```text
harbor==0.20.0
datacurve-pier==0.3.0
pytest==9.1.1
ruff==0.15.22
```

Generate and commit `evals/uv.lock`; do not depend on the separate `atif` package because both framework model implementations must be validated directly.

**Step 2: Write failing helper tests**

Artifact tests cover:

- required exact SemVer; no `latest`, branch, local binary, or source checkout;
- x86_64 plus glibc/musl detection and clear failure for ARM/unknown libc;
- expected release URL/asset/checksum selection;
- install shell tries `curl`, `wget`, `python3`, then `python`, verifies SHA-256 before extraction, verifies manifest target/version, installs read-only under `/opt/swain/v<version>`, and does not create a global symlink;
- archive/checksum mismatch fails before replacing a valid install.

Model tests cover:

- required `<provider>/<model>` input and optional `variant` mapping to `provider:model[:variant]`;
- exactly the provider/credential/domain table in this spec;
- selected-provider-only secret selection through the frameworks' scoped `agent_env` mechanism;
- rejection of `openai-codex`, unknown providers, base URL env vars, and missing credentials before model execution.

Trajectory tests cover all Native and ATIF Trace Contract rules, external child paths, missing child failure, interrupted/failed outcomes, reasoning/tool fidelity, local vs inclusive totals, and both Harbor/Pier Pydantic validators.

**Step 3: Verify failure**

Run:

```bash
cd evals
uv sync --frozen
uv run pytest
```

Expected: FAIL because shared modules do not exist.

**Step 4: Implement pure helpers**

- Keep artifact installation as generated POSIX shell usable by both wrappers; no framework imports in `artifacts.py`.
- Keep model/secret mapping in one immutable table; wrappers never duplicate endpoints.
- Build ATIF as plain dictionaries in `trajectory.py`. Framework wrappers supply their own `Trajectory` class for validation and serialization.
- Redact exact selected secrets from wrapper command/result diagnostics in addition to Swain's own redaction.

**Step 5: Verify**

Run:

```bash
cd evals
uv run ruff check .
uv run ruff format --check .
uv run pytest
```

Expected: PASS.

**Commit:** `test(evals): add shared eval contracts`

## Task 5: Implement the Harbor installed-agent wrapper

**Objective:** Install and run an exact Swain release in Harbor and publish validated ATIF plus inclusive token totals.

**Files:**

- Create: `evals/harbor/__init__.py`
- Create: `evals/harbor/agent.py`
- Create: `evals/tests/test_wrappers.py`

**Step 1: Write failing wrapper tests**

Using a fake Harbor `BaseEnvironment`, assert:

- `SwainHarborAgent` inherits `harbor.agents.installed.base.BaseInstalledAgent`, sets `SUPPORTS_ATIF = True`, requires `model_name` and exact `version`, and reports the Swain version;
- `install()` runs the shared checksummed install as root and verifies `/opt/swain/v<version>/bin/swain --version` plus the colocated `rg --version`;
- `run()` executes `/opt/swain/v<version>/bin/swain` as the task's default agent with `--permission-mode auto`, routing absent, selected model/variant, `stream-json`, and `/logs/agent/swain`; the original instruction survives shell quoting byte-for-byte;
- only the selected provider key is present in the framework-scoped agent environment, while the per-command `env` argument remains secret-free so base-class debug logging cannot serialize the value;
- `populate_context_post_run()` converts/validates the trace, writes `trajectory.json` and child files, and sets inclusive input/output tokens without fabricated cost;
- non-zero Swain exit, missing result event, missing trace, invalid ATIF, or broken child reference fails the trial clearly.

**Step 2: Verify failure**

Run:

```bash
cd evals
uv run pytest tests/test_wrappers.py -k harbor
```

Expected: FAIL because the wrapper does not exist.

**Step 3: Implement the thin wrapper**

- Constructor accepts only framework base kwargs plus `version` and optional `variant`; reject custom endpoint kwargs.
- Reuse common install/model/trajectory functions. Keep Harbor-specific code limited to `install`, `run`, `populate_context_post_run`, error classification, and `AgentContext` assignment.
- Read the selected credential from the base class's scoped `extra_env`/host lookup for preflight, but let Harbor's trial-scoped agent environment deliver it to the process; never interpolate it into the command or pass it in `_exec(..., env=...)`.
- Capture Swain NDJSON at `/logs/agent/swain.ndjson` for debugging while ensuring known secrets are redacted.
- Do not modify the benchmark prompt with Harbor's prompt-template decorator unless a user explicitly supplies Harbor's standard prompt template; default is byte-preserving.

**Step 4: Verify**

Run the Harbor wrapper test command again. Expected: PASS.

**Commit:** `feat(evals): add harbor swain agent`

## Task 6: Implement the Pier installed-agent wrapper

**Objective:** Run the same Swain contract under DeepSWE's network-isolated Pier environment.

**Files:**

- Create: `evals/pier/__init__.py`
- Create: `evals/pier/agent.py`
- Modify: `evals/tests/test_wrappers.py`

**Step 1: Write failing wrapper tests**

Using Pier models/fakes, assert:

- `SwainPierAgent` inherits `pier.agents.installed.base.BaseInstalledAgent`, sets `SUPPORTS_ATIF = True`, and has the same public kwargs/model behavior as Harbor's wrapper;
- `install_spec()` returns an `AgentInstallSpec` whose cache/fingerprint changes with the Swain version or install contract, installs the shared artifact as root, and verifies the installed version;
- `network_allowlist()` contains exactly the selected provider's official domain—no package registry, GitHub, wildcard, custom gateway, or general internet domain at runtime;
- `run()` and post-run conversion match Harbor output semantics while validating with Pier's trajectory model;
- provider selection changes both the forwarded key and allowlist together, so they cannot drift.

**Step 2: Verify failure**

Run:

```bash
cd evals
uv run pytest tests/test_wrappers.py -k pier
```

Expected: FAIL because the Pier wrapper does not exist.

**Step 3: Implement the thin wrapper**

- Use Pier's declarative `AgentInstallSpec`; artifact download occurs during the install/build phase, before DeepSWE's runtime network restriction.
- Use `NetworkAllowlist(domains=[...])` from the shared provider table.
- Reuse the exact Swain command, trace layout, converter, and context-total logic from Task 5.
- Do not subclass or import the Harbor wrapper; the frameworks' base classes/lifecycles are separate.

**Step 4: Cross-framework verification**

Run:

```bash
cd evals
uv run pytest tests/test_wrappers.py
uv run pytest tests/test_trajectory.py
```

Expected: both wrappers pass and generated trajectories validate under both frameworks.

**Commit:** `feat(evals): add pier swain agent`

## Task 7: Pin benchmark inputs and add reproducible run commands

**Objective:** Make single-task acceptance and full manual jobs repeatable without checking benchmark data into Swain.

**Files:**

- Create: `evals/benchmarks.lock.json`
- Create: `evals/scripts/fetch-deep-swe.sh`
- Create: `evals/scripts/run-terminal-bench-2.sh`
- Create: `evals/scripts/run-deep-swe.sh`
- Create: `evals/README.md`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`

**Pinned inputs:**

- Harbor package: `terminal-bench/terminal-bench-2@1`; record the resolved dataset/task digests produced by Harbor 0.20.0 in `benchmarks.lock.json` and fail if resolution changes.
- DeepSWE repository: `datacurve-ai/deep-swe` commit `6db64a40f3318d8659238ff34a8cc4b491c49205` (113 tasks at planning time). Clone/fetch into ignored `evals/.cache/deep-swe`, verify `HEAD`, and run its `tasks/` directory through Pier.
- Framework package versions and Swain release version/checksums are separate lock dimensions and must appear in every job's resolved configuration.

**Script contract:**

- Require `SWAIN_EVAL_VERSION`, `SWAIN_EVAL_MODEL` (`provider/model`), and optional `SWAIN_EVAL_VARIANT`; require only the selected provider credential and pass it through the framework's `--agent-env` facility, whose persisted/resolved config is redacted.
- Default to Docker and concurrency `1` for acceptance. Allow the user to pass additional framework arguments after `--` for full/manual runs.
- Terminal-Bench script uses Harbor's import path and registry dataset; DeepSWE script uses Pier's `--agent-import-path` and pinned local checkout.
- Never echo keys. Set `HARBOR_TELEMETRY=off` in documented reproducibility commands so benchmark runs do not vary by telemetry availability.
- Preserve framework-produced `config.json`, `lock.json`, results, verifier output, native traces, and ATIF under the job directory.

**Acceptance commands:**

```bash
cd evals
uv sync --frozen

# Cheap install/import preflight; no model request.
./scripts/run-terminal-bench-2.sh --install-only

# One live Terminal-Bench 2 task.
./scripts/run-terminal-bench-2.sh --include-task-name cancel-async-tasks --n-tasks 1

# One live DeepSWE task.
./scripts/run-deep-swe.sh --include-task-name abs-module-cache-flags --n-tasks 1 --sample-seed 0
```

For each live task, success means the trial lifecycle completes, the verifier emits a valid reward (including `0`), the root/child files validate as ATIF, context token totals equal root plus children, and no known credential appears anywhere under the job directory. Do not require reward `1` to prove adapter integration.

**Full-run examples:**

```bash
./scripts/run-terminal-bench-2.sh --n-concurrent 4
./scripts/run-deep-swe.sh --env modal --n-concurrent 16 --sample-seed 0
```

These are manual paid jobs, not CI or implementation gates.

**Documentation:**

- `evals/README.md`: prerequisites, release pinning, credentials, model/variant mapping, Docker vs Modal, single-task/full commands, result layout, viewer use, and troubleshooting unsupported targets/libc.
- Root `README.md`: link to eval docs without duplicating commands.
- `ARCHITECTURE.md`: record the native trace -> ATIF boundary, separate Harbor/Pier wrappers, and artifact dependency.

**Verification:**

```bash
cd evals
uv lock --check
uv run ruff check .
uv run ruff format --check .
uv run pytest
cd ..
bun run format:check
bun run typecheck
bun run test
```

Then run the install-only preflight and the two opt-in live acceptance commands with a funded API key.

**Commit:** `docs(evals): add pinned benchmark runs`

## Final Acceptance Checklist

- [ ] A clean glibc or musl x64 task container installs an exact checksummed Swain release; Bun and system `rg` are unnecessary.
- [ ] Harbor runs Terminal-Bench 2 through `SwainHarborAgent`; Pier runs pinned DeepSWE through `SwainPierAgent` with only the model endpoint allowlisted.
- [ ] One live task from each benchmark reaches verification and produces framework results.
- [ ] Parent and every completed Swain child have separate valid ATIF-v1.7 files linked by `trajectory_path`.
- [ ] Reasoning, text, tool calls/results, timestamps, durations, and token usage survive conversion.
- [ ] Harbor/Pier context token totals include children exactly once; unobserved cost/cache values remain absent.
- [ ] The prompt is unchanged, routing is off, subagents inherit the fixed model, and all normal headless tools remain enabled.
- [ ] Exact known credentials do not appear in NDJSON, native traces, ATIF, errors, or job logs.
- [ ] Full benchmark execution remains an explicit manual operation; CI is deterministic and does not spend model tokens.

## Risks and Follow-ons

- **Codex OAuth:** parallel task containers cannot safely rotate copies of one refresh token. Add a credential coordinator or another explicit design before supporting `openai-codex/`.
- **Framework drift:** Harbor/Pier bases are intentionally separate. Exact pins plus wrapper contract tests make upgrades deliberate.
- **ATIF viewer behavior:** Pydantic validation does not prove every viewer resolves relative external refs. The live acceptance must open the parent trajectory in the framework viewer and follow at least one child reference when the selected task delegates; otherwise retain a synthetic viewer fixture for this check.
- **Task images without download tools:** the shared install command has ordered downloader/checksum fallbacks and fails before model use. If a real pinned benchmark image lacks all fallbacks, solve it in the artifact/install layer rather than adding package-manager mutation to the adapter.
- **Secret exfiltration:** exact-value redaction prevents accidental logging but cannot stop a model from transforming a secret. Stronger isolation would require a provider proxy and is outside this plan.
- **Benchmark revisions:** never silently update registry revision, DeepSWE commit, framework versions, Swain artifact, model ID, or variant in an existing baseline.
