"""Evidence for a grader is shrunk value by value, never cut off part-way.

Slicing the evidence's JSON text at a character limit dropped whatever came last. On a 12-post bulk edit that was
the update's result, and a judge failed a correct reply because the evidence "shows no update results to verify".
"""

import json

from evidence import build_evidence, fit_evidence


def test_large_evidence_keeps_every_field_and_the_last_result():
    # Given a run with a huge listing early on and the result that matters at the very end
    evidence = {
        "answer": "Updated all 12 scheduled captions.",
        "tool_calls": [
            {"name": "list_posts", "result": {"posts": [{"caption": "x" * 5000} for _ in range(12)]}},
            {"name": "update_posts", "result": {"changed": 12}},
        ],
    }

    # When it is fitted under a limit far smaller than it is
    fitted = fit_evidence(evidence, limit=8000)

    # Then it is under the limit, the answer is whole, and the final result survived intact
    assert len(json.dumps(fitted, default=str)) <= 8000
    assert fitted["answer"] == evidence["answer"]
    assert fitted["tool_calls"][1]["result"] == {"changed": 12}
    assert "[…" in fitted["tool_calls"][0]["result"]["posts"][0]["caption"]


def test_small_evidence_is_untouched():
    evidence = {"answer": "ok", "tool_calls": [{"name": "t", "result": "r"}]}
    assert fit_evidence(evidence, limit=8000) == evidence


def test_build_evidence_carries_the_given_and_the_run():
    inputs = {"context": {"tier": "gold"}, "history": [{"role": "user", "content": str(i)} for i in range(10)]}
    outputs = {"answer": "a", "tool_calls": [], "transcript": [], "model_calls": []}
    built = build_evidence(inputs, outputs, limit=60_000)
    assert built["given"]["context"] == {"tier": "gold"}
    assert len(built["given"]["history_tail"]) == 6
    assert set(built) == {"given", "answer", "tool_calls", "transcript"}
