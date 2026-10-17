from datetime import date

from mocks import MockTools, shift_dates

TODAY = date(2026, 10, 16)


def test_single_response_for_any_arguments():
    mocks = MockTools({"get_order": {"id": "A1"}}, today=TODAY)
    message = mocks.call("get_order", {"order_id": "anything"}, "c1")
    assert message.content == '{"id": "A1"}' and message.status == "success"
    assert mocks.unmocked == []


def test_cases_match_on_a_subset_of_arguments_first_match_wins():
    mocks = MockTools({"ship": {"cases": [{"when": {"n": "1"}, "response": "one"}, {"response": "other"}]}}, today=TODAY)
    assert mocks.call("ship", {"n": "1", "extra": True}, "c1").content == "one"
    assert mocks.call("ship", {"n": "2"}, "c2").content == "other"


def test_raise_fails_the_call_but_counts_as_mocked():
    mocks = MockTools({"refund": {"raise": "503"}}, today=TODAY)
    message = mocks.call("refund", {}, "c1")
    assert message.status == "error" and message.content == "503"
    assert mocks.unmocked == []


def test_unmocked_tool_and_unmatched_case_are_strict_failures():
    mocks = MockTools({"ship": {"cases": [{"when": {"n": "1"}, "response": "one"}]}}, today=TODAY)
    assert mocks.call("refund", {"id": "A1"}, "c1").status == "error"
    assert "not mocked" in mocks.call("ship", {"n": "9"}, "c2").content
    assert [call["name"] for call in mocks.unmocked] == ["refund", "ship"]


def test_sequence_answers_each_call_in_turn_then_repeats_the_last():
    mocks = MockTools({"generate": {"sequence": ["img-1", "img-2"]}}, today=TODAY)
    assert [mocks.call("generate", {}, f"c{i}").content for i in range(3)] == ["img-1", "img-2", "img-2"]


def test_sequence_counts_per_tool():
    mocks = MockTools({"a": {"sequence": ["a1", "a2"]}, "b": {"sequence": ["b1", "b2"]}}, today=TODAY)
    assert [mocks.call(n, {}, "c").content for n in ("a", "b", "a")] == ["a1", "b1", "a2"]


def test_when_any_value_matches_the_value_under_any_argument_name():
    # Parallel calls carry the record id as `post_id` on one run and `id` on the next, so match on the value.
    cases = [{"when_any_value": "P1", "response": {"raise": "400 published"}}, {"response": "saved"}]
    mocks = MockTools({"update_post": {"cases": cases}}, today=TODAY)
    assert mocks.call("update_post", {"post_id": "P1"}, "c1").status == "error"
    assert mocks.call("update_post", {"id": "P1", "caption": "x"}, "c2").status == "error"
    assert mocks.call("update_post", {"id": "P2"}, "c3").content == "saved"


def test_dates_shift_by_days_since_recording():
    mocks = MockTools({"ship": {"eta": "2026-10-06", "at": "2026-10-01T09:00Z", "id": "2026-13-99"}},
                      recorded_on="2026-10-03", today=TODAY)
    assert mocks.respond("ship", {}) == {"eta": "2026-10-19", "at": "2026-10-14T09:00Z", "id": "2026-13-99"}
    assert shift_dates(["2026-01-01"], 0) == ["2026-01-01"]
