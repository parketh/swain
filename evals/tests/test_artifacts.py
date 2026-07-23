"""Artifact selection and install-shell contract tests."""

from __future__ import annotations

import subprocess

import pytest

from evals.common import artifacts
from evals.common.artifacts import ArtifactError

VERSION = "1.4.2"


@pytest.mark.parametrize("version", ["1.4.2", "0.0.0", "10.20.30", "1.2.3-rc.1", "1.2.3+build.5"])
def test_validate_version_accepts_exact_semver(version):
    assert artifacts.validate_version(version) == version


@pytest.mark.parametrize(
    "version",
    ["latest", "main", "v1.4.2", "1.4", "1", "", "/opt/swain/bin/swain", "feature/x", "1.2.x"],
)
def test_validate_version_rejects_non_semver(version):
    with pytest.raises(ArtifactError):
        artifacts.validate_version(version)


def test_release_assets_names_are_exact():
    assets = artifacts.release_assets(VERSION)
    assert assets.glibc == "swain-v1.4.2-linux-x64-glibc.tar.gz"
    assert assets.musl == "swain-v1.4.2-linux-x64-musl.tar.gz"
    assert assets.checksums == "checksums.txt"


def test_asset_url_points_at_pinned_release():
    url = artifacts.asset_url(VERSION, "checksums.txt")
    assert url == "https://github.com/parketh/swain/releases/download/v1.4.2/checksums.txt"


@pytest.mark.parametrize("machine", ["x86_64", "amd64", "X86_64"])
def test_normalize_machine_accepts_x64(machine):
    assert artifacts.normalize_machine(machine) == "x86_64"


@pytest.mark.parametrize("machine", ["aarch64", "arm64", "armv7l", "riscv64"])
def test_normalize_machine_rejects_non_x64(machine):
    with pytest.raises(ArtifactError):
        artifacts.normalize_machine(machine)


def test_select_artifact_glibc_and_musl():
    glibc = artifacts.select_artifact(VERSION, "x86_64", "glibc")
    assert glibc.asset == "swain-v1.4.2-linux-x64-glibc.tar.gz"
    assert glibc.install_dir == "/opt/swain/v1.4.2"
    assert glibc.url.endswith("/swain-v1.4.2-linux-x64-glibc.tar.gz")

    musl = artifacts.select_artifact(VERSION, "amd64", "musl")
    assert musl.asset == "swain-v1.4.2-linux-x64-musl.tar.gz"


def test_select_artifact_rejects_unknown_libc():
    with pytest.raises(ArtifactError):
        artifacts.select_artifact(VERSION, "x86_64", "uclibc")


def test_select_artifact_rejects_arm():
    with pytest.raises(ArtifactError):
        artifacts.select_artifact(VERSION, "aarch64", "glibc")


def test_install_paths():
    assert artifacts.install_dir(VERSION) == "/opt/swain/v1.4.2"
    assert artifacts.swain_bin(VERSION) == "/opt/swain/v1.4.2/bin/swain"
    assert artifacts.rg_bin(VERSION) == "/opt/swain/v1.4.2/libexec/rg"


class TestInstallScript:
    @pytest.fixture
    def script(self) -> str:
        return artifacts.install_script(VERSION)

    def test_is_valid_posix_shell(self, script):
        result = subprocess.run(["sh", "-n"], input=script, text=True, capture_output=True)
        assert result.returncode == 0, result.stderr

    def test_downloaders_tried_in_order(self, script):
        order = [
            script.index(f"command -v {tool} ") for tool in ("curl", "wget", "python3", "python")
        ]
        assert order == sorted(order)

    def test_verifies_arch_and_libc(self, script):
        assert "unsupported architecture" in script
        assert "could not detect glibc or musl" in script

    def test_libc_detection_prefers_loader_files(self, script):
        # A plain stat on the loader file is robust where executing `ldd` is flaky
        # (e.g. x86_64 under QEMU emulation on an arm64 host).
        assert "/lib/ld-musl-x86_64.so.1" in script
        assert "/lib64/ld-linux-x86-64.so.2" in script
        assert "/lib/x86_64-linux-gnu/libc.so.6" in script

    def test_sha256_verified_before_extraction(self, script):
        checksum_cmp = script.index('[ "$expected" = "$actual" ]')
        extract = script.index("tar -xzf")
        assert checksum_cmp < extract

    def test_verifies_manifest_target_and_version(self, script):
        assert "manifest version does not match" in script
        assert "manifest target does not match" in script
        manifest_check = script.index("manifest version does not match")
        extract = script.index("tar -xzf")
        assert extract < manifest_check

    def test_validates_rg_before_replacing_install(self, script):
        rg_check = script.index("archive missing libexec/rg")
        replace = script.index('rm -rf "$INSTALL_DIR"')
        assert rg_check < replace

    def test_installs_readonly_under_versioned_root(self, script):
        assert 'INSTALL_DIR="/opt/swain/v1.4.2"' in script
        assert "chmod -R a-w" in script

    def test_no_global_symlink(self, script):
        assert "/usr/local/bin" not in script
        assert "/usr/bin/swain" not in script
        assert "ln -s" not in script

    def test_mismatch_fails_before_replacing_install(self, script):
        checksum_cmp = script.index('[ "$expected" = "$actual" ]')
        replace = script.index('mv "$STAGE/unpack" "$INSTALL_DIR"')
        assert checksum_cmp < replace
