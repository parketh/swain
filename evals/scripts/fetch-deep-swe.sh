#!/usr/bin/env bash
# Clone/fetch the pinned DeepSWE benchmark into the ignored local cache and
# verify HEAD matches the commit in benchmarks.lock.json. Idempotent.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
lock="$here/benchmarks.lock.json"

repo="$(python3 -c "import json,sys; print(json.load(open('$lock'))['deep_swe']['repo'])")"
commit="$(python3 -c "import json,sys; print(json.load(open('$lock'))['deep_swe']['commit'])")"
subdir="$(python3 -c "import json,sys; print(json.load(open('$lock'))['deep_swe']['checkout_dir'])")"
dest="$here/$subdir"

url="https://github.com/${repo}.git"

if [ ! -d "$dest/.git" ]; then
  echo "fetch-deep-swe: cloning ${repo} into ${dest}"
  mkdir -p "$(dirname "$dest")"
  git clone --quiet "$url" "$dest"
fi

git -C "$dest" fetch --quiet origin "$commit" 2>/dev/null || git -C "$dest" fetch --quiet origin
git -C "$dest" checkout --quiet "$commit"

head="$(git -C "$dest" rev-parse HEAD)"
if [ "$head" != "$commit" ]; then
  echo "fetch-deep-swe: HEAD ${head} does not match pinned ${commit}" >&2
  exit 1
fi

echo "fetch-deep-swe: ${repo} at ${commit} ready in ${dest}"
