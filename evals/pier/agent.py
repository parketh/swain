"""Pier installed-agent wrapper that runs an exact Swain release.

Runs the same Swain contract as the Harbor wrapper under DeepSWE's
network-isolated Pier environment: the release is installed during the build
phase (before runtime network restriction), and only the selected provider's
official domain is allowlisted at runtime. Shares artifact/model/trajectory
logic with ``evals.common``; the Harbor wrapper is never imported here.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pier.agents.installed.base import BaseInstalledAgent
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pier.models.agent.network import NetworkAllowlist
from pier.models.trajectories import Trajectory

from evals.common import artifacts, models, redaction
from evals.common.trajectory import (
    ConversionError,
    convert_and_write_bundle,
    ndjson_has_result_event,
)

_FORBIDDEN_KWARGS = frozenset({"base_url", "api_base", "gateway_url", "endpoint"})


class SwainPierAgent(BaseInstalledAgent):
    """Run Swain as a Pier custom installed agent (DeepSWE)."""

    SUPPORTS_ATIF = True

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        version: str | None = None,
        variant: str | None = None,
        prompt_template_path: Path | str | None = None,
        extra_env: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> None:
        forbidden = _FORBIDDEN_KWARGS & set(kwargs)
        if forbidden:
            raise ValueError(f"Custom endpoint kwargs are not supported: {sorted(forbidden)}")
        if not version:
            raise ValueError("SwainPierAgent requires an exact Swain 'version'.")
        if not model_name:
            raise ValueError("SwainPierAgent requires 'model_name'.")
        artifacts.validate_version(version)
        self._selection = models.resolve_model(model_name, variant)
        self._variant = variant
        super().__init__(
            logs_dir,
            prompt_template_path=prompt_template_path,
            version=version,
            extra_env=extra_env,
            model_name=model_name,
            **kwargs,
        )

    @staticmethod
    def name() -> str:
        return "swain"

    def install_spec(self) -> AgentInstallSpec:
        swain = artifacts.swain_bin(self._version)
        rg = artifacts.rg_bin(self._version)
        return AgentInstallSpec(
            agent_name=self.name(),
            version=self._version,
            steps=[InstallStep(run=artifacts.install_script(self._version), user="root")],
            verification_command=f"{swain} --version && {rg} --version",
            metadata={
                "swain_version": self._version,
                "install_dir": artifacts.install_dir(self._version),
            },
        )

    def network_allowlist(self) -> NetworkAllowlist:
        # Exactly the selected provider's official domain: no registry, GitHub,
        # wildcard, gateway, or general internet access at runtime.
        return NetworkAllowlist(domains=[self._selection.domain])

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        command = models.swain_exec_command(
            artifacts.swain_bin(self._version),
            self._selection,
            self.render_instruction(instruction),
        )
        try:
            await self.exec_as_agent(environment, command, env=None)
        finally:
            await self._download_artifacts(environment)

    def populate_context_post_run(self, context: AgentContext) -> None:
        agent_dir = self.logs_dir / "agent"
        ndjson = agent_dir / "swain.ndjson"
        if ndjson.is_file() and not ndjson_has_result_event(ndjson.read_text()):
            raise ConversionError("Swain NDJSON has no terminal result event.")
        secrets = [v for v in self._extra_env.values() if v]
        result = convert_and_write_bundle(agent_dir / "swain", agent_dir, Trajectory, secrets)
        context.n_input_tokens = result.total_input_tokens
        context.n_output_tokens = result.total_output_tokens

    async def _download_artifacts(self, environment: BaseEnvironment) -> None:
        agent_dir = self.logs_dir / "agent"
        agent_dir.mkdir(parents=True, exist_ok=True)
        try:
            await environment.download_dir(models.SWAIN_TRACE_DIR, agent_dir / "swain")
        except Exception:
            pass
        try:
            await environment.download_file(models.SWAIN_NDJSON, agent_dir / "swain.ndjson")
        except Exception:
            return
        self._redact_ndjson(agent_dir / "swain.ndjson")

    def _redact_ndjson(self, path: Path) -> None:
        secrets = [v for v in self._extra_env.values() if v]
        if secrets and path.is_file():
            path.write_text(redaction.redact_text(path.read_text(), secrets))
