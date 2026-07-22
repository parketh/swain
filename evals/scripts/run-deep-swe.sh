#!/usr/bin/env bash
# Run DeepSWE through Pier with the Swain installed-agent wrapper. Pier is used
# (not Harbor) because DeepSWE tasks set allow_internet = false; Pier grants only
# the selected provider's domain during the agent phase.
#
# Required env:
#   SWAIN_EVAL_VERSION   exact Swain release SemVer
#   SWAIN_EVAL_MODEL     provider/model (e.g. deepseek/deepseek-v4-pro)
# Optional env:
#   SWAIN_EVAL_VARIANT   reasoning variant
#   <PROVIDER>_API_KEY   only the selected provider's credential must be set
#
# Extra arguments forward verbatim to `pier run`, e.g.
#   ./scripts/run-deep-swe.sh --include-task-name abs-module-cache-flags --n-tasks 1 --sample-seed 0
#   ./scripts/run-deep-swe.sh --env modal --n-concurrent 16 --sample-seed 0
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
: "${SWAIN_EVAL_VERSION:?set SWAIN_EVAL_VERSION to an exact Swain release SemVer}"
: "${SWAIN_EVAL_MODEL:?set SWAIN_EVAL_MODEL to provider/model}"

# Ensure the pinned DeepSWE checkout exists and matches the locked commit.
"$here/scripts/fetch-deep-swe.sh"
subdir="$(python3 -c "import json; print(json.load(open('$here/benchmarks.lock.json'))['deep_swe']['checkout_dir'])")"
tasks_subdir="$(python3 -c "import json; print(json.load(open('$here/benchmarks.lock.json'))['deep_swe']['tasks_subdir'])")"
tasks_path="$here/$subdir/$tasks_subdir"

cred_var="$(cd "$here" && uv run python -c "
import os
from evals.common.models import resolve_model
sel = resolve_model(os.environ['SWAIN_EVAL_MODEL'], os.environ.get('SWAIN_EVAL_VARIANT') or None)
print(sel.credential_env)
")"

if [ -z "${!cred_var:-}" ]; then
  echo "run-deep-swe: required credential \$$cred_var is not set" >&2
  exit 1
fi

agent_kwargs=(--ak "version=$SWAIN_EVAL_VERSION")
if [ -n "${SWAIN_EVAL_VARIANT:-}" ]; then
  agent_kwargs+=(--ak "variant=$SWAIN_EVAL_VARIANT")
fi

# Default to Docker and concurrency 1 for acceptance; a later --env / --n-concurrent
# in "$@" overrides. The credential travels via --agent-env and is never echoed.
exec uv run pier run \
  --path "$tasks_path" \
  --agent-import-path evals.pier.agent:SwainPierAgent \
  --model "$SWAIN_EVAL_MODEL" \
  "${agent_kwargs[@]}" \
  --agent-env "$cred_var=${!cred_var}" \
  --env docker \
  --n-concurrent 1 \
  --yes \
  "$@"
