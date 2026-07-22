"""Provider/model mapping and selected-provider secret selection.

One immutable table maps a Harbor/Pier ``<provider>/<model>`` reference to the
credential env var and official runtime domain. Both wrappers import from here so
endpoint facts are never duplicated. Routing is off: the single resolved model is
used by the parent Swain session and every subagent.
"""

from __future__ import annotations

import shlex
from collections.abc import Mapping
from dataclasses import dataclass

# Native trace bundle written by `swain exec --trace-dir` and the NDJSON capture.
SWAIN_TRACE_DIR = "/logs/agent/swain"
SWAIN_NDJSON = "/logs/agent/swain.ndjson"


class ModelError(ValueError):
    """Raised for an unsupported model reference, provider, or credential state."""


@dataclass(frozen=True)
class Provider:
    """A supported official-API provider and its immutable endpoint facts."""

    name: str
    credential_env: str
    domain: str


# Exact, immutable provider table (spec 0012 "Initial provider support").
PROVIDERS: dict[str, Provider] = {
    "anthropic": Provider("anthropic", "ANTHROPIC_API_KEY", "api.anthropic.com"),
    "openai": Provider("openai", "OPENAI_API_KEY", "api.openai.com"),
    "kimi": Provider("kimi", "MOONSHOT_API_KEY", "api.moonshot.ai"),
    "deepseek": Provider("deepseek", "DEEPSEEK_API_KEY", "api.deepseek.com"),
    "zai": Provider("zai", "ZAI_API_KEY", "api.z.ai"),
}

# Explicitly rejected provider prefixes (OAuth/gateway paths deferred to a
# follow-on spec). Kept separate from "unknown" so the error is specific.
REJECTED_PROVIDERS: frozenset[str] = frozenset({"openai-codex"})

# Custom base-URL / gateway overrides. If any is present for the selected
# provider the run is rejected: v1 supports only the official API endpoint.
BASE_URL_ENV_VARS: frozenset[str] = frozenset(
    {
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_API_URL",
        "OPENAI_BASE_URL",
        "OPENAI_API_BASE",
        "MOONSHOT_BASE_URL",
        "MOONSHOT_API_BASE",
        "DEEPSEEK_BASE_URL",
        "DEEPSEEK_API_BASE",
        "ZAI_BASE_URL",
        "ZAI_API_BASE",
        "SWAIN_BASE_URL",
        "SWAIN_GATEWAY_URL",
    }
)


@dataclass(frozen=True)
class ModelSelection:
    """A resolved, supported model target."""

    provider: Provider
    model: str
    variant: str | None

    @property
    def credential_env(self) -> str:
        return self.provider.credential_env

    @property
    def domain(self) -> str:
        return self.provider.domain

    @property
    def swain_model_ref(self) -> str:
        """The ``provider:model[:variant]`` ref for ``swain exec --model``."""
        base = f"{self.provider.name}:{self.model}"
        return f"{base}:{self.variant}" if self.variant else base


def resolve_model(model_name: str, variant: str | None = None) -> ModelSelection:
    """Resolve a ``<provider>/<model>`` reference against the supported table.

    Rejects custom gateways, ``openai-codex``, unknown providers, and malformed
    references before any model execution.
    """
    if not model_name or "/" not in model_name:
        raise ModelError(
            f"Model must be '<provider>/<model>', got {model_name!r}. "
            "Custom base URLs, gateways, and bare model ids are rejected."
        )
    provider_name, model = model_name.split("/", maxsplit=1)
    if not provider_name or not model:
        raise ModelError(f"Model must be '<provider>/<model>', got {model_name!r}.")
    if provider_name in REJECTED_PROVIDERS:
        raise ModelError(
            f"Provider {provider_name!r} is rejected in v1 "
            "(OAuth/Codex needs coordinated refresh-token rotation)."
        )
    provider = PROVIDERS.get(provider_name)
    if provider is None:
        supported = ", ".join(sorted(PROVIDERS))
        raise ModelError(f"Unknown provider {provider_name!r}. Supported: {supported}.")
    variant = variant or None
    return ModelSelection(provider=provider, model=model, variant=variant)


def select_agent_env(selection: ModelSelection, environ: Mapping[str, str]) -> dict[str, str]:
    """Return exactly the selected provider's credential for the scoped agent env.

    Other providers' keys present in ``environ`` are never forwarded. Missing
    credentials and custom base-URL overrides are rejected here, before the
    model runs.
    """
    present_overrides = sorted(k for k in BASE_URL_ENV_VARS if environ.get(k))
    if present_overrides:
        raise ModelError(
            "Custom base URL / gateway overrides are not supported: " + ", ".join(present_overrides)
        )
    value = environ.get(selection.credential_env)
    if not value:
        raise ModelError(
            f"Missing credential {selection.credential_env} for provider "
            f"{selection.provider.name!r}."
        )
    return {selection.credential_env: value}


def swain_exec_command(swain_bin: str, selection: ModelSelection, instruction: str) -> str:
    """Build the byte-preserving `swain exec` command for a benchmark instruction.

    Routing is off (one fixed model); the instruction is shell-quoted so it
    survives byte-for-byte, and NDJSON is captured via ``tee`` while the process
    exit code is preserved by ``pipefail`` in the framework exec wrapper.
    """
    return (
        f"{swain_bin} exec"
        " --permission-mode auto"
        f" --model {selection.swain_model_ref}"
        " --output-format stream-json"
        f" --trace-dir {SWAIN_TRACE_DIR}"
        f" {shlex.quote(instruction)}"
        f" | tee {SWAIN_NDJSON}"
    )
