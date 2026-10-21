"""Eval proposals: flagged traces waiting to become tests.

A LangSmith annotation queue (PROPOSALS_QUEUE) is the inbox. The editor lists its runs under Proposals; opening
one imports the trace as a dataset example with `metadata.status = "proposal"` and `metadata.source_run_id`. The
expert writes assertions, fixes mocks and runs it like any test. Accept sets the status to "active" and takes the
run out of the queue; Delete removes the example and the queue item. Until then the run stays in the queue, and
the suite (cli.py, Run all) leaves proposals out.

    uv run python proposals.py                  create the queue (the server does this on start)
    uv run python proposals.py --add <run-id>   put a run in the queue by hand (a trace's root run)
    uv run python proposals.py --rule           also create a run rule: root runs of LANGSMITH_PROJECT that get
                                                user_score = 0 feedback go to the queue automatically
"""

from __future__ import annotations

import argparse
import os

from dotenv import load_dotenv
from langsmith import Client

load_dotenv()

PROPOSALS_QUEUE = os.environ.get("PROPOSALS_QUEUE", "eval-editor-demo-proposals")
TRACE_PROJECT = os.environ.get("LANGSMITH_PROJECT", "eval-editor-demo-agent")
# Root runs with a thumbs-down. Change the key to whatever feedback your app writes.
FLAGGED_FILTER = 'and(eq(is_root, true), and(eq(feedback_key, "user_score"), eq(feedback_score, 0)))'


def ensure_queue(client: Client) -> str:
    """The proposals queue's id, creating the queue if it doesn't exist."""
    queues = client.request_with_retries("GET", "/annotation-queues", params={"name": PROPOSALS_QUEUE}).json()
    match = next((q for q in queues if q["name"] == PROPOSALS_QUEUE), None)
    if match:
        return match["id"]
    created = client.request_with_retries("POST", "/annotation-queues", json={
        "name": PROPOSALS_QUEUE,
        "description": "Flagged traces proposed as eval tests. Review them in the eval editor's Proposals list."})
    return created.json()["id"]


def add_run(client: Client, queue_id: str, run_id: str) -> None:
    client.request_with_retries("POST", f"/annotation-queues/{queue_id}/runs", json=[run_id])


def create_rule(client: Client, queue_id: str) -> dict:
    project = client.read_project(project_name=TRACE_PROJECT)
    return client.request_with_retries("POST", "/runs/rules", json={
        "display_name": f"Flagged runs -> {PROPOSALS_QUEUE}", "session_id": str(project.id), "sampling_rate": 1.0,
        "filter": FLAGGED_FILTER, "add_to_annotation_queue_id": queue_id}).json()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--add", metavar="RUN_ID", action="append", help="add a root run to the queue (repeatable)")
    ap.add_argument("--rule", action="store_true", help=f"create a run rule on {TRACE_PROJECT} that fills the queue")
    args = ap.parse_args()
    client = Client()
    queue_id = ensure_queue(client)
    print(f"queue {PROPOSALS_QUEUE}: {queue_id}")
    for run_id in args.add or []:
        add_run(client, queue_id, run_id)
        print(f"added run {run_id}")
    if args.rule:
        rule = create_rule(client, queue_id)
        print(f"rule {rule['id']}: {FLAGGED_FILTER} on {TRACE_PROJECT} -> {PROPOSALS_QUEUE}")


if __name__ == "__main__":
    main()
