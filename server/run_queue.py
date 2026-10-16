"""The run queue for custom-app mode, where the editor runs inside LangSmith and cannot call this server.

Run test commits a new version of a Context Hub prompt repo (REQUESTS_REPO); each commit's template holds one
request as `key: value` lines (test, example_id, repetitions, requested_at). A prompt webhook on that repo POSTs
to /hooks/eval-runs, and this module reads the repo and runs what is new. The webhook body is only a wake-up
call: the repo is the source of truth, so a missed or repeated delivery never loses or doubles a run.

Requests already in the repo the first time the server starts are marked done, not run.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path

from langsmith import Client

import harness

log = logging.getLogger("run-queue")

REQUESTS_REPO = os.environ.get("REQUESTS_REPO", "eval-editor-run-requests")
STATE_FILE = Path(__file__).resolve().parent / ".run-queue-state.json"
_lock = threading.Lock()


def parse_request(template: str) -> dict:
    request = {}
    for line in template.splitlines():
        name, _, value = line.partition(": ")
        request[name.rstrip(":")] = value
    return request


def fetch_requests(client: Client) -> list[dict]:
    """Every request in the repo, oldest first. An empty list if the repo doesn't exist yet."""
    try:
        page = client.request_with_retries("GET", f"/commits/-/{REQUESTS_REPO}", params={"limit": 100}).json()
    except Exception as error:  # noqa: BLE001
        if "404" in str(error) or "not found" in str(error).lower():
            return []
        raise
    templates = [((c.get("manifest") or {}).get("kwargs") or {}).get("template", "") for c in page.get("commits", [])]
    requests = [parse_request(t) for t in templates]
    return sorted((r for r in requests if r.get("example_id") and r.get("requested_at")),
                  key=lambda r: r["requested_at"])


def _key(request: dict) -> str:
    return f"{request['example_id']}@{request['requested_at']}"


def _load_done() -> set[str] | None:
    return set(json.loads(STATE_FILE.read_text())["done"]) if STATE_FILE.exists() else None


def _save_done(done: set[str]) -> None:
    STATE_FILE.write_text(json.dumps({"done": sorted(done)}, indent=1))


def init(client: Client) -> None:
    if _load_done() is None:
        backlog = fetch_requests(client)
        _save_done({_key(r) for r in backlog})
        log.info("first start: %d queued requests marked done", len(backlog))


def process(client: Client) -> None:
    """Runs the newest pending request per test, one test at a time. Safe to call on every webhook delivery."""
    if not _lock.acquire(blocking=False):
        return  # a run is in progress; it re-reads the queue when it finishes
    try:
        while True:
            done = _load_done() or set()
            requests = fetch_requests(client)
            newest: dict[str, dict] = {}
            for request in requests:
                if _key(request) not in done:
                    newest[request["example_id"]] = request
            if not newest:
                return
            for request in sorted(newest.values(), key=lambda r: r["requested_at"]):
                repetitions = int(request.get("repetitions") or 3)
                log.info("running %s (%s) x%d", request.get("test"), request["example_id"], repetitions)
                try:
                    harness.run_tests(example_ids=[request["example_id"]], repetitions=repetitions)
                except Exception:  # noqa: BLE001 - one broken test must not stop the queue
                    log.exception("run failed")
                # Older requests for the same test are covered by this run.
                done.update(_key(r) for r in requests
                            if r["example_id"] == request["example_id"] and r["requested_at"] <= request["requested_at"])
                _save_done(done)
    finally:
        _lock.release()
