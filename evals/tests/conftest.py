"""Shared test fixtures and framework fakes.

The flat ``evals`` layout places ``evals/harbor`` and ``evals/pier`` next to the
installed ``harbor``/``pier`` framework packages. Ensure the evals directory and
cwd never precede site-packages on ``sys.path`` so ``import harbor`` resolves to
the framework, while ``import evals`` still resolves via the repo root that
``pythonpath = ['..']`` adds.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
_EVALS_DIR = _TESTS_DIR.parent
_SHADOWING = {str(_EVALS_DIR), "", os.getcwd()}
sys.path[:] = [p for p in sys.path if p not in _SHADOWING]

import pytest  # noqa: E402

FIXTURES = _TESTS_DIR / "fixtures"


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def build_native_bundle(bundle_dir: Path, *, include_child: bool = True) -> Path:
    """Assemble a native trace bundle (manifest + root + child) on disk."""
    bundle_dir.mkdir(parents=True, exist_ok=True)
    (bundle_dir / "subagents").mkdir(exist_ok=True)
    shutil.copy(FIXTURES / "root-trace.json", bundle_dir / "root.json")
    children = []
    if include_child:
        shutil.copy(FIXTURES / "child-trace.json", bundle_dir / "subagents" / "child-xyz789.json")
        children.append(
            {
                "agentId": "child-xyz789",
                "taskId": "task-explore-1",
                "file": "subagents/child-xyz789.json",
            }
        )
    manifest = {
        "schemaVersion": 1,
        "swainVersion": "1.4.2",
        "rootAgentId": "root-abc123",
        "root": "root.json",
        "children": children,
    }
    (bundle_dir / "manifest.json").write_text(json.dumps(manifest))
    return bundle_dir


RESULT_EVENT_NDJSON = (
    '{"type":"system","subtype":"init"}\n'
    '{"type":"assistant","text":"working"}\n'
    '{"type":"result","subtype":"success"}\n'
)


@dataclass
class ExecCall:
    command: str
    user: str | int | None
    env: dict[str, str] | None
    cwd: str | None


@dataclass
class FakeExecResult:
    return_code: int = 0
    stdout: str | None = ""
    stderr: str | None = ""


@dataclass
class FakeEnvironment:
    """Minimal async stand-in for a Harbor/Pier ``BaseEnvironment``."""

    container_trace_dir: Path | None = None
    container_ndjson: Path | None = None
    exit_code: int = 0
    calls: list[ExecCall] = field(default_factory=list)

    async def exec(self, command, cwd=None, env=None, timeout_sec=None, user=None):
        self.calls.append(ExecCall(command=command, user=user, env=env, cwd=cwd))
        if " --version" in command:
            return FakeExecResult(return_code=0, stdout="1.4.2\n")
        return FakeExecResult(return_code=self.exit_code, stdout="", stderr="")

    def agent_process_env(self, env):
        return env

    async def download_dir(self, source_dir, target_dir):
        if self.container_trace_dir is None or not Path(self.container_trace_dir).exists():
            raise FileNotFoundError(source_dir)
        target = Path(target_dir)
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(self.container_trace_dir, target)

    async def download_file(self, source_path, target_path):
        if self.container_ndjson is None or not Path(self.container_ndjson).exists():
            raise FileNotFoundError(source_path)
        shutil.copy(self.container_ndjson, target_path)


@pytest.fixture
def native_bundle(tmp_path: Path) -> Path:
    return build_native_bundle(tmp_path / "container-trace")


@pytest.fixture
def fake_env(tmp_path: Path, native_bundle: Path) -> FakeEnvironment:
    ndjson = tmp_path / "container-swain.ndjson"
    ndjson.write_text(RESULT_EVENT_NDJSON)
    return FakeEnvironment(container_trace_dir=native_bundle, container_ndjson=ndjson)
