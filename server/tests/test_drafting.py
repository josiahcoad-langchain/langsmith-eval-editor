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


def test_suggestions_see_the_agents_rules_tools_conversation_and_tool_results(model, monkeypatch):
    model["reply"] = ["It says a teammate will follow up."]
    monkeypatch.setattr(drafting, "_from_trace", lambda trace_id: {
        "instructions": "Refunds over $200 go to a human.", "tools": [{"name": "issue_refund", "description": "Refund an order."}]})
    drafting.suggest_assertions(
        "Refund my tent.", "Refund issued!", [], [], trace_id="t1",
        history=[{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "", "tool_calls": [{"name": "get_order", "args": {"order_id": "A1003"}}]}],
        mocks={"get_order": {"total": 649.0}})
    prompt = model["prompt"]
    assert "Refunds over $200 go to a human." in prompt
    assert "issue_refund: Refund an order." in prompt
    assert 'called get_order({"order_id": "A1003"})' in prompt
    assert '"total": 649.0' in prompt


def test_without_a_trace_the_hooks_agent_context_is_used(model, monkeypatch):
    model["reply"] = []
    monkeypatch.setattr(drafting.harness.hook, "agent_context", lambda: {"instructions": "Be brief.", "tools": [{"name": "t", "description": "d"}]}, raising=False)
    drafting.suggest_assertions("p", "r", [], [])
    assert "Be brief." in model["prompt"] and "- t: d" in model["prompt"]


def test_system_prompt_and_tools_are_read_from_a_traced_model_call():
    inputs = {"messages": [[{"id": ["langchain", "schema", "messages", "SystemMessage"], "kwargs": {"content": "Rules here.", "type": "system"}},
                            {"id": ["langchain", "schema", "messages", "HumanMessage"], "kwargs": {"content": "hi", "type": "human"}}]]}
    assert drafting._system_prompt(inputs) == "Rules here."
    assert drafting._system_prompt({"messages": [{"role": "system", "content": "Plain."}]}) == "Plain."
    assert drafting._tool({"type": "function", "function": {"name": "a", "description": "b"}}) == {"name": "a", "description": "b"}
    assert drafting._tool({"name": "a", "description": "b", "input_schema": {}}) == {"name": "a", "description": "b"}


def test_every_kind_of_feedback_reaches_the_drafter(model):
    model["reply"] = []
    drafting.suggest_assertions("p", "r", [
        {"key": "hallucination", "score": 1, "comment": "invented a delivery date", "run": "ChatAnthropic"},
        {"key": "tone", "value": "curt", "comment": ""},
        {"key": "reviewer", "score": None, "comment": "should offer options", "correction": "Offer to check UPS express."},
    ], [])
    prompt = model["prompt"]
    assert "hallucination, score 1, on the ChatAnthropic step: invented a delivery date" in prompt
    assert "tone, value curt: no comment" in prompt
    assert "(correction: Offer to check UPS express.)" in prompt
