"""Re-grade one assertion over a test's saved transcripts, to tell the agent, the judge and the assertion apart.

The agent is not run again: each repetition of the test's newest experiment already holds what the agent did.
That transcript is graded again `times` times by every judge the hook offers, and diagnose.py reads the grades.
Costs only the judges' calls.

A hook offers judges with `judges() -> {name: grade_assertions-like function}`. Without one there is a single
judge, the one the harness grades with. Two judges are what make "the assertion is ambiguous" detectable.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from langsmith import Client

import harness
from diagnose import diagnose
from evidence import build_evidence

Grader = Callable[[list[dict], dict], list[Any]]


def judges() -> dict[str, Grader]:
    offered = getattr(harness.hook, "judges", None)
    if offered:
        return offered()
    grade = getattr(harness.hook, "grade_assertions", None)
    return {"default": grade or harness._judge_all}


def regrade(client: Client, example_id: str, name: str, times: int = 3) -> dict[str, Any]:
    example = client.read_example(example_id)
    assertion = next((a for a in (example.outputs or {}).get("assertions") or [] if a.get("name") == name), None)
    if assertion is None:
        raise ValueError(f"{name!r} is not an assertion of this test (code checks are deterministic: nothing to re-grade)")
    experiment = _newest_experiment(client, example)
    runs = sorted(client.list_runs(project_name=experiment, is_root=True), key=lambda run: run.start_time)
    graded = [run for run in runs if (run.outputs or {}).get("transcript") is not None]
    if not graded:
        raise ValueError("the newest run has no graded repetitions (it errored), so there is nothing to re-grade")

    graders = judges()
    jobs = [(rep, judge, i) for rep in range(len(graded)) for judge in graders for i in range(times)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        grades = list(pool.map(lambda job: _grade_once(graders[job[1]], assertion, graded[job[0]]), jobs))

    repetitions = []
    for rep, run in enumerate(graded):
        mine = [(job, grade) for job, grade in zip(jobs, grades, strict=True) if job[0] == rep]
        repetitions.append({
            "number": rep + 1,
            "original": _original(client, run, name),
            "regrades": {judge: [g.passed for (r, j, _), g in mine if j == judge] for judge in graders},
            "reasons": {judge: next((g.reason for (r, j, _), g in mine if j == judge), "") for judge in graders},
            "answer": (run.outputs or {}).get("answer", ""),
            "tool_calls": [c.get("name") for c in (run.outputs or {}).get("tool_calls") or []],
        })
    result = diagnose(repetitions)
    return {"experiment": experiment, "assertion": assertion, "times": times, "judges": list(graders),
            "repetitions": repetitions, "cause": result.cause, "advice": result.advice,
            "failing_repetitions": result.failing_repetitions, "disputed_repetitions": result.disputed_repetitions,
            "unreliable_judges": result.unreliable_judges, "overturned_repetitions": result.overturned_repetitions}


def _grade_once(grader: Grader, assertion: dict, run: Any) -> Any:
    evidence = build_evidence(run.inputs or {}, run.outputs or {}, harness.EVIDENCE_LIMIT)
    grades = grader([harness.as_run(assertion, run.inputs or {}, run.outputs or {})], evidence)
    match = next((g for g in grades if g.name == assertion["name"]), None)
    return match or harness.Grade(name=assertion["name"], passed=None, reason="The judge returned no grade.")


def _original(client: Client, run: Any, name: str) -> bool | None:
    for feedback in client.list_feedback(run_ids=[run.id], feedback_key=[name]):
        return None if feedback.score is None else feedback.score == 1
    return None


def _newest_experiment(client: Client, example: Any) -> str:
    name = harness.test_name(example)
    page = client.request_with_retries("GET", "/sessions", params={
        "reference_dataset": str(example.dataset_id), "name_contains": name, "limit": 20,
        "sort_by": "start_time", "sort_by_desc": "true"}).json()
    for experiment in page:
        if ((experiment.get("extra") or {}).get("metadata") or {}).get("example_id") == str(example.id):
            return experiment["name"]
    raise ValueError("this test has never run, so there is nothing to re-grade")
