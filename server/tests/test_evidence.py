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


def test_what_the_agent_wrote_survives_and_bulky_tool_results_are_trimmed_first():
    # Given a bulk edit: big read results (12 full posts, twice) and an update whose captions are what's graded
    post = {"id": "p", "caption": "Thank you for a wonderful season. " * 20}
    caption = "Thank you for a wonderful season. Book now.\n\n#LanternRow #FingerLakes #WineTourism #ThankYou"
    update = {"name": "update_posts", "args": {"items": [{"post_id": f"p{i}", "caption": caption} for i in range(12)]},
              "result": {"updated": 12}}
    # Different pages, so they can't be collapsed as repeats and something really has to be trimmed
    reads = [{"name": "list_posts", "args": {"page": n}, "result": {"items": [{**post, "id": f"p{n}-{i}"} for i in range(12)]}}
             for n in range(4)]
    transcript = [{"role": "tool", "content": json.dumps({"items": [post] * 12})} for _ in range(4)]
    outputs = {"answer": "Updated all 12.", "tool_calls": [*reads, update], "transcript": transcript}

    # When it's fitted under a limit the raw evidence is far over
    evidence = build_evidence({}, outputs, 20_000)

    # Then every caption the agent wrote is intact, and the trimming happened in the read results
    written = evidence["tool_calls"][-1]["args"]["items"]
    assert [item["caption"] for item in written] == [caption] * 12
    assert "trimmed" in json.dumps(evidence["tool_calls"][0]["result"])
    # and the transcript doesn't repeat what tool_calls already carries
    assert all("tool_calls" in row["content"] for row in evidence["transcript"])


def test_a_result_repeated_word_for_word_is_shown_once():
    same = {"items": [{"id": "p1", "caption": "x" * 500}]}
    outputs = {"answer": "ok", "transcript": [], "tool_calls": [
        {"name": "list_posts", "args": {}, "result": same},
        {"name": "list_posts", "args": {}, "result": same},
    ]}
    evidence = build_evidence({}, outputs, 1_000_000)
    assert evidence["tool_calls"][0]["result"] == same
    assert evidence["tool_calls"][1]["result"] == "[same result as tool_calls[0]]"
