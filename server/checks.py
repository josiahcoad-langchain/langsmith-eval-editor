"""Code checks: deterministic assertions about a run, next to the LLM-graded ones.

Some things a judge can't see in a transcript (how many tokens each model call sent) or shouldn't be trusted
to count (exactly how many times a tool ran). A test lists them in `outputs.checks`, one dict per check:

    {"name": "no-refund", "type": "must_not_call", "tools": ["issue_refund"]}

Types (params after the type):
    must_call              tools: [name | [any, of, these]]    every entry was called at least once
    must_not_call          tools: [name]                       none was called
    max_tool_calls         max, tool?                          total calls (or calls to `tool`) <= max
    max_tool_rounds        max                                 model calls that asked for tools <= max
    must_call_before       first, second                       if `second` ran, `first` ran before it
    must_call_with_values  tool, args: {arg: value}            some call to `tool` carried every value
    max_prompt_tokens      max                                 the largest single model call's input <= max
    max_model_calls        max                                 model calls in the run <= max
    custom                 anything                            graded by the hook's `custom_check`

Each check becomes a feedback key named after it, scored 1 or 0 with a one-line reason. An unknown type
scores None instead of passing: a typo must never read as a pass.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

CustomCheck = Callable[[dict, dict], tuple[bool, str]]


def run_checks(outputs: dict, checks: list[dict], custom: CustomCheck | None = None) -> list[dict]:
    return [_run_one(outputs, check, custom) for check in checks if check.get("name")]


def _run_one(outputs: dict, check: dict, custom: CustomCheck | None) -> dict:
    kind = check.get("type")
    if kind == "custom":
        if custom is None:
            return _result(check, None, "The agent's hook has no custom_check, so this check can't run.")
        passed, reason = custom(outputs, check)
        return _result(check, passed, reason)
    grader = _GRADERS.get(kind)
    if grader is None:
        return _result(check, None, f"Unknown check type {kind!r}.")
    passed, reason = grader(outputs, check)
    return _result(check, passed, reason)


def _result(check: dict, passed: bool | None, reason: str) -> dict:
    return {"key": check["name"], "score": None if passed is None else int(passed), "comment": reason}


def _called(outputs: dict) -> list[str]:
    return [call["name"] for call in outputs.get("tool_calls") or []]


def _must_call(outputs: dict, check: dict) -> tuple[bool, str]:
    called = set(_called(outputs))
    missing = [entry for entry in check.get("tools") or []
               if not called & set(entry if isinstance(entry, list) else [entry])]
    return not missing, f"Never called: {missing}" if missing else "Every required tool was called."


def _must_not_call(outputs: dict, check: dict) -> tuple[bool, str]:
    banned = sorted(set(_called(outputs)) & set(check.get("tools") or []))
    return not banned, f"Called: {banned}" if banned else "No banned tool was called."


def _max_tool_calls(outputs: dict, check: dict) -> tuple[bool, str]:
    tool = check.get("tool")
    count = sum(1 for name in _called(outputs) if tool is None or name == tool)
    label = f"{tool} calls" if tool else "Tool calls"
    return count <= check["max"], f"{label}: {count} (max {check['max']})."


def _max_tool_rounds(outputs: dict, check: dict) -> tuple[bool, str]:
    rounds = sum(1 for call in outputs.get("model_calls") or [] if call.get("tool_calls"))
    return rounds <= check["max"], f"Tool rounds: {rounds} (max {check['max']})."


def _must_call_before(outputs: dict, check: dict) -> tuple[bool, str]:
    called = _called(outputs)
    first, second = check["first"], check["second"]
    if second not in called:
        return True, f"{second} never ran, so the order doesn't apply."
    ok = first in called[: called.index(second)]
    return ok, f"{first} ran before {second}." if ok else f"{second} ran without {first} before it."


def _must_call_with_values(outputs: dict, check: dict) -> tuple[bool, str]:
    want = check.get("args") or {}
    calls = [c for c in outputs.get("tool_calls") or [] if c["name"] == check["tool"]]
    ok = any(all(c["args"].get(arg) == value for arg, value in want.items()) for c in calls)
    seen = [c["args"] for c in calls]
    return ok, f"A {check['tool']} call carried {want}." if ok else f"No {check['tool']} call carried {want}; saw {seen}."


def _max_prompt_tokens(outputs: dict, check: dict) -> tuple[bool, str]:
    sizes = [call.get("input_tokens") or 0 for call in outputs.get("model_calls") or []]
    if not sizes:
        return False, "No model call reported token usage."
    largest = max(sizes)
    return largest <= check["max"], f"Largest model call sent {largest:,} tokens (max {check['max']:,})."


def _max_model_calls(outputs: dict, check: dict) -> tuple[bool, str]:
    count = len(outputs.get("model_calls") or [])
    return count <= check["max"], f"Model calls: {count} (max {check['max']})."


_GRADERS: dict[str, Callable[[dict, dict], tuple[bool, str]]] = {
    "must_call": _must_call,
    "must_not_call": _must_not_call,
    "max_tool_calls": _max_tool_calls,
    "max_tool_rounds": _max_tool_rounds,
    "must_call_before": _must_call_before,
    "must_call_with_values": _must_call_with_values,
    "max_prompt_tokens": _max_prompt_tokens,
    "max_model_calls": _max_model_calls,
}
