"""Which hook module runs the agent under test.

`EVAL_HOOK` names it as an importable module path (default `hook`, the demo agent). Setting it lets another
project keep its hook in its own repo and run this harness from its own environment, e.g.

    EVAL_HOOK=tests.max_regressions.editor.hook PYTHONPATH=/path/to/eval-editor/server uv run python -m harness

A hook defines `TOOL_NAMES` and `run_agent(prompt, mocks, history=None, context=None)`, and may define
`custom_check(outputs, check) -> (passed, reason)` for checks of type `custom`, and either
`judge_model()` (the chat model that grades assertions; default JUDGE_MODEL) or
`grade_assertions(assertions, evidence) -> [Grade]` to replace assertion grading entirely. It may also define
`agent_context() -> {"instructions": str, "tools": [{"name", "description"}]}`, which Suggest assertions uses when a
test has no trace to read the agent's system prompt and tools from.
"""

from __future__ import annotations

import importlib
import os
from types import ModuleType


def load_hook() -> ModuleType:
    return importlib.import_module(os.environ.get("EVAL_HOOK", "hook"))
