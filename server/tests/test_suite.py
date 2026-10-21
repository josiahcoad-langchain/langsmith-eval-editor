"""The pytest-like layer: which tests run, what counts as passing, and what the suite reports."""

import xml.etree.ElementTree as ET

from suite import Repetition, Test, exit_code, junit_xml, outcome, select, status_of, summary_line


def t(name, **metadata):
    return Test(id=f"id-{name}", name=name, metadata={"name": name, **metadata})


PASS = Repetition(error=None, scores={"a": 1, "c": 1}, comments={})
FAIL = Repetition(error=None, scores={"a": 0, "c": 1}, comments={"a": "it claimed the refund went through"})
ERR = Repetition(error="IncompleteTest: no mock answered get_order", scores={}, comments={})


# --- selection -------------------------------------------------------------------------------------------------

TESTS = [t("refund-ok", tags=["gate"]), t("refund-down", tags=["gate", "billing"]), t("shipping-late"), t("old", skip="stale")]


def names(tests):
    return [x.name for x in tests]


def test_select_by_name_keyword_tag_and_last_failed():
    assert names(select(TESTS, names=["shipping-late"])) == ["shipping-late"]
    assert names(select(TESTS, keyword="refund")) == ["refund-ok", "refund-down"]
    assert names(select(TESTS, keyword="not refund")) == ["shipping-late", "old"]
    assert names(select(TESTS, tags=["billing"])) == ["refund-down"]
    assert names(select(TESTS, last_failed={"id-refund-down", "id-shipping-late"})) == ["refund-down", "shipping-late"]
    assert names(select(TESTS, keyword="refund", tags=["gate"], last_failed={"id-refund-ok"})) == ["refund-ok"]


def test_status_of_an_experiment_matches_the_editor_dots():
    assert status_of(error_rate=0, stats={"a": {"min": 1, "max": 1}}) == "pass"
    assert status_of(error_rate=0, stats={"a": {"min": 0, "max": 1}}) == "flaky"
    assert status_of(error_rate=0, stats={"a": {"min": 0, "max": 0}}) == "fail"
    assert status_of(error_rate=1, stats={}) == "error"


# --- outcomes --------------------------------------------------------------------------------------------------

def test_every_repetition_must_pass_by_default():
    assert outcome(t("x"), [PASS, PASS, PASS]).verdict == "passed"
    result = outcome(t("x"), [PASS, FAIL, PASS])
    assert result.verdict == "failed"
    assert result.passed == 2 and result.runs == 3
    assert "a" in result.failing_keys and "refund" in result.failing_keys["a"]


def test_pass_threshold_tolerates_some_failed_repetitions():
    assert outcome(t("x", pass_threshold=0.6), [PASS, FAIL, PASS]).verdict == "passed"
    assert outcome(t("x", pass_threshold=0.6), [PASS, FAIL, FAIL]).verdict == "failed"


def test_a_repetition_with_an_undecided_score_does_not_count_as_passed():
    undecided = Repetition(error=None, scores={"a": None}, comments={})
    assert outcome(t("x"), [undecided]).verdict == "failed"


def test_all_errored_is_an_error_not_a_failure():
    result = outcome(t("x"), [ERR, ERR, ERR])
    assert result.verdict == "error"
    assert "no mock answered" in result.error


def test_xfail_is_strict():
    # A known failure is fine; a known failure that starts passing must fail the suite, so the marker comes off.
    assert outcome(t("x", xfail="context not trimmed yet"), [FAIL, FAIL]).verdict == "xfailed"
    assert outcome(t("x", xfail="context not trimmed yet"), [PASS, PASS]).verdict == "xpassed"


def test_skip_is_reported_without_running():
    assert outcome(t("x", skip="mocks a tool Max no longer has"), []).verdict == "skipped"


# --- reporting -------------------------------------------------------------------------------------------------

def test_exit_code_follows_pytest():
    assert exit_code([outcome(t("a"), [PASS]), outcome(t("b", xfail="r"), [FAIL]), outcome(t("c", skip="r"), [])]) == 0
    assert exit_code([outcome(t("a"), [PASS]), outcome(t("b"), [FAIL])]) == 1
    assert exit_code([outcome(t("a"), [ERR])]) == 1
    assert exit_code([outcome(t("b", xfail="r"), [PASS])]) == 1
    assert exit_code([]) == 5


def test_summary_line_counts_each_verdict_and_cost():
    outcomes = [outcome(t("a"), [PASS]), outcome(t("b"), [FAIL]), outcome(t("c", skip="r"), [])]
    line = summary_line(outcomes, seconds=72, cost=0.0123)
    assert "1 failed" in line and "1 passed" in line and "1 skipped" in line
    assert "1m 12s" in line and "$0.0123" in line


def test_junit_marks_failures_errors_and_skips():
    outcomes = [outcome(t("a"), [PASS]), outcome(t("b"), [FAIL]), outcome(t("c"), [ERR]), outcome(t("d", skip="stale"), [])]
    suite = ET.fromstring(junit_xml(outcomes, suite_name="agent-tests"))
    assert suite.get("tests") == "4" and suite.get("failures") == "1" and suite.get("errors") == "1" and suite.get("skipped") == "1"
    cases = {case.get("name"): case for case in suite.iter("testcase")}
    assert cases["b"].find("failure") is not None and "refund" in cases["b"].find("failure").text
    assert cases["c"].find("error") is not None
    assert cases["d"].find("skipped").get("message") == "stale"


def test_a_judge_that_could_not_be_reached_makes_the_repetition_ungraded_not_failed():
    # Given: every code check passed, but the assertions evaluator itself raised (LangSmith records that under
    # the evaluator's name with no score), which is what a judge ConnectTimeout looks like
    outage = Repetition(error=None, scores={"assertions": None, "opens-manage-plan": 1.0}, comments={"assertions": "ConnectTimeout('')"})
    assert outage.ungraded and not outage.passed

    # Then the test is ungraded, not failed, and CI still does not call it a pass
    result = outcome(Test(id="t", name="cancel", metadata={}), [outage, outage, outage])
    assert result.verdict == "ungraded"
    assert exit_code([result]) == 1
    # and JUnit reports it as an error (grading broke), not a failure (the agent fell short)
    xml = ET.fromstring(junit_xml([result], suite_name="s"))
    assert xml.get("errors") == "1" and xml.get("failures") == "0"


def test_an_undecided_assertion_is_still_a_failure_not_an_outage():
    undecided = Repetition(error=None, scores={"says-it-escalated": None}, comments={})
    assert not undecided.ungraded
    assert outcome(Test(id="t", name="x", metadata={}), [undecided]).verdict == "failed"


def test_a_real_failure_beside_an_outage_is_still_a_failure():
    outage = Repetition(error=None, scores={"assertions": None, "c": 1.0}, comments={})
    failed = Repetition(error=None, scores={"c": 0.0}, comments={})
    assert outcome(Test(id="t", name="x", metadata={}), [outage, failed]).verdict == "failed"


def test_proposals_are_left_out_unless_asked_for_or_named():
    tests = [t("refund-ok"), t("trace-1a2b", status="proposal"), t("shipping-late", status="active")]
    assert names(select(tests)) == ["refund-ok", "shipping-late"]
    assert names(select(tests, keyword="trace")) == []
    assert names(select(tests, proposals=True)) == ["refund-ok", "trace-1a2b", "shipping-late"]
    assert names(select(tests, names=["trace-1a2b"])) == ["trace-1a2b"]
