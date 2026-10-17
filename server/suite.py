"""The pytest-like layer over the harness: which tests run, what counts as passing, and the report.

No network here, so all of it is unit-tested; cli.py does the I/O. A test (one dataset example) can carry
pytest-style markers in its metadata:

    tags            ["gate", ...]   select with --tag (pytest's -m)
    skip            "reason"        not run, reported as skipped (pytest.mark.skip)
    xfail           "reason"        expected to fail; passing FAILS the suite so the marker gets removed
                                    (pytest.mark.xfail(strict=True))
    pass_threshold  0.0 - 1.0       fraction of repetitions that must pass (default 1.0: all of them)

A repetition passes when it did not error and every assertion and code check scored 1. An undecided score
(None) is not a pass: a judge that could not decide has not shown the agent was right.
"""

from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

# Verdicts, in the order the summary lists them (pytest's order).
VERDICTS = ("failed", "error", "passed", "skipped", "xfailed", "xpassed")
# Verdicts that make the suite fail.
_BAD = {"failed", "error", "xpassed"}


# Tests run at once (server and CLI; EVAL_PARALLEL overrides). Not "all": every agent run lives in one process, and
# on 2026-10-17 starting every test together (81 tests x 3 repetitions of a 37-middleware agent, beside other
# batches) pushed a 32 GB Mac into swap until it froze.
DEFAULT_PARALLEL_TESTS = 8

@dataclass(frozen=True)
class Test:
    id: str
    name: str
    metadata: dict[str, Any]


@dataclass(frozen=True)
class Repetition:
    error: str | None
    scores: dict[str, float | None]
    comments: dict[str, str]

    @property
    def passed(self) -> bool:
        return self.error is None and bool(self.scores) and all(score == 1 for score in self.scores.values())


@dataclass
class Outcome:
    test: Test
    verdict: str
    runs: int = 0
    passed: int = 0
    # assertion/check name -> the first reason it failed
    failing_keys: dict[str, str] = field(default_factory=dict)
    error: str = ""
    reason: str = ""  # skip / xfail reason
    cost: float = 0.0
    seconds: float = 0.0
    experiment: str = ""


# --- selection ---------------------------------------------------------------------------------------------------

def select(tests: list[Test], names: list[str] | None = None, keyword: str | None = None,
           tags: list[str] | None = None, last_failed: set[str] | None = None) -> list[Test]:
    """Filters compose (AND), like pytest's -k and -m together. `keyword` is a substring, or `not <substring>`."""
    chosen = list(tests)
    if names:
        chosen = [x for x in chosen if x.name in names]
    if keyword:
        negate = keyword.startswith("not ")
        needle = keyword[4:] if negate else keyword
        chosen = [x for x in chosen if (needle in x.name) != negate]
    if tags:
        chosen = [x for x in chosen if set(tags) & set(x.metadata.get("tags") or [])]
    if last_failed is not None:
        chosen = [x for x in chosen if x.id in last_failed]
    return chosen


def status_of(error_rate: float, stats: dict[str, dict[str, Any]]) -> str:
    """A test's status from its newest experiment's stats: the same rule as the editor's dots."""
    if error_rate >= 1:
        return "error"
    if not stats:
        return "none"
    if any(stat.get("max") == 0 for stat in stats.values()):
        return "fail"
    if error_rate > 0 or any(stat.get("min") != 1 for stat in stats.values()):
        return "flaky"
    return "pass"


# --- outcomes ----------------------------------------------------------------------------------------------------

def outcome(test: Test, repetitions: list[Repetition]) -> Outcome:
    meta = test.metadata
    if meta.get("skip"):
        return Outcome(test, "skipped", reason=str(meta["skip"]))

    runs = len(repetitions)
    passed = sum(rep.passed for rep in repetitions)
    if runs and all(rep.error for rep in repetitions):
        return Outcome(test, "error", runs=runs, error=repetitions[0].error or "")

    threshold = float(meta.get("pass_threshold", 1.0))
    # Required passes, rounded up so 0.6 of 3 needs 2. A float slack keeps 2/3 >= 0.666 from rounding against us.
    ok = runs > 0 and passed >= math.ceil(threshold * runs - 1e-9)
    result = Outcome(test, "passed" if ok else "failed", runs=runs, passed=passed, failing_keys=_failing_keys(repetitions))
    if meta.get("xfail"):
        result.verdict = "xpassed" if ok else "xfailed"
        result.reason = str(meta["xfail"])
    return result


def _failing_keys(repetitions: list[Repetition]) -> dict[str, str]:
    failing: dict[str, str] = {}
    for rep in repetitions:
        if rep.error:
            failing.setdefault("(error)", rep.error)
            continue
        for key, score in rep.scores.items():
            if score != 1:
                failing.setdefault(key, rep.comments.get(key) or ("undecided" if score is None else "scored 0"))
    return failing


# --- reporting ---------------------------------------------------------------------------------------------------

def exit_code(outcomes: list[Outcome]) -> int:
    """0 all good, 1 something failed (including an xfail that passed), 5 nothing selected: pytest's codes."""
    if not outcomes:
        return 5
    return 1 if any(o.verdict in _BAD for o in outcomes) else 0


def summary_line(outcomes: list[Outcome], seconds: float, cost: float | None) -> str:
    counts = Counter(o.verdict for o in outcomes)
    parts = ", ".join(f"{counts[v]} {v}" for v in VERDICTS if counts[v]) or "no tests ran"
    minutes, secs = divmod(int(round(seconds)), 60)
    took = f"{minutes}m {secs}s" if minutes else f"{secs}s"
    priced = f" (${cost:.4f})" if cost else ""
    return f"{parts} in {took}{priced}"


def junit_xml(outcomes: list[Outcome], suite_name: str) -> str:
    """JUnit XML, the format CI systems (GitHub Actions, GitLab, Jenkins) turn into per-test annotations."""
    counts = Counter(o.verdict for o in outcomes)
    suite = ET.Element("testsuite", {
        "name": suite_name, "tests": str(len(outcomes)),
        "failures": str(counts["failed"] + counts["xpassed"]), "errors": str(counts["error"]),
        "skipped": str(counts["skipped"] + counts["xfailed"]),
        "time": f"{sum(o.seconds for o in outcomes):.1f}",
    })
    for o in outcomes:
        case = ET.SubElement(suite, "testcase", {"classname": suite_name, "name": o.test.name, "time": f"{o.seconds:.1f}"})
        if o.verdict == "failed":
            detail = "\n".join(f"{key}: {reason}" for key, reason in o.failing_keys.items())
            ET.SubElement(case, "failure", {"message": f"passed {o.passed} of {o.runs} repetitions"}).text = detail
        elif o.verdict == "xpassed":
            ET.SubElement(case, "failure", {"message": f"expected to fail ({o.reason}) but passed: remove the xfail"})
        elif o.verdict == "error":
            ET.SubElement(case, "error", {"message": o.error.splitlines()[0] if o.error else "errored"}).text = o.error
        elif o.verdict in ("skipped", "xfailed"):
            ET.SubElement(case, "skipped", {"message": o.reason})
    return ET.tostring(suite, encoding="unicode")
