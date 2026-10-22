"""The hook: how the eval harness runs YOUR agent. This is the only file you change to test another agent.

`run_agent` gets one test's prompt and its mocks, runs the agent once with every tool call answered by the
mocks, and returns the conversation as LangChain messages. The harness does the rest: repetitions, grading
assertions and code checks, failing the run if the agent called a tool the test doesn't mock, and logging an
experiment.

`history` (prior turns as LangChain message dicts: [{role, content}], with `tool_calls` on assistant turns and
`role: "tool"` turns for their results) and `context` (the test's own JSON for setting the agent up) are
passed only when the test sets them. Return the history messages first, then this turn's, so the harness can
grade only what the agent did now. This demo agent has no use for `context`.

`TOOL_NAMES` feeds the editor's "Add mock" dropdown and decides which tool runs Import turns into mocks.

For a LangChain/LangGraph agent, pass `mocks.middleware()` into `create_agent(..., middleware=[...])`. For any
other agent, call `mocks.call(name, args, tool_call_id)` (or `mocks.respond(name, args)`) wherever the agent
executes a tool, and return the transcript as messages (AIMessage with tool_calls, ToolMessage, ...).

To keep a hook in another repo, set EVAL_HOOK to its module path (see agent_hook.py). A hook may also define
`custom_check(outputs, check) -> (passed, reason)` to grade checks of type `custom`.
"""

from __future__ import annotations

from typing import Any

from langchain_core.messages import BaseMessage

from demo_agent import INSTRUCTIONS, TOOLS, build_agent
from mocks import MockTools

TOOL_NAMES = [t.name for t in TOOLS]


def run_agent(prompt: str, mocks: MockTools, history: list[dict] | None = None,
              context: dict[str, Any] | None = None) -> list[BaseMessage]:
    agent = build_agent(middleware=[mocks.middleware()])
    messages = [*(history or []), {"role": "user", "content": prompt}]
    result = agent.invoke({"messages": messages})
    return result["messages"]


def agent_context() -> dict:
    """Optional: the agent's instructions and tools, for drafting assertions when a test has no trace to read them
    from (drafting.py). A flagged trace's own system prompt and tool definitions take precedence."""
    return {"instructions": INSTRUCTIONS, "tools": [{"name": t.name, "description": t.description} for t in TOOLS]}
