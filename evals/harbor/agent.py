"""Harbor installed-agent wrapper that runs an exact Swain release.

Installs a checksummed Swain release into a Terminal-Bench task container, runs
``swain exec`` with routing off, and converts the native trace bundle into ATIF
v1.7, publishing inclusive (root + children) token totals. Harbor-specific code
is limited to install/run/post-run and context assignment; artifact, model, and
trajectory logic is reused from ``evals.common``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Trajectory

from evals.common import artifacts, models, redaction
from evals.common.trajectory import (
    ConversionError,
    convert_and_write_bundle,
    ndjson_has_result_event,
)

# Custom endpoint kwargs are rejected: v1 supports only official API endpoints.
_FORBIDDEN_KWARGS = frozenset({"base_url", "api_base", "gateway_url", "endpoint"})


class SwainHarborAgent(BaseInstalledAgent):
    """Run Swain as a Harbor custom installed agent (Terminal-Bench 2)."""

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
            raise ValueError("SwainHarborAgent requires an exact Swain 'version'.")
        if not model_name:
            raise ValueError("SwainHarborAgent requires 'model_name'.")
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

    def get_version_command(self) -> str | None:
        return f"{artifacts.swain_bin(self._version)} --version"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(environment, artifacts.install_script(self._version))
        await self.exec_as_root(environment, f"{artifacts.swain_bin(self._version)} --version")
        await self.exec_as_root(environment, f"{artifacts.rg_bin(self._version)} --version")

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
            # The provider key is delivered by Harbor's trial-scoped agent env;
            # never pass it in `env=` where base-class debug logging could serialize it.
            await self.exec_as_agent(environment, command, env=None)
        finally:
            await self._download_artifacts(environment)

    def populate_context_post_run(self, context: AgentContext) -> None:
        agent_dir = self.logs_dir / "agent"
        ndjson = agent_dir / "swain.ndjson"
        if ndjson.is_file() and not ndjson_has_result_event(ndjson.read_text()):
            raise ConversionError("Swain NDJSON has no terminal result event.")
        secrets = [v for v in self.extra_env.values() if v]
        result = convert_and_write_bundle(agent_dir / "swain", agent_dir, Trajectory, secrets)
        context.n_input_tokens = result.total_input_tokens
        context.n_output_tokens = result.total_output_tokens

    async def _download_artifacts(self, environment: BaseEnvironment) -> None:
        agent_dir = self.logs_dir / "agent"
        agent_dir.mkdir(parents=True, exist_ok=True)
        try:
            await environment.download_dir(models.SWAIN_TRACE_DIR, agent_dir / "swain")
        except Exception:
            pass  # Missing trace is classified later by the converter.
        try:
            await environment.download_file(models.SWAIN_NDJSON, agent_dir / "swain.ndjson")
        except Exception:
            return
        self._redact_ndjson(agent_dir / "swain.ndjson")

    def _redact_ndjson(self, path: Path) -> None:
        secrets = [v for v in self.extra_env.values() if v]
        if secrets and path.is_file():
            path.write_text(redaction.redact_text(path.read_text(), secrets))
