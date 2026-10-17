"""Run all starts every test at once by default; EVAL_PARALLEL caps it, and then the rest queue."""

import threading
import time

import pytest

import main


@pytest.fixture
def blocking_harness(monkeypatch):
    """A harness whose runs block until released. Drains every job afterwards while the fake is still patched in;
    otherwise queued ones would run the real harness after the test ends and call LangSmith."""
    release = threading.Event()
    monkeypatch.setattr(main.harness, "run_tests", lambda example_ids, repetitions: release.wait(5))
    main._runs.clear()
    yield
    release.set()
    deadline = time.time() + 5
    while time.time() < deadline and any(job["state"] != "done" for job in main._runs.values()):
        time.sleep(0.05)
    assert all(job["state"] == "done" for job in main._runs.values())


def _start_ten() -> list[str]:
    started = main.start_runs(main.RunRequest(example_ids=[f"e{i}" for i in range(10)], repetitions=1))
    time.sleep(0.3)
    return [main._runs[job["id"]]["state"] for job in started]


def test_every_test_runs_at_once_by_default(blocking_harness):
    assert _start_ten().count("running") == 10


def test_a_cap_runs_that_many_and_the_rest_queue(blocking_harness, monkeypatch):
    monkeypatch.setattr(main, "_slots", threading.Semaphore(4))
    states = _start_ten()
    assert states.count("running") == 4
    assert states.count("queued") == 6
