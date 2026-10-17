"""Run all must not start every test at once: the server runs a few at a time and queues the rest."""

import threading
import time

import main


def test_runs_are_capped_and_the_rest_queue(monkeypatch):
    # Given a harness whose runs block until released, and more tests than slots
    release = threading.Event()
    running = []

    def run_tests(example_ids, repetitions):
        running.append(example_ids[0])
        release.wait(5)

    monkeypatch.setattr(main.harness, "run_tests", run_tests)
    main._runs.clear()

    # When ten tests are started in one request
    started = main.start_runs(main.RunRequest(example_ids=[f"e{i}" for i in range(10)], repetitions=1))
    time.sleep(0.3)

    # Then only MAX_PARALLEL_TESTS run, and the others wait as queued
    states = [main._runs[job["id"]]["state"] for job in started]
    assert len(started) == 10
    assert states.count("running") == main.MAX_PARALLEL_TESTS
    assert states.count("queued") == 10 - main.MAX_PARALLEL_TESTS
    release.set()
