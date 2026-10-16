"""The hook: how the eval harness runs YOUR agent. This is the only file you change to test another agent.

`run_agent` gets one test's prompt and its mocks, runs the agent once with every tool call answered by the
mocks, and returns the conversation as LangChain messages. The harness does the rest: repetitions, grading
assertions, failing the run if the agent called a tool the test doesn't mock, and logging an experiment.

`TOOL_NAMES` feeds the editor's "Add mock" dropdown and decides which tool runs Import turns into mocks.

For a LangChain/LangGraph agent, pass `mocks.middleware()` into `create_agent(..., middleware=[...])`. For any
other agent, call `mocks.call(name, args, tool_call_id)` (or `mocks.respond(name, args)`) wherever the agent
executes a tool, and return the transcript as messages (AIMessage with tool_calls, ToolMessage, ...).
"""

from __future__ import annotations

from langchain_core.messages import BaseMessage

from demo_agent import TOOLS, build_agent
from mocks import MockTools

TOOL_NAMES = [t.name for t in TOOLS]


def run_agent(prompt: str, mocks: MockTools) -> list[BaseMessage]:
    agent = build_agent(middleware=[mocks.middleware()])
    result = agent.invoke({"messages": [{"role": "user", "content": prompt}]})
    return result["messages"]
