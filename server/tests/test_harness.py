"""A run that called a tool the test doesn't mock is an incomplete test: an error, never a grade."""

import pytest

import harness
from mocks import MockTools


def test_a_call_with_no_mock_makes_the_run_an_error(monkeypatch):
    # Given an agent that calls a tool the test does not mock
    def run_agent(inputs: dict, mocks: MockTools, files: list):
        mocks.call("get_shipping_status", {"tracking": "1Z9"}, "c1")
        return []

    monkeypatch.setattr(harness, "_run_agent", run_agent)

    # Then the run errors and names the tool, instead of carrying on into a scenario nobody wrote
    with pytest.raises(harness.IncompleteTest, match="get_shipping_status"):
        harness.target({"prompt": "Where is my order?", "mock_tools": {"get_order": {"id": "A1"}}})


def test_an_errored_run_gets_no_grades():
    # LangSmith passes an errored run's evaluators {"output": None}; that must not be graded as the agent failing
    reference = {"assertions": [{"name": "a", "assertion": "x"}], "checks": [{"name": "c", "type": "must_call", "tools": ["t"]}]}
    errored = {"output": None}
    assert harness.assertions({}, errored, reference) == {"results": []}
    assert harness.code_checks(errored, reference) == {"results": []}


def test_a_judge_that_times_out_once_is_retried(monkeypatch):
    # Given a grader whose first call times out (as Jev and Luna did, 2026-10-18), then answers
    calls = []

    def flaky(assertions, evidence):
        calls.append(1)
        if len(calls) == 1:
            raise TimeoutError("ConnectTimeout")
        return [harness.Grade(name="a", passed=True, reason="ok")]

    monkeypatch.setattr(harness, "hook", type("H", (), {"grade_assertions": staticmethod(flaky)}))
    monkeypatch.setattr(harness, "_RETRY_WAIT_SECONDS", 0)

    # When the assertions are graded
    result = harness.assertions({}, {"transcript": [], "answer": "hi"}, {"assertions": [{"name": "a", "assertion": "x"}]})

    # Then the outage cost a retry, not a grade
    assert len(calls) == 2 and result["results"][0]["score"] == 1


def test_a_real_bug_in_the_grader_is_not_retried(monkeypatch):
    calls = []

    def broken(assertions, evidence):
        calls.append(1)
        raise KeyError("name")

    monkeypatch.setattr(harness, "hook", type("H", (), {"grade_assertions": staticmethod(broken)}))
    with pytest.raises(KeyError):
        harness.assertions({}, {"transcript": [], "answer": "hi"}, {"assertions": [{"name": "a", "assertion": "x"}]})
    assert len(calls) == 1
