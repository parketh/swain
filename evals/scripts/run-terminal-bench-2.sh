#!/usr/bin/env bash
# Run Terminal-Bench 2 through Harbor with the Swain installed-agent wrapper.
#
# Required env:
#   SWAIN_EVAL_VERSION   exact Swain release SemVer (e.g. 1.2.3)
#   SWAIN_EVAL_MODEL     provider/model (e.g. anthropic/claude-opus-4-8)
# Optional env:
#   SWAIN_EVAL_VARIANT   reasoning variant (e.g. high)
#   <PROVIDER>_API_KEY   only the selected provider's credential must be set
#
# Any extra arguments are forwarded verbatim to `harbor run`, e.g.
#   ./scripts/run-terminal-bench-2.sh --install-only
#   ./scripts/run-terminal-bench-2.sh --include-task-name cancel-async-tasks --n-tasks 1
#   ./scripts/run-terminal-bench-2.sh --n-concurrent 4
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"

# Load config from the project-root .env if present (override the path with
# SWAIN_ENV_FILE) so the script can be configured without exporting by hand.
# Standard dotenv sourcing — `set -a` auto-exports every assignment into the
# `harbor run` process env. The wrapper reads only the selected provider key from
# os.environ, so other keys in .env never reach the agent.
env_file="${SWAIN_ENV_FILE:-$here/../.env}"
if [ -f "$env_file" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$env_file"
  set +a
fi

: "${SWAIN_EVAL_VERSION:?set SWAIN_EVAL_VERSION to an exact Swain release SemVer}"
: "${SWAIN_EVAL_MODEL:?set SWAIN_EVAL_MODEL to provider/model}"

dataset="$(python3 -c "import json; print(json.load(open('$here/benchmarks.lock.json'))['terminal_bench']['dataset'])")"

# Resolve the selected provider's credential env var from the single source of
# truth (the shared model table); reject unsupported models before any request.
cred_var="$(cd "$here" && uv run python -c "
import os
from evals.common.models import resolve_model
sel = resolve_model(os.environ['SWAIN_EVAL_MODEL'], os.environ.get('SWAIN_EVAL_VARIANT') or None)
print(sel.credential_env)
")"

if [ -z "${!cred_var:-}" ]; then
  echo "run-terminal-bench-2: required credential \$$cred_var is not set" >&2
  exit 1
fi

agent_kwargs=(--ak "version=$SWAIN_EVAL_VERSION")
if [ -n "${SWAIN_EVAL_VARIANT:-}" ]; then
  agent_kwargs+=(--ak "variant=$SWAIN_EVAL_VARIANT")
fi

# HARBOR_TELEMETRY=off keeps runs reproducible regardless of telemetry availability.
# The credential is inherited from this script's exported env (never passed on the
# command line): the wrapper reads exactly the selected provider key from os.environ,
# so it stays out of the world-readable `harbor run` argv. Concurrency defaults to 1
# for acceptance; a later --n-concurrent in "$@" overrides it.
HARBOR_TELEMETRY=off exec uv run harbor run \
  --dataset "$dataset" \
  --agent evals.harbor.agent:SwainHarborAgent \
  --model "$SWAIN_EVAL_MODEL" \
  "${agent_kwargs[@]}" \
  --jobs-dir "$here/.cache/jobs/terminal-bench-2" \
  --n-concurrent 1 \
  --yes \
  "$@"
