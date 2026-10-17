"""Run agent tests from the command line, the way you run pytest.

    uv run python cli.py                              every test
    uv run python cli.py refund-service-down          by name
    uv run python cli.py -k refund                    names containing "refund" (-k "not refund" excludes)
    uv run python cli.py --tag gate                   tests tagged "gate" (metadata.tags), like pytest -m
    uv run python cli.py --lf                         only tests whose newest result failed, was flaky or errored
    uv run python cli.py --tag gate --junit out.xml   for CI: JUnit report, exit code 1 on any failure

Markers (skip, xfail, pass_threshold) live in each test's metadata; see suite.py. Exit codes follow pytest:
0 all passed, 1 something failed, 5 nothing selected.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from langsmith import Client

import harness
from suite import DEFAULT_PARALLEL_TESTS, Outcome, Test, exit_code, junit_xml, outcome, select, status_of, summary_line

_COLORS = {"passed": "32", "failed": "31", "error": "31", "xpassed": "31", "skipped": "33", "xfailed": "33"}


def main(argv: list[str] | None = None) -> int:
    args = _parse(argv)
    client = Client()
    tests = _load_tests(client)
    chosen = select(tests, names=args.names or None, keyword=args.k, tags=args.tag or None,
                    last_failed=_last_failed(client, tests) if args.lf else None)
    print(f"collected {len(tests)} tests, selected {len(chosen)} · {args.repetitions} repetition"
          f"{'' if args.repetitions == 1 else 's'} each · {args.parallel} at a time")

    started = time.monotonic()
    outcomes = _run(client, chosen, args.repetitions, args.parallel)
    cost = sum(o.cost for o in outcomes)
    line = summary_line(outcomes, time.monotonic() - started, cost)
    print(f"\n{'=' * 8} {line} {'=' * 8}")
    if args.junit:
        with open(args.junit, "w") as f:
            f.write(junit_xml(outcomes, suite_name=harness.DATASET_NAME))
        print(f"JUnit report: {args.junit}")
    return exit_code(outcomes)


def _parse(argv: list[str] | None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Run agent tests (Given / When / Assert) from the eval dataset.")
    ap.add_argument("names", nargs="*", help="test names (default: all)")
    ap.add_argument("-k", help='substring of the test name, or "not <substring>"')
    ap.add_argument("--tag", action="append", help="only tests with this tag (repeatable: any of them)")
    ap.add_argument("--lf", action="store_true", help="only tests whose newest result failed, was flaky or errored")
    ap.add_argument("-r", "--repetitions", type=int, default=3)
    ap.add_argument("--parallel", type=int, default=int(os.environ.get("EVAL_PARALLEL") or DEFAULT_PARALLEL_TESTS),
                    help=f"tests run at once (default {DEFAULT_PARALLEL_TESTS}, or EVAL_PARALLEL)")
    ap.add_argument("--junit", help="write a JUnit XML report here")
    return ap.parse_args(argv)


def _load_tests(client: Client) -> list[Test]:
    examples = client.list_examples(dataset_name=harness.DATASET_NAME)
    return [Test(id=str(e.id), name=harness.test_name(e), metadata=dict(e.metadata or {})) for e in examples]


def _last_failed(client: Client, tests: list[Test]) -> set[str]:
    """Tests whose newest experiment was not a clean pass. Experiments come newest first, so the scan stops as
    soon as every test has been seen (the editor's dots use the same rule)."""
    dataset = client.read_dataset(dataset_name=harness.DATASET_NAME)
    wanted = {x.id for x in tests}
    status: dict[str, str] = {}
    for offset in range(0, 100_000, 100):
        page = client.request_with_retries("GET", "/sessions", params={
            "reference_dataset": str(dataset.id), "include_stats": "true", "limit": 100, "offset": offset,
            "sort_by": "start_time", "sort_by_desc": "true"}).json()
        for experiment in page:
            example_id = ((experiment.get("extra") or {}).get("metadata") or {}).get("example_id")
            if example_id and example_id not in status:
                status[example_id] = status_of(experiment.get("error_rate") or 0, experiment.get("feedback_stats") or {})
        if wanted <= status.keys() or len(page) < 100:
            break
    return {test_id for test_id, s in status.items() if s in ("fail", "flaky", "error")}


def _run(client: Client, tests: list[Test], repetitions: int, parallel: int) -> list[Outcome]:
    examples = {str(e.id): e for e in client.list_examples(dataset_name=harness.DATASET_NAME)}
    outcomes = [outcome(x, []) for x in tests if x.metadata.get("skip")]
    for o in outcomes:
        _print(o)
    to_run = [x for x in tests if not x.metadata.get("skip")]
    with ThreadPoolExecutor(max_workers=max(1, parallel)) as pool:
        futures = {pool.submit(_run_one, client, examples[x.id], x, repetitions): x for x in to_run}
        for future in as_completed(futures):
            o = future.result()
            outcomes.append(o)
            _print(o)
    return outcomes


def _run_one(client: Client, example, test: Test, repetitions: int) -> Outcome:
    started = time.monotonic()
    experiment, reps = harness.run_test_repetitions(example, repetitions, client)
    result = outcome(test, reps)
    result.seconds = time.monotonic() - started
    result.experiment = experiment
    result.cost = _experiment_cost(client, experiment)
    return result


def _experiment_cost(client: Client, experiment: str) -> float:
    # Best effort: LangSmith prices runs asynchronously, so a just-finished experiment can read 0.
    try:
        return float(client.read_project(project_name=experiment, include_stats=True).total_cost or 0)
    except Exception:  # noqa: BLE001 - the cost is a nice-to-have; never fail a test run over it
        return 0.0


def _print(o: Outcome) -> None:
    tag = o.verdict.upper()
    if sys.stdout.isatty():
        tag = f"\033[{_COLORS[o.verdict]}m{tag}\033[0m"
    detail = {
        "skipped": f"({o.reason})",
        "xfailed": f"{o.passed}/{o.runs} · expected: {o.reason}",
        "xpassed": f"{o.passed}/{o.runs} · expected to fail ({o.reason}) but passed: remove the xfail",
        "error": o.error,
    }.get(o.verdict, f"{o.passed}/{o.runs}" + (f" · ${o.cost:.4f}" if o.cost else "") + f" · {o.seconds:.0f}s")
    print(f"{tag:<9} {o.test.name}  {detail}")
    if o.verdict == "failed":
        for key, reason in o.failing_keys.items():
            print(f"    {key}: {reason}")


if __name__ == "__main__":
    raise SystemExit(main())
