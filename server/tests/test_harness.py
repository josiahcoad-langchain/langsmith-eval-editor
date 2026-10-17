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
