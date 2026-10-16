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


def test_dates_shift_by_days_since_recording():
    mocks = MockTools({"ship": {"eta": "2026-10-06", "at": "2026-10-01T09:00Z", "id": "2026-13-99"}},
                      recorded_on="2026-10-03", today=TODAY)
    assert mocks.respond("ship", {}) == {"eta": "2026-10-19", "at": "2026-10-14T09:00Z", "id": "2026-13-99"}
    assert shift_dates(["2026-01-01"], 0) == ["2026-01-01"]
