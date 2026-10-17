"""What a grader sees of one run: the Given it started from and what the agent did, fitted under a size limit.

Built and fitted here, once, for every grader (the default judge, a hook's own grader, the Re-grade check), so no
grader has to cut it down itself. Cutting the JSON text at a character limit was the old way, and it silently
dropped whatever came last. On a 12-post bulk edit that was the update's result, and a judge failed a correct
reply because the evidence "shows no update results to verify".

Fitting instead caps the LONGEST strings, a little more each pass, until the whole thing fits. Every field, every
tool call and every short value survives; only bulky text (a long caption list, a scraped page) is trimmed, and it
says so where it was trimmed.
"""

from __future__ import annotations

import json
from typing import Any

# How many earlier turns of the conversation a grader sees: enough to read an instruction from the turn before,
# not so many that a long thread crowds the run itself out.
GIVEN_HISTORY_TURNS = 6


def build_evidence(inputs: dict, outputs: dict, limit: int) -> dict[str, Any]:
    given: dict[str, Any] = {"context": inputs.get("context") or {}}
    if inputs.get("history"):
        given["history_tail"] = inputs["history"][-GIVEN_HISTORY_TURNS:]
    evidence = {"given": given, **{key: outputs.get(key) for key in ("answer", "tool_calls", "transcript")}}
    return fit_evidence(evidence, limit)


def fit_evidence(evidence: dict[str, Any], limit: int) -> dict[str, Any]:
    if _size(evidence) <= limit:
        return evidence
    cap = max(len(s) for s in _strings(evidence))
    while cap > 40:
        cap = int(cap * 0.7)
        fitted = _cap_strings(evidence, cap)
        if _size(fitted) <= limit:
            return fitted
    return _cap_strings(evidence, 40)


def _size(value: Any) -> int:
    return len(json.dumps(value, default=str))


def _strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [s for item in value.values() for s in _strings(item)]
    if isinstance(value, list):
        return [s for item in value for s in _strings(item)]
    return [""]


def _cap_strings(value: Any, cap: int) -> Any:
    if isinstance(value, str) and len(value) > cap:
        keep = cap // 2
        return f"{value[:keep]} […{len(value) - 2 * keep} chars trimmed…] {value[-keep:]}"
    if isinstance(value, dict):
        return {key: _cap_strings(item, cap) for key, item in value.items()}
    if isinstance(value, list):
        return [_cap_strings(item, cap) for item in value]
    return value
