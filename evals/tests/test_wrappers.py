"""Harbor and Pier installed-agent wrapper contract tests (fake environments)."""

from __future__ import annotations

import asyncio
import shlex

import pytest
from conftest import FakeEnvironment, build_native_bundle

from harbor.agents.installed.base import BaseInstalledAgent as HarborBase
from harbor.models.agent.context import AgentContext as HarborContext
from pier.agents.installed.base import BaseInstalledAgent as PierBase
from pier.models.agent.context import AgentContext as PierContext

from evals.harbor.agent import SwainHarborAgent
from evals.pier.agent import SwainPierAgent

SECRET = "sk-ant-supersecretkey-0123456789"
VERSION = "1.4.2"
MODEL = "anthropic/claude-opus-4"


def make_harbor(tmp_path, **kw):
    kw.setdefault("model_name", MODEL)
    kw.setdefault("version", VERSION)
    kw.setdefault("extra_env", {"ANTHROPIC_API_KEY": SECRET})
    return SwainHarborAgent(logs_dir=tmp_path / "logs", **kw)


def make_pier(tmp_path, **kw):
    kw.setdefault("model_name", MODEL)
    kw.setdefault("version", VERSION)
    kw.setdefault("extra_env", {"ANTHROPIC_API_KEY": SECRET})
    return SwainPierAgent(logs_dir=tmp_path / "logs", **kw)


# --------------------------------------------------------------------------- #
# Harbor
# --------------------------------------------------------------------------- #
class TestHarborConstruction:
    def test_inherits_base_and_supports_atif(self, tmp_path):
        agent = make_harbor(tmp_path)
        assert isinstance(agent, HarborBase)
        assert agent.SUPPORTS_ATIF is True
        assert SwainHarborAgent.name() == "swain"
        assert agent.version() == VERSION

    def test_requires_version(self, tmp_path):
        with pytest.raises(ValueError):
            make_harbor(tmp_path, version=None)

    def test_requires_model_name(self, tmp_path):
        with pytest.raises(ValueError):
            make_harbor(tmp_path, model_name=None)

    def test_rejects_custom_endpoint_kwargs(self, tmp_path):
        with pytest.raises(ValueError):
            make_harbor(tmp_path, base_url="https://gateway.example")

    def test_rejects_unsupported_model(self, tmp_path):
        with pytest.raises(ValueError):
            make_harbor(tmp_path, model_name="mistral/large")


class TestHarborInstall:
    def test_installs_and_verifies_swain_and_rg(self, tmp_path, fake_env):
        agent = make_harbor(tmp_path)
        asyncio.run(agent.install(fake_env))
        commands = [c.command for c in fake_env.calls]
        assert any("/opt/swain/v1.4.2" in c and "sha256" in c for c in commands)
        assert any("/opt/swain/v1.4.2/bin/swain --version" in c for c in commands)
        assert any("/opt/swain/v1.4.2/libexec/rg --version" in c for c in commands)
        assert all(c.user == "root" for c in fake_env.calls)


class TestHarborRun:
    def test_runs_swain_exec_with_expected_contract(self, tmp_path, fake_env):
        agent = make_harbor(tmp_path)
        instruction = 'Fix the "flaky" test; do not rm -rf /'
        asyncio.run(agent.run(instruction, fake_env, HarborContext()))
        exec_call = next(c for c in fake_env.calls if "swain exec" in c.command)
        assert "--permission-mode auto" in exec_call.command
        assert "--model anthropic:claude-opus-4" in exec_call.command
        assert "--output-format stream-json" in exec_call.command
        assert "--trace-dir /logs/agent/swain" in exec_call.command
        assert instruction in shlex.split(exec_call.command.split("| tee")[0])

    def test_secret_absent_from_command_and_per_call_env(self, tmp_path, fake_env):
        agent = make_harbor(tmp_path)
        asyncio.run(agent.run("Do it.", fake_env, HarborContext()))
        exec_call = next(c for c in fake_env.calls if "swain exec" in c.command)
        assert SECRET not in exec_call.command
        assert exec_call.env is None  # key arrives via trial-scoped agent env only
        assert agent.extra_env == {"ANTHROPIC_API_KEY": SECRET}

    def test_captured_ndjson_is_redacted(self, tmp_path, fake_env):
        fake_env.container_ndjson.write_text(
            '{"type":"result"}\n{"type":"tool","secret":"' + SECRET + '"}\n'
        )
        agent = make_harbor(tmp_path)
        asyncio.run(agent.run("Do it.", fake_env, HarborContext()))
        captured = (tmp_path / "logs" / "agent" / "swain.ndjson").read_text()
        assert SECRET not in captured
        assert "[REDACTED]" in captured

    def test_non_zero_exit_fails(self, tmp_path, fake_env):
        fake_env.exit_code = 1
        agent = make_harbor(tmp_path)
        with pytest.raises(Exception):
            asyncio.run(agent.run("Do it.", fake_env, HarborContext()))


class TestHarborPostRun:
    def test_converts_and_sets_inclusive_tokens(self, tmp_path, fake_env):
        agent = make_harbor(tmp_path)
        context = HarborContext()
        asyncio.run(agent.run("Do it.", fake_env, context))
        agent.populate_context_post_run(context)
        agent_dir = tmp_path / "logs" / "agent"
        assert (agent_dir / "trajectory.json").is_file()
        assert (agent_dir / "subagents" / "child-xyz789.json").is_file()
        assert context.n_input_tokens == 2400
        assert context.n_output_tokens == 1170
        assert context.cost_usd is None

    def test_missing_result_event_fails(self, tmp_path, fake_env):
        fake_env.container_ndjson.write_text('{"type":"assistant"}\n')
        agent = make_harbor(tmp_path)
        context = HarborContext()
        asyncio.run(agent.run("Do it.", fake_env, context))
        with pytest.raises(Exception):
            agent.populate_context_post_run(context)

    def test_missing_trace_fails(self, tmp_path):
        env = FakeEnvironment(container_trace_dir=None, container_ndjson=None)
        agent = make_harbor(tmp_path)
        context = HarborContext()
        asyncio.run(agent.run("Do it.", env, context))
        with pytest.raises(Exception):
            agent.populate_context_post_run(context)

    def test_broken_child_reference_fails(self, tmp_path):
        broken = build_native_bundle(tmp_path / "broken", include_child=False)
        ndjson = tmp_path / "nd.ndjson"
        ndjson.write_text('{"type":"result"}\n')
        env = FakeEnvironment(container_trace_dir=broken, container_ndjson=ndjson)
        agent = make_harbor(tmp_path)
        context = HarborContext()
        asyncio.run(agent.run("Do it.", env, context))
        with pytest.raises(Exception):
            agent.populate_context_post_run(context)


# --------------------------------------------------------------------------- #
# Pier
# --------------------------------------------------------------------------- #
class TestPierConstruction:
    def test_inherits_base_and_public_behavior(self, tmp_path):
        agent = make_pier(tmp_path)
        assert isinstance(agent, PierBase)
        assert agent.SUPPORTS_ATIF is True
        assert SwainPierAgent.name() == "swain"
        assert agent.version() == VERSION

    def test_same_kwarg_and_model_rejections_as_harbor(self, tmp_path):
        with pytest.raises(ValueError):
            make_pier(tmp_path, version=None)
        with pytest.raises(ValueError):
            make_pier(tmp_path, model_name="mistral/large")
        with pytest.raises(ValueError):
            make_pier(tmp_path, base_url="https://gateway.example")


class TestPierInstallSpec:
    def test_install_spec_installs_and_verifies(self, tmp_path):
        spec = make_pier(tmp_path).install_spec()
        assert spec.agent_name == "swain"
        assert spec.version == VERSION
        assert spec.steps[0].user == "root"
        assert "sha256" in spec.steps[0].run
        assert "/opt/swain/v1.4.2/bin/swain --version" in spec.verification_command

    def test_fingerprint_changes_with_version(self, tmp_path):
        a = make_pier(tmp_path, version="1.4.2").install_spec().fingerprint()
        b = make_pier(tmp_path, version="1.4.3").install_spec().fingerprint()
        assert a != b


class TestPierNetworkAllowlist:
    def test_allowlist_is_exactly_selected_domain(self, tmp_path):
        allow = make_pier(tmp_path).network_allowlist()
        assert allow.domains == ["api.anthropic.com"]

    def test_provider_change_moves_key_and_domain_together(self, tmp_path):
        anthropic = make_pier(tmp_path, model_name="anthropic/claude-opus-4")
        openai = make_pier(tmp_path, model_name="openai/gpt-5")
        assert anthropic.network_allowlist().domains == ["api.anthropic.com"]
        assert openai.network_allowlist().domains == ["api.openai.com"]
        assert anthropic._selection.credential_env == "ANTHROPIC_API_KEY"
        assert openai._selection.credential_env == "OPENAI_API_KEY"


class TestPierRunAndPostRun:
    def test_run_and_convert_validate_with_pier_model(self, tmp_path, fake_env):
        agent = make_pier(tmp_path)
        context = PierContext()
        asyncio.run(agent.run("Do it.", fake_env, context))
        exec_call = next(c for c in fake_env.calls if "swain exec" in c.command)
        assert "--trace-dir /logs/agent/swain" in exec_call.command
        agent.populate_context_post_run(context)
        assert (tmp_path / "logs" / "agent" / "trajectory.json").is_file()
        assert context.n_input_tokens == 2400
        assert context.n_output_tokens == 1170
        assert context.cost_usd is None
