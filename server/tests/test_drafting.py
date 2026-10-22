"""Assertion drafts: what the judge model is shown, and what comes back to the editor."""

import pytest

import drafting


@pytest.fixture
def model(monkeypatch):
    seen = {}

    def draft(prompt):
        seen["prompt"] = prompt
        return seen["reply"]

    monkeypatch.setattr(drafting, "_draft", draft)
    return seen


def test_suggestions_see_the_flag_reply_and_prompt(model):
    model["reply"] = ["It asks for the order number.", "It does not promise a refund."]
    drafts = drafting.suggest_assertions("Refund A1001?", "Refund issued!", [{"key": "user-score", "score": 0, "comment": "promised a refund it can't give"}], [])
    assert drafts == ["It asks for the order number.", "It does not promise a refund."]
    assert "promised a refund it can't give" in model["prompt"]
    assert "Refund issued!" in model["prompt"]
    assert "Refund A1001?" in model["prompt"]


def test_suggestions_drop_blanks_repeats_and_existing_and_stop_at_four(model):
    model["reply"] = ["  It  asks for the order.  ", "", "it asks for the order.", "Existing one.", "A.", "B.", "C.", "D."]
    assert drafting.suggest_assertions("p", "r", [], ["Existing one."]) == ["It asks for the order.", "A.", "B.", "C."]


def test_rewrites_are_built_from_the_reasons_and_capped_at_two(model):
    model["reply"] = ["It names the date.", "The original.", "It names the weekday.", "Third."]
    drafts = drafting.rewrite_assertion("The original.", "assertion_ambiguous", ["it did name the date"], ["no date given"])
    assert drafts == ["It names the date.", "It names the weekday."]
    assert "it did name the date" in model["prompt"] and "no date given" in model["prompt"]
    assert "different judges read the same reply differently" in model["prompt"]
