"""Native trace -> ATIF v1.7 conversion contract tests (all mapping rules)."""

from __future__ import annotations

import json

import pytest
from conftest import build_native_bundle, load_fixture

from harbor.models.trajectories import Trajectory as HarborTrajectory
from pier.models.trajectories import Trajectory as PierTrajectory

from evals.common import trajectory
from evals.common.trajectory import ConversionError, convert_bundle, convert_native

BOTH_MODELS = [HarborTrajectory, PierTrajectory]


@pytest.fixture
def root() -> dict:
    return convert_native(load_fixture("root-trace.json"))


@pytest.fixture
def child() -> dict:
    return convert_native(load_fixture("child-trace.json"))


def _steps_by_source(atif, source):
    return [s for s in atif["steps"] if s["source"] == source]


# Rule 1
def test_system_prompt_is_first_system_step(root):
    first = root["steps"][0]
    assert first["step_id"] == 1
    assert first["source"] == "system"
    assert "autonomous coding agent" in first["message"]


# Rule 2
def test_genuine_user_prompt_is_user_step(root):
    users = _steps_by_source(root, "user")
    assert len(users) == 1
    assert "failing test" in users[0]["message"]


def test_meta_user_message_is_system_with_flag(child):
    meta = [s for s in child["steps"] if s.get("extra", {}).get("swain_is_meta")]
    assert len(meta) == 1
    assert meta[0]["source"] == "system"


# Rule 3
def test_assistant_maps_to_agent_step_with_fidelity(root):
    agent_steps = _steps_by_source(root, "agent")
    first = agent_steps[0]
    assert first["message"] == "Let me explore the repository."
    assert "delegate exploration" in first["reasoning_content"]
    assert first["reasoning_effort"] == "high"
    assert first["timestamp"] == "2026-07-20T10:00:01.000Z"
    assert first["extra"]["swain_response_duration_ms"] == 1200
    assert first["extra"]["swain_turn_duration_ms"] == 1500
    assert first["tool_calls"][0]["function_name"] == "Agent"
    assert first["tool_calls"][0]["arguments"]["subagent_type"] == "Explore"


def test_metrics_from_usage_omit_cost_and_cache(root):
    first = _steps_by_source(root, "agent")[0]
    metrics = first["metrics"]
    assert metrics["prompt_tokens"] == 1000
    assert metrics["completion_tokens"] == 500
    assert "cached_tokens" not in metrics
    assert "cost_usd" not in metrics


# Rule 4
def test_tool_result_folded_into_preceding_agent_observation(root):
    agent_steps = _steps_by_source(root, "agent")
    bash_step = agent_steps[1]
    results = bash_step["observation"]["results"]
    assert results[0]["source_call_id"] == "tc-bash-1"
    assert "1 passed" in results[0]["content"]
    # No standalone user/system step was emitted for the tool result.
    assert all(s["source"] != "user" or "passed" not in s["message"] for s in root["steps"])


def test_no_disconnected_observation_source_call_ids(root):
    call_ids = {tc["tool_call_id"] for s in root["steps"] for tc in s.get("tool_calls") or []}
    for step in root["steps"]:
        for result in (step.get("observation") or {}).get("results", []):
            assert result["source_call_id"] in call_ids


# Rule 5
def test_agent_result_attaches_external_subagent_ref(root):
    agent_step = _steps_by_source(root, "agent")[0]
    ref = agent_step["observation"]["results"][0]["subagent_trajectory_ref"][0]
    assert ref["trajectory_path"] == "subagents/child-xyz789.json"
    assert ref["trajectory_id"] == "child-xyz789"


# Rule 6
def test_child_is_independently_valid_with_step_ids_from_one(child):
    assert child["steps"][0]["step_id"] == 1
    assert [s["step_id"] for s in child["steps"]] == [1, 2, 3, 4]
    assert child["trajectory_id"] == "child-xyz789"
    # Children are linked by ref, never embedded in the parent.
    assert child.get("subagent_trajectories") is None


def test_root_does_not_embed_children(root):
    assert root.get("subagent_trajectories") is None


# Rule 7
def test_final_metrics_are_local_per_file(root, child):
    assert root["final_metrics"]["total_prompt_tokens"] == 1700
    assert root["final_metrics"]["total_completion_tokens"] == 860
    assert root["final_metrics"]["total_steps"] == 5
    assert child["final_metrics"]["total_prompt_tokens"] == 700
    assert child["final_metrics"]["total_completion_tokens"] == 310


def test_bundle_totals_are_inclusive(tmp_path):
    bundle = build_native_bundle(tmp_path / "b")
    result = convert_bundle(bundle)
    assert result.total_input_tokens == 2400  # 1700 + 700
    assert result.total_output_tokens == 1170  # 860 + 310


# Rule 8
def test_cost_and_cache_absent_everywhere(root, child):
    for atif in (root, child):
        assert "total_cost_usd" not in atif["final_metrics"]
        assert "total_cached_tokens" not in atif["final_metrics"]


# Rule 9
@pytest.mark.parametrize("model", BOTH_MODELS)
def test_root_and_child_validate_under_both_frameworks(model, root, child):
    model.model_validate(root)
    model.model_validate(child)


@pytest.mark.parametrize("model", BOTH_MODELS)
def test_convert_bundle_validates_with_framework_model(model, tmp_path):
    bundle = build_native_bundle(tmp_path / "b")
    result = convert_bundle(bundle, trajectory_model=model)
    assert result.root["schema_version"] == "ATIF-v1.7"
    assert set(result.children) == {"subagents/child-xyz789.json"}


def test_missing_referenced_child_is_conversion_failure(tmp_path):
    # Root references child-xyz789 but no child file exists on disk.
    bundle = build_native_bundle(tmp_path / "b", include_child=False)
    with pytest.raises(ConversionError):
        convert_bundle(bundle)


# Outcomes
@pytest.mark.parametrize(
    "outcome",
    [
        {"status": "failed", "error": "provider 500"},
        {"status": "interrupted", "signal": "SIGTERM"},
    ],
)
@pytest.mark.parametrize("model", BOTH_MODELS)
def test_failed_and_interrupted_outcomes_survive(outcome, model):
    native = load_fixture("root-trace.json")
    native["outcome"] = outcome
    atif = convert_native(native)
    model.model_validate(atif)
    assert atif["extra"]["swain_outcome"] == outcome


def test_tool_result_without_agent_step_raises():
    native = load_fixture("root-trace.json")
    native["messages"] = [native["messages"][2]]  # a lone tool-result user message
    with pytest.raises(ConversionError):
        convert_native(native)


@pytest.mark.parametrize("evil", ["../escape.json", "/etc/passwd", "subagents/../../x.json"])
def test_manifest_path_traversal_is_rejected(tmp_path, evil):
    bundle = build_native_bundle(tmp_path / "b", include_child=False)
    manifest = json.loads((bundle / "manifest.json").read_text())
    manifest["children"] = [{"agentId": "x", "taskId": "t", "file": evil}]
    (bundle / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(ConversionError):
        convert_bundle(bundle)


def test_tool_result_message_with_text_raises():
    native = load_fixture("root-trace.json")
    tool_result_msg = dict(native["messages"][2])
    tool_result_msg["content"] = [*tool_result_msg["content"], {"type": "text", "text": "leak"}]
    native["messages"][2] = tool_result_msg
    with pytest.raises(ConversionError):
        convert_native(native)


def test_ndjson_result_event_detection():
    assert trajectory.ndjson_has_result_event('{"type":"result"}\n')
    assert not trajectory.ndjson_has_result_event('{"type":"assistant"}\nnot json\n')


def test_serialized_bundle_round_trips(tmp_path):
    bundle = build_native_bundle(tmp_path / "b")
    result = convert_bundle(bundle, trajectory_model=HarborTrajectory)
    out = tmp_path / "out"
    trajectory.write_bundle(result, out)
    written = json.loads((out / "trajectory.json").read_text())
    assert written["trajectory_id"] == "root-abc123"
    assert (out / "subagents" / "child-xyz789.json").is_file()
