"""Pure Swain release-artifact selection and install-shell generation.

No framework imports: both wrappers reuse these helpers to install an exact,
checksummed Swain release (spec 0011) into a clean Linux task container. The
install is generated POSIX shell that verifies the SHA-256 from the release
``checksums.txt`` before extraction and installs read-only under
``/opt/swain/v<version>`` with no global symlink.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# GitHub repository that publishes the release archives (spec 0011).
RELEASE_REPO = "parketh/swain"

# Exact SemVer: MAJOR.MINOR.PATCH with optional pre-release/build metadata.
_SEMVER = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-]"
    r"[0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$"
)

# Public targets published by spec 0011. Keyed by detected libc.
_LIBCS = ("glibc", "musl")
_SUPPORTED_MACHINES = frozenset({"x86_64", "amd64"})
INSTALL_ROOT = "/opt/swain"


class ArtifactError(ValueError):
    """Raised for an unsupported version, architecture, or libc."""


def validate_version(version: str) -> str:
    """Return ``version`` if it is an exact SemVer, else raise.

    Rejects ``latest``, branch names, local binary paths, and source checkouts:
    the adapters install a pinned, published release only.
    """
    if not version or not _SEMVER.match(version):
        raise ArtifactError(
            f"Swain version must be an exact SemVer (e.g. 1.2.3), got {version!r}. "
            "'latest', branches, local binaries, and source checkouts are rejected."
        )
    return version


@dataclass(frozen=True)
class ReleaseAssets:
    """The published asset filenames for one release version."""

    version: str
    glibc: str
    musl: str
    checksums: str = "checksums.txt"

    def for_libc(self, libc: str) -> str:
        if libc == "glibc":
            return self.glibc
        if libc == "musl":
            return self.musl
        raise ArtifactError(f"Unknown libc {libc!r}; expected one of {_LIBCS}.")


def release_assets(version: str) -> ReleaseAssets:
    """Return the exact asset names for a release (spec 0011 naming)."""
    validate_version(version)
    return ReleaseAssets(
        version=version,
        glibc=f"swain-v{version}-linux-x64-glibc.tar.gz",
        musl=f"swain-v{version}-linux-x64-musl.tar.gz",
    )


def release_base_url(version: str, repo: str = RELEASE_REPO) -> str:
    """The GitHub release download base URL for ``v<version>``."""
    validate_version(version)
    return f"https://github.com/{repo}/releases/download/v{version}"


def asset_url(version: str, asset: str, repo: str = RELEASE_REPO) -> str:
    return f"{release_base_url(version, repo)}/{asset}"


def normalize_machine(machine: str) -> str:
    """Map ``uname -m`` output to the release architecture, or reject it."""
    m = machine.strip().lower()
    if m in _SUPPORTED_MACHINES:
        return "x86_64"
    raise ArtifactError(
        f"Unsupported architecture {machine!r}. Only x86_64 releases are published; "
        "ARM/other targets fail before download."
    )


@dataclass(frozen=True)
class ArtifactSelection:
    """A concrete asset choice for a detected host."""

    version: str
    libc: str
    asset: str
    url: str
    checksums: str
    checksums_url: str
    install_dir: str


def select_artifact(
    version: str,
    machine: str,
    libc: str,
    repo: str = RELEASE_REPO,
) -> ArtifactSelection:
    """Select the release asset/URL/checksum index for a detected host."""
    validate_version(version)
    normalize_machine(machine)
    if libc not in _LIBCS:
        raise ArtifactError(
            f"Unsupported libc {libc!r}; expected glibc or musl. Unknown libc fails."
        )
    assets = release_assets(version)
    asset = assets.for_libc(libc)
    return ArtifactSelection(
        version=version,
        libc=libc,
        asset=asset,
        url=asset_url(version, asset, repo),
        checksums=assets.checksums,
        checksums_url=asset_url(version, assets.checksums, repo),
        install_dir=f"{INSTALL_ROOT}/v{version}",
    )


def install_dir(version: str) -> str:
    """Read-only versioned install root, e.g. ``/opt/swain/v1.2.3``."""
    return f"{INSTALL_ROOT}/v{validate_version(version)}"


def swain_bin(version: str) -> str:
    return f"{install_dir(version)}/bin/swain"


def rg_bin(version: str) -> str:
    return f"{install_dir(version)}/libexec/rg"


def install_script(version: str, repo: str = RELEASE_REPO) -> str:
    """Generate the POSIX shell that installs an exact Swain release.

    The generated script: refuses non-x86_64 / unknown-libc hosts; downloads the
    checksum index and the libc-matched archive using the first available of
    curl, wget, python3, python; verifies SHA-256 before extraction; verifies the
    manifest target and version; installs read-only under ``/opt/swain/v<version>``
    without a global symlink; and never replaces a valid install on mismatch.
    """
    validate_version(version)
    assets = release_assets(version)
    base = release_base_url(version, repo)
    install_dir = f"{INSTALL_ROOT}/v{version}"
    return _INSTALL_TEMPLATE.format(
        version=version,
        base_url=base,
        glibc_asset=assets.glibc,
        musl_asset=assets.musl,
        checksums=assets.checksums,
        install_root=INSTALL_ROOT,
        install_dir=install_dir,
    )


# The download helper tries curl, wget, python3, then python in order; SHA-256 is
# verified against the release index before any extraction; the archive is
# staged and validated before it is moved over a valid install.
_INSTALL_TEMPLATE = """\
set -eu

SWAIN_VERSION="{version}"
BASE_URL="{base_url}"
CHECKSUMS="{checksums}"
INSTALL_ROOT="{install_root}"
INSTALL_DIR="{install_dir}"

fail() {{ echo "swain-install: $1" >&2; exit 1; }}

machine="$(uname -m)"
case "$machine" in
  x86_64 | amd64) ;;
  *) fail "unsupported architecture: $machine (only x86_64 is published)" ;;
esac

# Detect libc by loader file first (a plain stat, robust under CPU emulation
# where executing `ldd` can be flaky), falling back to `ldd --version`.
if [ -f /lib/ld-musl-x86_64.so.1 ] || (ldd --version 2>&1 | grep -qi musl); then
  LIBC="musl"
  ASSET="{musl_asset}"
elif [ -f /lib64/ld-linux-x86-64.so.2 ] || [ -f /lib/x86_64-linux-gnu/libc.so.6 ] \
  || (ldd --version 2>&1 | grep -qiE 'glibc|gnu libc|gnu c library'); then
  LIBC="glibc"
  ASSET="{glibc_asset}"
else
  fail "could not detect glibc or musl libc"
fi

download() {{
  # $1 = url, $2 = destination path. Try downloaders in order.
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2" && return 0
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -q "$1" -O "$2" && return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys,urllib.request; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])' "$1" "$2" && return 0
  fi
  if command -v python >/dev/null 2>&1; then
    python -c 'import sys,urllib; urllib.urlretrieve(sys.argv[1], sys.argv[2])' "$1" "$2" && return 0
  fi
  fail "no downloader available (need curl, wget, python3, or python)"
}}

sha256_of() {{
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{{print $1}}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{{print $1}}'
  else
    fail "no sha256 tool available (need sha256sum or shasum)"
  fi
}}

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

download "$BASE_URL/$CHECKSUMS" "$STAGE/$CHECKSUMS"
download "$BASE_URL/$ASSET" "$STAGE/$ASSET"

expected="$(grep "  $ASSET\\$" "$STAGE/$CHECKSUMS" | awk '{{print $1}}')"
[ -n "$expected" ] || fail "no checksum for $ASSET in $CHECKSUMS"
actual="$(sha256_of "$STAGE/$ASSET")"
[ "$expected" = "$actual" ] || fail "checksum mismatch for $ASSET (expected $expected, got $actual)"

# Verify BEFORE extraction; extract into a staging dir, never over a valid install.
mkdir -p "$STAGE/unpack"
tar -xzf "$STAGE/$ASSET" -C "$STAGE/unpack"

MANIFEST="$STAGE/unpack/manifest.json"
[ -f "$MANIFEST" ] || fail "archive missing manifest.json"
grep -q '"swainVersion"[[:space:]]*:[[:space:]]*"'"$SWAIN_VERSION"'"' "$MANIFEST" \\
  || fail "manifest version does not match $SWAIN_VERSION"
grep -q '"target"[[:space:]]*:[[:space:]]*"linux-x64-'"$LIBC"'"' "$MANIFEST" \\
  || fail "manifest target does not match linux-x64-$LIBC"
[ -x "$STAGE/unpack/bin/swain" ] || fail "archive missing bin/swain"
[ -x "$STAGE/unpack/libexec/rg" ] || fail "archive missing libexec/rg"

# Only now replace/create the versioned install, read-only, no global symlink.
mkdir -p "$INSTALL_ROOT"
rm -rf "$INSTALL_DIR"
mv "$STAGE/unpack" "$INSTALL_DIR"
chmod -R a-w "$INSTALL_DIR"
chmod a+rx "$INSTALL_DIR/bin/swain" "$INSTALL_DIR/libexec/rg"

echo "swain-install: installed $SWAIN_VERSION ($LIBC) at $INSTALL_DIR"
"""
