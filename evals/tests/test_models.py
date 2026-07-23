"""Provider/model mapping and secret-selection contract tests."""

from __future__ import annotations

import shlex

import pytest

from evals.common import models
from evals.common.models import ModelError

EXPECTED_TABLE = {
    "anthropic": ("ANTHROPIC_API_KEY", "api.anthropic.com"),
    "openai": ("OPENAI_API_KEY", "api.openai.com"),
    "kimi": ("MOONSHOT_API_KEY", "api.moonshot.ai"),
    "deepseek": ("DEEPSEEK_API_KEY", "api.deepseek.com"),
    "zai": ("ZAI_API_KEY", "api.z.ai"),
}


def test_provider_table_is_exact():
    actual = {name: (p.credential_env, p.domain) for name, p in models.PROVIDERS.items()}
    assert actual == EXPECTED_TABLE


def test_resolve_model_maps_provider_and_model():
    sel = models.resolve_model("anthropic/claude-opus-4")
    assert sel.provider.name == "anthropic"
    assert sel.model == "claude-opus-4"
    assert sel.variant is None
    assert sel.swain_model_ref == "anthropic:claude-opus-4"
    assert sel.credential_env == "ANTHROPIC_API_KEY"
    assert sel.domain == "api.anthropic.com"


def test_resolve_model_maps_variant():
    sel = models.resolve_model("openai/gpt-5", variant="high")
    assert sel.swain_model_ref == "openai:gpt-5:high"


@pytest.mark.parametrize("bad", ["claude-opus-4", "", "/model", "anthropic/", "anthropic"])
def test_resolve_model_rejects_malformed(bad):
    with pytest.raises(ModelError):
        models.resolve_model(bad)


def test_resolve_model_rejects_openai_codex():
    with pytest.raises(ModelError):
        models.resolve_model("openai-codex/gpt-5")


def test_resolve_model_rejects_unknown_provider():
    with pytest.raises(ModelError):
        models.resolve_model("mistral/large")


def test_select_agent_env_returns_only_selected_key():
    sel = models.resolve_model("anthropic/claude-opus-4")
    environ = {
        "ANTHROPIC_API_KEY": "sk-ant-abc123456789",
        "OPENAI_API_KEY": "sk-openai-should-not-leak",
        "PATH": "/usr/bin",
    }
    assert models.select_agent_env(sel, environ) == {"ANTHROPIC_API_KEY": "sk-ant-abc123456789"}


def test_select_agent_env_rejects_missing_credential():
    sel = models.resolve_model("deepseek/deepseek-chat")
    with pytest.raises(ModelError):
        models.select_agent_env(sel, {"OPENAI_API_KEY": "x"})


@pytest.mark.parametrize(
    "override",
    ["ANTHROPIC_BASE_URL", "OPENAI_API_BASE", "SWAIN_GATEWAY_URL"],
)
def test_select_agent_env_rejects_base_url_overrides(override):
    sel = models.resolve_model("anthropic/claude-opus-4")
    environ = {"ANTHROPIC_API_KEY": "sk-ant-abc123456789", override: "https://gateway.example"}
    with pytest.raises(ModelError):
        models.select_agent_env(sel, environ)


def test_swain_exec_command_structure_and_quoting():
    sel = models.resolve_model("anthropic/claude-opus-4", variant="high")
    instruction = 'Fix the "weird" bug; rm -rf / && echo done'
    command = models.swain_exec_command("/opt/swain/v1.4.2/bin/swain", sel, instruction)

    assert "swain exec" in command
    assert "--permission-mode auto" in command
    assert "--model anthropic:claude-opus-4:high" in command
    assert "--output-format stream-json" in command
    assert f"--trace-dir {models.SWAIN_TRACE_DIR}" in command
    # Stdout is redirected (not piped) so a non-zero Swain exit is not masked.
    assert f"> {models.SWAIN_NDJSON}" in command
    assert "| tee" not in command

    # The instruction survives shell parsing byte-for-byte as a single argument.
    tokens = shlex.split(command.split(f"> {models.SWAIN_NDJSON}")[0])
    assert instruction in tokens


def test_swain_exec_command_quotes_hostile_model_ref(monkeypatch):
    sel = models.resolve_model("anthropic/claude-opus-4")
    monkeypatch.setattr(type(sel), "swain_model_ref", "anthropic:x; rm -rf /")
    command = models.swain_exec_command("/opt/swain/v1.4.2/bin/swain", sel, "task")

    tokens = shlex.split(command.split(f"> {models.SWAIN_NDJSON}")[0])
    # The whole ref is one argument; the injected command never becomes its own token.
    assert "anthropic:x; rm -rf /" in tokens
    assert "rm" not in tokens
