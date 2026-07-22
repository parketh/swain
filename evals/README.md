# Swain evals

Run Swain as a custom installed agent against supported benchmarks:
- Terminal-Bench 2 (via [Harbor](https://www.harborframework.com))
- DeepSWE (via [Pier](https://github.com/datacurve-ai/deep-swe))

Each wrapper installs a pinned, checksummed Swain release into a clean Linux container, runs `swain exec` with routing off, and converts Swain's native trace bundle into ATIF v1.7 parent/subagent trajectories with per-trial token totals.

## Setup

Prerequisite dependencies:
- **uv**
- **Python 3.12**
- **Docker**

To install dependencies and run tests:

```bash
cd evals
uv sync --frozen
uv run pytest
```

## Usage

To run the actual benchmarks, first set the release version and model by env (or drop them in a project-root `.env`, which is automatically sourced by the run scripts):

```bash
export SWAIN_EVAL_VERSION=<swain-release-semver>
export SWAIN_EVAL_MODEL=anthropic/claude-opus-4-8     # <provider>/<model>
export SWAIN_EVAL_VARIANT=high                        # (optional) reasoning variant

# selected provider's key, e.g.
export ANTHROPIC_API_KEY=...
# or ... 
export OPENAI_API_KEY=..
# ...
```

`SWAIN_EVAL_MODEL` and optional `SWAIN_EVAL_VARIANT` map to Swain's `provider:model[:variant]`. 

Only the *selected* provider's key is forwarded into the container (never the whole `.env`). For Pier, the specific provider domain is allowlisted:

| Provider | Credential | Domain |
| --- | --- | --- |
| `anthropic/` | `ANTHROPIC_API_KEY` | `api.anthropic.com` |
| `openai/` | `OPENAI_API_KEY` | `api.openai.com` |
| `kimi/` | `MOONSHOT_API_KEY` | `api.moonshot.ai` |
| `deepseek/` | `DEEPSEEK_API_KEY` | `api.deepseek.com` |
| `zai/` | `ZAI_API_KEY` | `api.z.ai` |

To run the benchmarks:

```bash
# Free preflight: install + import only, no model request
./scripts/run-terminal-bench-2.sh --install-only

# Run one live task (paid, spends tokens)
# Note: task name must be passed using the `--include-task-name` flag
./scripts/run-terminal-bench-2.sh --include-task-name terminal-bench/cancel-async-tasks --n-tasks 1
./scripts/run-deep-swe.sh --include-task-name abs-module-cache-flags --n-tasks 1 --sample-seed 0

# Full benchmark runs (paid, spends tokens)
./scripts/run-terminal-bench-2.sh --n-concurrent 4
./scripts/run-deep-swe.sh --env modal --n-concurrent 16 --sample-seed 0
```

## Pins & output

All benchmark, framework, and release pins live in [`benchmarks.lock.json`](benchmarks.lock.json) and are recorded in each job's resolved config; a later run fails if resolution drifts. Never edit a pin in an existing baseline.

Framework output is preserved under `.cache/jobs/…` (gitignored).

## Troubleshooting

- **Unsupported target / libc:** only `x86_64` glibc/musl releases are published; the install shell fails clearly on ARM or an undetectable libc before any download.
- **Missing / rejected credential:** the run scripts fail fast if the selected provider's key is unset; other providers' keys are never forwarded, and custom base URLs are refused.
