"""Runs tests from the dataset against the agent (via hook.run_agent) and logs each test as a LangSmith experiment.

Each test (dataset example) is Given / When / Then:
  inputs.mock_tools, inputs.recorded_on   Given: every tool response the run may see (see mocks.py)
  inputs.prompt                           When: the message sent to the agent
  outputs.assertions                      Then: [{name, assertion}], one-sentence statements about the run
  metadata.name, metadata.description     what the test is

A test runs `repetitions` times in parallel as one experiment, because an agent that passes once can still be
flaky. Every run gets two kinds of feedback:
  all-tools-mocked   0 if the agent called a tool the test doesn't mock (the run touched something unpinned)
  <assertion name>   1 / 0 per assertion, graded together in one LLM call against the transcript

    uv run python harness.py                       # every test, 3 repetitions
    uv run python harness.py refund-damaged -r 1   # by name
"""

from __future__ import annotations

import argparse
import json
import os
from concurrent.futures import ThreadPoolExecutor

from dotenv import load_dotenv
from langchain.chat_models import init_chat_model
from langchain_core.messages import AIMessage, BaseMessage
from langsmith import Client, evaluate
from pydantic import BaseModel

load_dotenv()

import hook  # noqa: E402  (after load_dotenv: the agent reads its model settings at import)
from mocks import MockTools  # noqa: E402

DATASET_NAME = os.environ.get("EVAL_DATASET", "eval-editor-demo")
JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "anthropic:claude-sonnet-5-5")
EVIDENCE_LIMIT = 60_000


def _transcript(messages: list[BaseMessage]) -> list[dict]:
    rows = []
    for message in messages:
        row = {"role": message.type, "content": message.text}
        if isinstance(message, AIMessage) and message.tool_calls:
            row["tool_calls"] = [{"name": c["name"], "args": c["args"]} for c in message.tool_calls]
        rows.append(row)
    return rows


def target(inputs: dict) -> dict:
    """One run of one test: the agent answers the prompt with every tool call served from the test's mocks."""
    mocks = MockTools(inputs.get("mock_tools"), inputs.get("recorded_on"))
    messages = hook.run_agent(inputs["prompt"], mocks)
    answer = next((m.text for m in reversed(messages) if isinstance(m, AIMessage) and m.text), "")
    return {"answer": answer, "tool_calls": mocks.calls, "unmocked_calls": mocks.unmocked,
            "transcript": _transcript(messages)}


def all_tools_mocked(outputs: dict) -> dict:
    unmocked = outputs.get("unmocked_calls") or []
    names = sorted({call["name"] for call in unmocked})
    return {"key": "all-tools-mocked", "score": int(not unmocked),
            "comment": f"Called without a mock: {', '.join(names)}" if names else "Every tool call was mocked."}


class Grade(BaseModel):
    name: str
    passed: bool
    reason: str


class Grades(BaseModel):
    grades: list[Grade]


JUDGE_PROMPT = """You are grading one run of an AI agent against a test's assertions.

Each assertion is a statement that should be true of the run. Judge it only from the evidence: the agent's
final answer, its messages, and its tool calls with their arguments and results. If the evidence does not show
that the assertion is true, it fails. Return one grade per assertion, using its name, with a one-sentence reason
that cites the evidence.

<assertions>
{assertions}
</assertions>

<evidence>
{evidence}
</evidence>"""


def assertions(outputs: dict, reference_outputs: dict) -> dict:
    """Grades every assertion in one call; each becomes its own feedback key."""
    tests = [t for t in reference_outputs.get("assertions") or [] if t.get("name")]
    if not tests:
        return {"results": []}
    evidence = {k: outputs.get(k) for k in ("answer", "tool_calls", "transcript")}
    prompt = JUDGE_PROMPT.format(assertions=json.dumps(tests, indent=2),
                                 evidence=json.dumps(evidence, indent=2, default=str)[:EVIDENCE_LIMIT])
    judge = init_chat_model(JUDGE_MODEL).with_structured_output(Grades, method="json_schema")
    by_name = {g.name: g for g in judge.invoke(prompt).grades}
    return {"results": [
        {"key": t["name"], "score": int(by_name[t["name"]].passed) if t["name"] in by_name else None,
         "comment": by_name[t["name"]].reason if t["name"] in by_name else "The judge returned no grade."}
        for t in tests]}


def test_name(example) -> str:
    return (example.metadata or {}).get("name") or str(example.id)[:8]


def run_test(example, repetitions: int = 3, client: Client | None = None) -> str:
    """Runs one test `repetitions` times as one experiment and returns the experiment's name."""
    name = test_name(example)
    results = evaluate(target, data=[example], evaluators=[all_tools_mocked, assertions], client=client,
                       num_repetitions=repetitions, max_concurrency=repetitions, experiment_prefix=name,
                       metadata={"test": name, "example_id": str(example.id), "repetitions": repetitions})
    return results.experiment_name


def run_tests(example_ids: list[str] | None = None, names: list[str] | None = None, repetitions: int = 3) -> list[str]:
    """Runs the chosen tests (default: all) side by side. Mocks live in each run, so tests never share state."""
    client = Client()
    examples = [e for e in client.list_examples(dataset_name=DATASET_NAME)
                if (not example_ids or str(e.id) in example_ids) and (not names or test_name(e) in names)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        return list(pool.map(lambda e: run_test(e, repetitions, client), examples))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="*", help="test names (default: all)")
    ap.add_argument("-r", "--repetitions", type=int, default=3)
    args = ap.parse_args()
    for experiment in run_tests(names=args.names or None, repetitions=args.repetitions):
        print("experiment:", experiment)
