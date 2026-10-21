"""Per-test tool mocks, applied to a LangChain agent as middleware.

A test's `inputs.mock_tools` maps a tool name to what it returns:

    "get_order": {"id": "A1001", "total": 42.5}                  one response for any arguments
    "get_shipping_status": {"cases": [                            the first case whose `when` is a subset
        {"when": {"tracking": "1Z9"}, "response": {...}},          of the call's arguments wins; a case
        {"response": "unknown tracking number"}]}                  without `when` matches anything
    "issue_refund": {"raise": "503 Service Unavailable"}          the call fails with that message
    "generate_image": {"sequence": [{...}, {...}]}                a different response per call; the last repeats
    "update_post": {"cases": [                                    `when_any_value` matches that value under any
        {"when_any_value": "P1", "response": {"raise": "400"}},    argument name (and inside nested args)
        {"response": "saved"}]}

Replay is strict: a tool with no mock, or no matching case, never runs for real. The agent gets an error
ToolMessage ("<tool> is not mocked in this test") and the call is recorded in `unmocked`. The harness then
fails the whole run as an incomplete test (an error, not a grade), so a test can only produce grades if it
mocks everything the agent touched.

Dates in responses (strings that start with YYYY-MM-DD) move forward by the days between `recorded_on` and
today, so recorded data looks exactly as fresh on every run as it did the day it was recorded.
"""

from __future__ import annotations

import json
import re
import threading
from datetime import date, timedelta
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage

_ISO_DATE = re.compile(r"^(\d{4}-\d{2}-\d{2})(.*)$", re.S)


def shift_dates(value: Any, days: int) -> Any:
    if not days:
        return value
    if isinstance(value, dict):
        return {key: shift_dates(item, days) for key, item in value.items()}
    if isinstance(value, list):
        return [shift_dates(item, days) for item in value]
    if isinstance(value, str) and (match := _ISO_DATE.match(value)):
        try:
            return str(date.fromisoformat(match.group(1)) + timedelta(days=days)) + match.group(2)
        except ValueError:
            return value
    return value


class NotMocked(Exception):
    pass


def _case_matches(case: dict[str, Any], args: dict[str, Any]) -> bool:
    if not all(args.get(arg) == want for arg, want in (case.get("when") or {}).items()):
        return False
    # Matched on a value, not an argument name: a mocked tool can't pin its schema, so the model may send the
    # same record id as `post_id` on one run and `id` on the next.
    if "when_any_value" in case:
        return case["when_any_value"] in _all_values(args)
    return True


def _all_values(value: Any) -> list[Any]:
    if isinstance(value, dict):
        return [leaf for item in value.values() for leaf in _all_values(item)]
    if isinstance(value, list):
        return [leaf for item in value for leaf in _all_values(item)]
    return [value]


class MockTools:
    """One test's mocks. Create a fresh instance per run: it records the calls that run made."""

    def __init__(self, mocks: dict[str, Any] | None, recorded_on: str | None = None, today: date | None = None):
        self.mocks = mocks or {}
        recorded = date.fromisoformat(recorded_on) if recorded_on else None
        self.shift_days = ((today or date.today()) - recorded).days if recorded else 0
        self.calls: list[dict[str, Any]] = []
        self.unmocked: list[dict[str, Any]] = []
        # Tool calls from one model turn run in parallel threads; a sequence picks its response by counting calls.
        self._lock = threading.Lock()

    def respond(self, name: str, args: dict[str, Any]) -> Any:
        """The mocked response for one call. Raises NotMocked when the test has none for it."""
        if name not in self.mocks:
            raise NotMocked(f"{name} is not mocked in this test")
        mock = self.mocks[name]
        if isinstance(mock, dict) and set(mock) == {"sequence"}:
            if not mock["sequence"]:
                raise NotMocked(f"{name} has an empty sequence in this test")
            return shift_dates(self._next_in_sequence(name, mock["sequence"]), self.shift_days)
        if isinstance(mock, dict) and set(mock) == {"cases"}:
            for case in mock["cases"]:
                if _case_matches(case, args):
                    return shift_dates(case.get("response"), self.shift_days)
            raise NotMocked(f"{name} is not mocked in this test for arguments {json.dumps(args, sort_keys=True)}")
        return shift_dates(mock, self.shift_days)

    def _next_in_sequence(self, name: str, responses: list[Any]) -> Any:
        # The last response repeats so a test needn't predict the exact call count.
        index = sum(1 for call in self.calls if call["name"] == name)
        return responses[min(index, len(responses) - 1)]

    def call(self, name: str, args: dict[str, Any], tool_call_id: str) -> ToolMessage:
        with self._lock:
            return self._call(name, args, tool_call_id)

    def _call(self, name: str, args: dict[str, Any], tool_call_id: str) -> ToolMessage:
        try:
            response = self.respond(name, args)
        except NotMocked as error:
            self.unmocked.append({"name": name, "args": args})
            self.calls.append({"name": name, "args": args, "error": str(error), "mocked": False})
            return ToolMessage(str(error), tool_call_id=tool_call_id, name=name, status="error")
        if isinstance(response, dict) and set(response) == {"raise"}:
            self.calls.append({"name": name, "args": args, "error": str(response["raise"]), "mocked": True})
            return ToolMessage(str(response["raise"]), tool_call_id=tool_call_id, name=name, status="error")
        self.calls.append({"name": name, "args": args, "result": response, "mocked": True})
        content = response if isinstance(response, str) else json.dumps(response)
        return ToolMessage(content, tool_call_id=tool_call_id, name=name)

    def middleware(self) -> AgentMiddleware:
        """Answers every tool call from the mocks instead of running the tool."""
        return _MockMiddleware(self)


class _MockMiddleware(AgentMiddleware):
    def __init__(self, mocks: MockTools):
        super().__init__()
        self.mocks = mocks

    def wrap_tool_call(self, request, handler):
        call = request.tool_call
        return self.mocks.call(call["name"], call.get("args") or {}, call["id"])

    async def awrap_tool_call(self, request, handler):
        call = request.tool_call
        return self.mocks.call(call["name"], call.get("args") or {}, call["id"])
