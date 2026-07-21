#!/usr/bin/env bash
#
# Black-box smoke test for the released Linux archives. It verifies the checksum
# index up front, then extracts each archive inside a digest-pinned clean
# container (Bun absent, minimal PATH) and asserts the standalone executable,
# its private ripgrep sidecar, and the manifest are all intact.
#
#   bash smoke-release.sh <dist-dir> <version>
#   bash smoke-release.sh <dist-dir> <version> --mismatch
#
# --mismatch runs the negative case: the glibc archive is handed to the Alpine
# (musl) container, and the harness must report the target/libc mismatch rather
# than silently accepting it.
set -euo pipefail

# Pinned base images (multi-arch index digests) — clean containers with no Bun.
DEBIAN_IMAGE="debian@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818"
ALPINE_IMAGE="alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"

DIST="${1:?usage: smoke-release.sh <dist-dir> <version> [--mismatch]}"
VERSION="${2:?usage: smoke-release.sh <dist-dir> <version> [--mismatch]}"
MODE="${3:-normal}"

GLIBC_ARCHIVE="swain-v${VERSION}-linux-x64-glibc.tar.gz"
MUSL_ARCHIVE="swain-v${VERSION}-linux-x64-musl.tar.gz"

# In-container assertions, run under a minimal PATH so a stray system rg/bun is
# never picked up. Expects $ARCHIVE, $VERSION, and $TARGET in the environment.
CONTAINER_SCRIPT='
set -eu
export PATH=/usr/bin:/bin
work=$(mktemp -d)
tar -xzf "/dist/$ARCHIVE" -C "$work"
cd "$work"

got_version=$(./bin/swain --version)
[ "$got_version" = "$VERSION" ] || { echo "swain --version: expected $VERSION, got $got_version" >&2; exit 1; }

./bin/swain --help >/dev/null

got_rg=$(./libexec/rg --version | head -n1)
case "$got_rg" in
  "ripgrep 15.1.0"*) ;;
  *) echo "rg --version: expected ripgrep 15.1.0, got $got_rg" >&2; exit 1 ;;
esac

grep -q "\"target\": \"$TARGET\"" manifest.json || { echo "manifest target != $TARGET" >&2; exit 1; }
echo "  ok: $TARGET"
'

verify_checksums() {
  echo "verifying checksums before extraction"
  ( cd "$DIST" && sha256sum -c checksums.txt )
}

smoke_one() { # image archive target
  docker run --rm --network none \
    -e VERSION="$VERSION" -e TARGET="$3" -e ARCHIVE="$2" \
    -v "$(cd "$DIST" && pwd)":/dist:ro \
    "$1" sh -c "$CONTAINER_SCRIPT"
}

verify_checksums

if [ "$MODE" = "--mismatch" ]; then
  echo "negative check: glibc archive on Alpine (musl) must fail"
  if smoke_one "$ALPINE_IMAGE" "$GLIBC_ARCHIVE" "linux-x64-glibc" 2>/dev/null; then
    echo "FAIL: glibc archive ran clean on Alpine — target mismatch went undetected" >&2
    exit 1
  fi
  echo "  ok: target mismatch correctly detected"
  exit 0
fi

echo "smoking linux-x64-glibc on Debian"
smoke_one "$DEBIAN_IMAGE" "$GLIBC_ARCHIVE" "linux-x64-glibc"
echo "smoking linux-x64-musl on Alpine"
smoke_one "$ALPINE_IMAGE" "$MUSL_ARCHIVE" "linux-x64-musl"
echo "all clean-container smokes passed"
