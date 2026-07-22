# Swain evals

Run Swain reproducibly as a **custom installed agent** against Terminal-Bench 2 (through [Harbor](https://www.harborframework.com)) and DeepSWE (through [Pier](https://github.com/datacurve-ai/deep-swe)). Both wrappers install an exact, checksummed Swain release into a clean Linux task container, run `swain exec` with routing off, and convert Swain's native trace bundle into complete **ATIF v1.7** parent/subagent trajectories with verified per-trial token totals.

The design and contracts live in [`../specs/0012-harbor-evals.md`](../specs/0012-harbor-evals.md).

## Prerequisites

- **uv** `0.11.11` and **Python** `>=3.12,<3.13` (uv fetches it).
- **Docker** for the default (acceptance) environment. Modal is supported through Pier for full DeepSWE runs but is not an acceptance dependency.
- A **published Swain release** — the adapters never build from source or install a host-local binary. The release workflow attaches `swain-vX.Y.Z-linux-x64-{glibc,musl}.tar.gz` and `checksums.txt`; the install shell verifies the SHA-256 before extraction and installs read-only under `/opt/swain/v<version>` with no global symlink.

```bash
cd evals
uv sync --frozen        # install locked deps into .venv
uv run pytest           # contract + wrapper unit tests (no Docker, no tokens)
```

## Pinned inputs

All pins live in [`benchmarks.lock.json`](benchmarks.lock.json) and must appear in every job's resolved configuration; never silently update a pin in an existing baseline.

- **Terminal-Bench:** Harbor registry dataset `terminal-bench/terminal-bench-2@1` (resolved dataset/task digests are recorded on the first live run and a later run fails if resolution drifts).
- **DeepSWE:** `datacurve-ai/deep-swe` at commit `6db64a40f3318d8659238ff34a8cc4b491c49205` (113 tasks at pin), fetched into the ignored `evals/.cache/deep-swe` by `scripts/fetch-deep-swe.sh`.
- **Framework versions** (`harbor==0.20.0`, `datacurve-pier==0.3.0`) and the **Swain release version + checksums** are separate lock dimensions.

## Credentials & model/variant mapping

Set the release version and model via env; only the *selected* provider's key must be present, and it is delivered through the framework's scoped `--agent-env` facility (never the command line or a base-class-logged `env=`). Custom base URLs, gateways, and ChatGPT/Codex OAuth are rejected in v1.

```bash
export SWAIN_EVAL_VERSION=1.2.3
export SWAIN_EVAL_MODEL=anthropic/claude-opus-4-8   # <provider>/<model>
export SWAIN_EVAL_VARIANT=high                       # optional reasoning variant
export ANTHROPIC_API_KEY=...                          # only the selected provider's key
```

Instead of exporting by hand, put these in a project-root `.env` (gitignored) — the run scripts source it automatically (override the path with `SWAIN_ENV_FILE`, or skip it with `SWAIN_ENV_FILE=/dev/null`). The `.env` feeds the host script only; still just the selected provider's key is forwarded into the container via `--agent-env`, so other keys in the file never reach the agent. Don't use Harbor/Pier's own `--env-file` for credentials — that would forward every variable into the container.

`SWAIN_EVAL_MODEL` (`<provider>/<model>`) plus the optional variant map to Swain's `provider:model[:variant]`:

| Model prefix | Credential | Provider domain |
| --- | --- | --- |
| `anthropic/` | `ANTHROPIC_API_KEY` | `api.anthropic.com` |
| `openai/` | `OPENAI_API_KEY` | `api.openai.com` |
| `kimi/` | `MOONSHOT_API_KEY` | `api.moonshot.ai` |
| `deepseek/` | `DEEPSEEK_API_KEY` | `api.deepseek.com` |
| `zai/` | `ZAI_API_KEY` | `api.z.ai` |

Under Pier, the selected provider's domain is the *only* host allowlisted during the agent phase.

## Single-task acceptance

These are the opt-in checks; the first is free (install/import only), the other two spend tokens on one live task each.

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

For each live task, success means: the trial lifecycle completes, the verifier emits a valid reward (**including `0`** — reward `1` is not required to prove integration), the root/child files validate as ATIF, the context token total equals root plus children, and no known credential appears anywhere under the job directory.

## Full / manual runs

Manual paid jobs — not CI. Extra arguments after the script name forward verbatim to `harbor run` / `pier run`.

```bash
./scripts/run-terminal-bench-2.sh --n-concurrent 4
./scripts/run-deep-swe.sh --env modal --n-concurrent 16 --sample-seed 0
```

## Result layout

Framework output is preserved under the job directory (`evals/.cache/jobs/…`, gitignored): the resolved `config.json`, `lock.json`, per-trial results, verifier output, Swain's native trace bundle (`/logs/agent/swain/{root,manifest}.json` + `subagents/<id>.json`), the debug NDJSON (`swain.ndjson`, redacted), and the converted ATIF `trajectory.json` + `subagents/<id>.json`.

## Viewer

Open the parent trajectory in the framework viewer (`harbor view` / `pier view`) and follow at least one child reference when the selected task delegates — Pydantic validation proves the files are well-formed but not that a viewer resolves relative external refs.

## Troubleshooting

- **Unsupported target / libc:** only `x86_64` glibc/musl releases are published. The install shell fails clearly on ARM or an undetectable libc before any download; solve missing-image download tools in the artifact/install layer, not by mutating the task's package manager.
- **`openai-codex/` or a custom base URL:** rejected in v1 — parallel Codex OAuth needs coordinated refresh-token rotation (a follow-on spec).
- **Missing credential:** the run scripts fail fast if the selected provider's key is unset; other providers' keys are never forwarded.
