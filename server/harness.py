"""Runs tests from the dataset against the agent (via hook.run_agent) and logs each test as a LangSmith experiment.

Each test (dataset example) is Given / When / Then:
  inputs.mock_tools, inputs.recorded_on   Given: every tool response the run may see (see mocks.py)
  inputs.history                          Given: prior turns [{role, content}] sent before the prompt
  inputs.context                          Given: opaque JSON the hook uses to set the agent up (its own keys)
  inputs.prompt                           When: the message sent to the agent
  outputs.assertions                      Then: [{name, assertion}], one-sentence statements about the run
  outputs.checks                          Then: [{name, type, ...}], code checks a judge can't grade (checks.py)

The hook returns the replayed history first, then this turn's messages. Grading and code checks look only at
this turn, so replayed history never counts as the agent's own work.
  metadata.name, metadata.description     what the test is

A test runs `repetitions` times in parallel as one experiment, because an agent that passes once can still be
flaky. Every run gets three kinds of feedback:
  all-tools-mocked   0 if the agent called a tool the test doesn't mock (the run touched something unpinned)
  <assertion name>   1 / 0 per assertion, graded together in one LLM call against the transcript
  <check name>       1 / 0 per code check, graded in code (None for an unknown type, never a silent pass)

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
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from langsmith import Client, evaluate
from pydantic import BaseModel

load_dotenv()

from agent_hook import load_hook  # noqa: E402
from checks import run_checks  # noqa: E402
from mocks import MockTools  # noqa: E402

hook = load_hook()  # after load_dotenv: the agent reads its model settings at import

DATASET_NAME = os.environ.get("EVAL_DATASET", "eval-editor-demo")
JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "anthropic:claude-sonnet-5-5")
EVIDENCE_LIMIT = 60_000
GIVEN_HISTORY_TURNS = 6


def _transcript(messages: list[BaseMessage]) -> list[dict]:
    rows = []
    for message in messages:
        row = {"role": message.type, "content": message.text}
        if isinstance(message, AIMessage) and message.tool_calls:
            row["tool_calls"] = [{"name": c["name"], "args": c["args"]} for c in message.tool_calls]
        rows.append(row)
    return rows


def _model_calls(messages: list[BaseMessage]) -> list[dict]:
    """Token usage per model call, for code checks like max_prompt_tokens. A judge can't see these numbers."""
    calls = []
    for message in messages:
        if not isinstance(message, AIMessage) or message.usage_metadata is None:
            continue
        usage = message.usage_metadata
        calls.append({"input_tokens": usage.get("input_tokens"), "output_tokens": usage.get("output_tokens"),
                      "tool_calls": len(message.tool_calls)})
    return calls


def _this_turn(messages: list[BaseMessage], inputs: dict) -> list[BaseMessage]:
    """The messages from the prompt on. Replayed history must not count as the agent's own work.

    Found by the prompt's own message rather than by counting history: an agent that summarizes a long thread
    returns fewer messages than it was given, and a count would then cut into this turn.
    """
    prompt = inputs["prompt"].strip()
    for index in range(len(messages) - 1, -1, -1):
        if isinstance(messages[index], HumanMessage) and messages[index].text.strip() == prompt:
            return messages[index:]
    return messages[len(inputs.get("history") or []):]


def _run_agent(inputs: dict, mocks: MockTools) -> list[BaseMessage]:
    # Pass history and context only when the test has them, so hooks written before they existed still work.
    extra = {key: inputs[key] for key in ("history", "context") if inputs.get(key)}
    return hook.run_agent(inputs["prompt"], mocks, **extra)


def target(inputs: dict) -> dict:
    """One run of one test: the agent answers the prompt with every tool call served from the test's mocks."""
    mocks = MockTools(inputs.get("mock_tools"), inputs.get("recorded_on"))
    messages = _run_agent(inputs, mocks)
    turn = _this_turn(messages, inputs)
    answer = next((m.text for m in reversed(turn) if isinstance(m, AIMessage) and m.text), "")
    return {"answer": answer, "tool_calls": mocks.calls, "unmocked_calls": mocks.unmocked,
            "model_calls": _model_calls(turn), "transcript": _transcript(turn)}


def code_checks(outputs: dict, reference_outputs: dict) -> dict:
    """Grades `outputs.checks` in code; each check becomes its own feedback key (see checks.py)."""
    checks = reference_outputs.get("checks") or []
    return {"results": run_checks(outputs, checks, custom=getattr(hook, "custom_check", None))}


def all_tools_mocked(outputs: dict) -> dict:
    unmocked = outputs.get("unmocked_calls") or []
    names = sorted({call["name"] for call in unmocked})
    return {"key": "all-tools-mocked", "score": int(not unmocked),
            "comment": f"Called without a mock: {', '.join(names)}" if names else "Every tool call was mocked."}


class Grade(BaseModel):
    name: str
    passed: bool | None
    reason: str


class Grades(BaseModel):
    grades: list[Grade]


JUDGE_PROMPT = """You are grading one run of an AI agent against a test's assertions.

Each assertion is a statement that should be true of the run. Judge it only from the evidence: what the agent
started from (`given`: its context and the end of the prior conversation), its final answer, its messages, and
its tool calls with their arguments and results. If the evidence does not show
that the assertion is true, it fails. Return one grade per assertion, using its name, with a one-sentence reason
that cites the evidence.

<assertions>
{assertions}
</assertions>

<evidence>
{evidence}
</evidence>"""


def _judge():
    # A hook may supply its own judge, e.g. to bill grading to the same test key its agent runs on.
    judge_model = getattr(hook, "judge_model", None)
    return judge_model() if judge_model else init_chat_model(JUDGE_MODEL)


def _judge_all(tests: list[dict], evidence: dict) -> list[Grade]:
    """The default grader: one judge call grades every assertion."""
    prompt = JUDGE_PROMPT.format(assertions=json.dumps(tests, indent=2),
                                 evidence=json.dumps(evidence, indent=2, default=str)[:EVIDENCE_LIMIT])
    return _judge().with_structured_output(Grades, method="json_schema").invoke(prompt).grades


def _given(inputs: dict) -> dict:
    """What the agent started from, so assertions like "left the other fields unchanged" are checkable.

    The context, plus the tail of the history: a long thread would crowd the run itself out of the evidence.
    """
    given = {"context": inputs.get("context") or {}}
    if inputs.get("history"):
        given["history_tail"] = inputs["history"][-GIVEN_HISTORY_TURNS:]
    return given


def assertions(inputs: dict, outputs: dict, reference_outputs: dict) -> dict:
    """Grades every assertion in one call; each becomes its own feedback key."""
    tests = [t for t in reference_outputs.get("assertions") or [] if t.get("name")]
    if not tests:
        return {"results": []}
    evidence = {"given": _given(inputs), **{k: outputs.get(k) for k in ("answer", "tool_calls", "transcript")}}
    # A hook may grade assertions its own way, e.g. with a cheap yes/no classifier that hands only the cases it
    # is unsure of to a chat model. It returns one {name, passed, reason} per assertion.
    grade_assertions = getattr(hook, "grade_assertions", None)
    grades = grade_assertions(tests, evidence) if grade_assertions else _judge_all(tests, evidence)
    by_name = {g.name: g for g in grades}
    return {"results": [
        {"key": t["name"], "score": _score(by_name[t["name"]]) if t["name"] in by_name else None,
         "comment": by_name[t["name"]].reason if t["name"] in by_name else "The judge returned no grade."}
        for t in tests]}


def _score(grade: Grade) -> int | None:
    # None means the grader couldn't decide (e.g. it was unreachable); it must not read as a pass or a fail.
    return None if grade.passed is None else int(grade.passed)


def test_name(example) -> str:
    return (example.metadata or {}).get("name") or str(example.id)[:8]


def run_test(example, repetitions: int = 3, client: Client | None = None) -> str:
    """Runs one test `repetitions` times as one experiment and returns the experiment's name."""
    name = test_name(example)
    results = evaluate(target, data=[example], evaluators=[all_tools_mocked, assertions, code_checks], client=client,
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
