from checks import run_checks

OUTPUTS = {
    "tool_calls": [
        {"name": "get_order", "args": {"id": "A1"}},
        {"name": "get_order", "args": {"id": "A2"}},
        {"name": "issue_refund", "args": {"id": "A1", "amount": 10}},
    ],
    # Two model calls that asked for tools (rounds), then the final answer.
    "model_calls": [
        {"input_tokens": 1_000, "output_tokens": 50, "tool_calls": 2},
        {"input_tokens": 1_200, "output_tokens": 40, "tool_calls": 1},
        {"input_tokens": 1_300, "output_tokens": 90, "tool_calls": 0},
    ],
}


def grade(check: dict) -> dict:
    return run_checks({**OUTPUTS}, [{"name": "c", **check}])[0]


def test_must_call_needs_each_tool_and_an_inner_list_means_any_of():
    assert grade({"type": "must_call", "tools": ["get_order", ["issue_refund", "escalate"]]})["score"] == 1
    assert grade({"type": "must_call", "tools": ["escalate"]})["score"] == 0


def test_must_not_call():
    assert grade({"type": "must_not_call", "tools": ["escalate"]})["score"] == 1
    assert grade({"type": "must_not_call", "tools": ["issue_refund"]})["score"] == 0


def test_max_tool_calls_total_and_per_tool():
    assert grade({"type": "max_tool_calls", "max": 3})["score"] == 1
    assert grade({"type": "max_tool_calls", "max": 2})["score"] == 0
    assert grade({"type": "max_tool_calls", "max": 1, "tool": "get_order"})["score"] == 0


def test_max_tool_rounds_counts_model_calls_that_asked_for_tools():
    assert grade({"type": "max_tool_rounds", "max": 2})["score"] == 1
    assert grade({"type": "max_tool_rounds", "max": 1})["score"] == 0


def test_must_call_before_only_binds_when_second_runs():
    assert grade({"type": "must_call_before", "first": "get_order", "second": "issue_refund"})["score"] == 1
    assert grade({"type": "must_call_before", "first": "issue_refund", "second": "get_order"})["score"] == 0
    assert grade({"type": "must_call_before", "first": "x", "second": "escalate"})["score"] == 1


def test_must_call_with_values_needs_one_call_carrying_every_value():
    assert grade({"type": "must_call_with_values", "tool": "issue_refund", "args": {"id": "A1"}})["score"] == 1
    assert grade({"type": "must_call_with_values", "tool": "issue_refund", "args": {"id": "A2"}})["score"] == 0


def test_max_prompt_tokens_is_the_largest_single_model_call():
    passed = grade({"type": "max_prompt_tokens", "max": 1_300})
    failed = grade({"type": "max_prompt_tokens", "max": 1_250})
    assert passed["score"] == 1 and failed["score"] == 0
    assert "1,300" in failed["comment"]


def test_max_model_calls():
    assert grade({"type": "max_model_calls", "max": 3})["score"] == 1
    assert grade({"type": "max_model_calls", "max": 2})["score"] == 0


def test_custom_check_goes_to_the_hook():
    def custom(outputs, check):
        return check["want"] == "yes", "hook said so"

    result = run_checks(OUTPUTS, [{"name": "c", "type": "custom", "want": "yes"}], custom=custom)[0]
    assert result == {"key": "c", "score": 1, "comment": "hook said so"}


def test_unknown_type_or_missing_custom_handler_scores_none_rather_than_passing():
    # A typo must never read as a pass.
    assert grade({"type": "must_cal", "tools": []})["score"] is None
    assert grade({"type": "custom"})["score"] is None


def test_a_check_missing_a_parameter_scores_none_without_sinking_the_others():
    results = run_checks({"tool_calls": []}, [{"name": "cap", "type": "max_tool_calls"},
                                              {"name": "none", "type": "must_not_call", "tools": ["x"]}])
    assert [(r["key"], r["score"]) for r in results] == [("cap", None), ("none", 1)]
