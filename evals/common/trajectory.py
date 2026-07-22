"""Native Swain trace bundle -> ATIF v1.7 conversion (plain dicts).

Builds plain dictionaries only; each framework wrapper supplies its own
``Trajectory`` Pydantic class for validation and serialization. Implements the
mapping rules in spec 0012 "ATIF mapping rules": one system step for the prompt,
user/meta steps, one agent step per assistant response, the following tool-result
message folded into that step's observation, subagent references by external
path, per-file local ``final_metrics``, and omitted cost/cache fields.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "ATIF-v1.7"
SUBAGENT_DIR = "subagents"
ROOT_OUTPUT = "trajectory.json"


class ConversionError(ValueError):
    """Raised when a native bundle cannot be converted into valid ATIF."""


def _model_name(model: dict[str, Any]) -> str:
    """Harbor/Pier ``<provider>/<model>`` notation from the native model ref."""
    return f"{model['provider']}/{model['modelId']}"


def _render_user_text(content: list[dict[str, Any]]) -> str:
    """Render non-tool-result user content (text / model-switch / compaction)."""
    parts: list[str] = []
    for item in content:
        kind = item.get("type")
        if kind == "text":
            parts.append(item.get("text", ""))
        elif kind == "model-switch":
            frm, to = item.get("from", {}), item.get("to", {})
            parts.append(
                f"[Model switched from {frm.get('provider')}:{frm.get('modelId')} "
                f"to {to.get('provider')}:{to.get('modelId')} — {item.get('reason', '')}]"
            )
        elif kind == "compaction":
            parts.append(
                f"[Conversation compacted: {item.get('compactedMessages', 0)} "
                f"earlier messages summarized.]\n{item.get('summary', '')}"
            )
    return "\n".join(parts)


def _tool_result_content(result: dict[str, Any]) -> str:
    if result.get("type") == "text":
        return str(result.get("value", ""))
    return json.dumps(result.get("value"), sort_keys=True)


def _observation_result(item: dict[str, Any]) -> dict[str, Any]:
    result = item.get("result", {})
    out: dict[str, Any] = {
        "source_call_id": item.get("toolCallId"),
        "content": _tool_result_content(result),
    }
    value = result.get("value")
    if result.get("type") == "json" and isinstance(value, dict) and "agentId" in value:
        agent_id = value["agentId"]
        out["subagent_trajectory_ref"] = [
            {
                "trajectory_id": agent_id,
                "trajectory_path": f"{SUBAGENT_DIR}/{agent_id}.json",
            }
        ]
    if item.get("isError"):
        out["extra"] = {"swain_is_error": True}
    return out


def _agent_step(
    step_id: int, message: dict[str, Any], model_name: str, variant: str | None
) -> dict[str, Any]:
    text_parts: list[str] = []
    reasoning_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    for item in message.get("content", []):
        kind = item.get("type")
        if kind == "text":
            text_parts.append(item.get("text", ""))
        elif kind == "reasoning":
            reasoning_parts.append(item.get("text", ""))
        elif kind == "tool-call":
            arguments = item.get("input")
            if not isinstance(arguments, dict):
                arguments = {"value": arguments}
            tool_calls.append(
                {
                    "tool_call_id": item.get("toolCallId"),
                    "function_name": item.get("name"),
                    "arguments": arguments,
                }
            )
    step: dict[str, Any] = {
        "step_id": step_id,
        "source": "agent",
        "message": "\n".join(text_parts),
        "model_name": model_name,
    }
    if reasoning_parts:
        step["reasoning_content"] = "\n".join(reasoning_parts)
    if tool_calls:
        step["tool_calls"] = tool_calls
    if variant:
        step["reasoning_effort"] = variant
    if message.get("createdAt"):
        step["timestamp"] = message["createdAt"]

    usage = message.get("usage")
    if usage:
        metrics: dict[str, Any] = {
            "prompt_tokens": usage.get("inputTokens"),
            "completion_tokens": usage.get("outputTokens"),
        }
        if usage.get("activeContextTokens") is not None:
            metrics["extra"] = {"swain_active_context_tokens": usage["activeContextTokens"]}
        step["metrics"] = metrics

    durations = {
        key: message[src]
        for key, src in (
            ("swain_response_duration_ms", "responseDurationMs"),
            ("swain_turn_duration_ms", "turnDurationMs"),
        )
        if message.get(src) is not None
    }
    if durations:
        step["extra"] = durations
    return step


def convert_native(native: dict[str, Any]) -> dict[str, Any]:
    """Convert one native trace file (root or child) into one ATIF trajectory dict."""
    model_name = _model_name(native["model"])
    variant = native["model"].get("variant")

    steps: list[dict[str, Any]] = [
        {
            "step_id": 1,
            "source": "system",
            "message": native.get("systemPrompt", ""),
        }
    ]
    step_id = 2
    last_agent_step: dict[str, Any] | None = None

    for message in native.get("messages", []):
        if message.get("role") == "assistant":
            step = _agent_step(step_id, message, model_name, variant)
            steps.append(step)
            last_agent_step = step
            step_id += 1
            continue

        content = message.get("content", [])
        tool_results = [c for c in content if c.get("type") == "tool-result"]
        if tool_results:
            if last_agent_step is None:
                raise ConversionError("tool-result message with no preceding agent step")
            observation = last_agent_step.setdefault("observation", {"results": []})
            observation["results"].extend(_observation_result(tr) for tr in tool_results)
            continue

        text = _render_user_text(content)
        if message.get("isMeta"):
            steps.append(
                {
                    "step_id": step_id,
                    "source": "system",
                    "message": text,
                    "extra": {"swain_is_meta": True},
                }
            )
        else:
            steps.append({"step_id": step_id, "source": "user", "message": text})
        step_id += 1

    prompt_tokens = sum(
        s.get("metrics", {}).get("prompt_tokens") or 0 for s in steps if s["source"] == "agent"
    )
    completion_tokens = sum(
        s.get("metrics", {}).get("completion_tokens") or 0 for s in steps if s["source"] == "agent"
    )

    extra: dict[str, Any] = {
        "swain_agent_type": native.get("agentType"),
        "swain_outcome": native.get("outcome"),
    }
    if native.get("taskId") is not None:
        extra["swain_task_id"] = native["taskId"]
    if native.get("parentAgentId") is not None:
        extra["swain_parent_agent_id"] = native["parentAgentId"]

    return {
        "schema_version": SCHEMA_VERSION,
        "session_id": native.get("sessionId"),
        "trajectory_id": native.get("agentId"),
        "agent": {
            "name": "swain",
            "version": native.get("swainVersion", "unknown"),
            "model_name": model_name,
        },
        "steps": steps,
        "final_metrics": {
            "total_prompt_tokens": prompt_tokens,
            "total_completion_tokens": completion_tokens,
            "total_steps": len(steps),
        },
        "extra": extra,
    }


def referenced_child_paths(atif: dict[str, Any]) -> set[str]:
    """All ``subagents/<id>.json`` paths referenced by observations in one trajectory."""
    paths: set[str] = set()
    for step in atif.get("steps", []):
        observation = step.get("observation")
        if not observation:
            continue
        for result in observation.get("results", []):
            for ref in result.get("subagent_trajectory_ref") or []:
                if ref.get("trajectory_path"):
                    paths.add(ref["trajectory_path"])
    return paths


def _token_totals(atif: dict[str, Any]) -> tuple[int, int]:
    fm = atif.get("final_metrics", {})
    return fm.get("total_prompt_tokens", 0), fm.get("total_completion_tokens", 0)


@dataclass
class BundleResult:
    """Converted bundle: the root trajectory plus each child, and inclusive totals."""

    root: dict[str, Any]
    children: dict[str, dict[str, Any]]
    total_input_tokens: int
    total_output_tokens: int


def _load_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError as exc:
        raise ConversionError(f"missing trace file: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ConversionError(f"invalid JSON in trace file {path}: {exc}") from exc


def convert_bundle(bundle_dir: Path, trajectory_model: Any = None) -> BundleResult:
    """Convert a native trace bundle on disk into validated ATIF trajectories.

    A referenced child file missing from disk is a conversion failure even if the
    generated path string would satisfy Pydantic. When ``trajectory_model`` is
    given (a framework ``Trajectory`` class), every generated dict is validated.
    """
    bundle_dir = Path(bundle_dir)
    manifest = _load_json(bundle_dir / "manifest.json")

    root_native = _load_json(bundle_dir / manifest.get("root", "root.json"))
    root_atif = convert_native(root_native)

    children: dict[str, dict[str, Any]] = {}
    for child in manifest.get("children", []):
        rel = child["file"]
        children[rel] = convert_native(_load_json(bundle_dir / rel))

    # Missing referenced child = failure, independent of what the manifest lists.
    for rel in referenced_child_paths(root_atif):
        if not (bundle_dir / rel).is_file():
            raise ConversionError(f"referenced child trace missing on disk: {rel}")

    if trajectory_model is not None:
        trajectory_model.model_validate(root_atif)
        for atif in children.values():
            trajectory_model.model_validate(atif)

    in_tokens, out_tokens = _token_totals(root_atif)
    for atif in children.values():
        c_in, c_out = _token_totals(atif)
        in_tokens += c_in
        out_tokens += c_out

    return BundleResult(
        root=root_atif,
        children=children,
        total_input_tokens=in_tokens,
        total_output_tokens=out_tokens,
    )


def convert_and_write_bundle(
    bundle_dir: Path, out_dir: Path, trajectory_model: Any
) -> BundleResult:
    """Convert (validating with ``trajectory_model``) and write a bundle."""
    result = convert_bundle(bundle_dir, trajectory_model)
    write_bundle(result, out_dir)
    return result


def ndjson_has_result_event(text: str) -> bool:
    """True if any NDJSON line is a terminal ``result`` event from `swain exec`."""
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict) and event.get("type") == "result":
            return True
    return False


def write_bundle(result: BundleResult, out_dir: Path) -> Path:
    """Write ``trajectory.json`` and ``subagents/<id>.json`` under ``out_dir``."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / SUBAGENT_DIR).mkdir(parents=True, exist_ok=True)
    root_path = out_dir / ROOT_OUTPUT
    root_path.write_text(json.dumps(result.root, indent=2) + "\n")
    for rel, atif in result.children.items():
        path = out_dir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(atif, indent=2) + "\n")
    return root_path
