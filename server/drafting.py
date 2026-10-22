"""Assertion drafts from the judge model: suggestions for a proposal, and rewrites of an assertion Re-grade found
ambiguous or unreliably graded.

Both are drafts for the expert, never saved on their own: the editor inserts them where the expert edits or deletes
them. Both use the judge model (harness._judge), so they bill where grading does.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from langsmith import Client
from pydantic import BaseModel

import harness

log = logging.getLogger("drafting")
# Characters per section of the drafting prompt. Generous: the drafts are only as good as what the model knows
# about the agent's rules and the conversation.
SECTION_LIMIT = 20_000

MAX_DRAFTS = 4

RULES = """Each assertion is ONE sentence that a reader of the run's transcript and tool calls could check: what the
agent says, asks, refuses or calls. One claim per sentence (no "and" joining two claims). No vague words such as
"appropriate", "good", "properly" or "helpful": say what the agent does instead. Write in the present tense,
starting with "It" for the agent, e.g. "It asks for the order number before calling lookup_order." """

SUGGEST_PROMPT = """A subject-matter expert flagged a run of an AI agent. Draft {count} assertions for a regression
test: statements that must be true of a GOOD run for the same message. The flag's comment says what went wrong; the
assertions should say what the agent should have done instead, so today's reply fails at least one of them.

Judge "good" by the agent's own instructions and tools below, not by what it happened to do: the original reply is
the run that was flagged, so it may be exactly the behavior to rule out. Prefer the rules in the instructions that
apply to this message and these tool results.

{rules}

Don't repeat these assertions, which the test already has:
<existing>
{existing}
</existing>

<agent_instructions>
{instructions}
</agent_instructions>

<agent_tools>
{tools}
</agent_tools>

<conversation_before_the_message>
{history}
</conversation_before_the_message>

<what_the_tools_returned_in_this_run>
{tool_results}
</what_the_tools_returned_in_this_run>

<message>
{prompt}
</message>

<original_reply>
{reply}
</original_reply>

<flag>
{feedback}
</flag>"""

REWRITE_PROMPT = """An assertion in a test of an AI agent is graded inconsistently: {diagnosis}. Rewrite it so that
every careful judge would grade the same reply the same way. Keep what it is checking; make it precise. Use the
reasons below to see where readers split. Return 1 or 2 rewrites; if it checks two things, a rewrite may keep only
the claim the reasons are about.

{rules}

<assertion>
{assertion}
</assertion>

<expert_reasons why the judge was wrong>
{expert_reasons}
</expert_reasons>

<judge_reasons>
{judge_reasons}
</judge_reasons>"""

DIAGNOSES = {
    "assertion_ambiguous": "each judge is consistent with itself, but different judges read the same reply differently",
    "judge_unreliable": "the same judge gave the same reply different grades",
}


class Drafts(BaseModel):
    assertions: list[str]


def suggest_assertions(prompt: str, reply: str, feedback: list[dict], existing: list[str], history: list[dict] | None = None,
                       mocks: dict | None = None, trace_id: str = "") -> list[str]:
    flag = "\n".join(f"{row.get('key') or 'feedback'} (score {row.get('score')}): {row.get('comment') or 'no comment'}"
                     for row in feedback) or "No comment: infer what went wrong from the reply."
    agent = agent_context(trace_id)
    text = SUGGEST_PROMPT.format(
        count="2 to 4", rules=RULES, existing=json.dumps(existing) if existing else "none",
        instructions=_clip(agent["instructions"]) or "(not available)",
        tools=_clip("\n".join(f"- {t['name']}: {t.get('description', '')}" for t in agent["tools"])) or "(not available)",
        history=_clip(_conversation(history or [])) or "(none: the message starts the conversation)",
        tool_results=_clip(json.dumps(mocks, indent=1, default=str)) if mocks else "(none)",
        prompt=prompt, reply=reply or "(no reply recorded)", feedback=flag)
    return _clean(_draft(text), existing)


def agent_context(trace_id: str = "") -> dict[str, Any]:
    """The agent's system prompt and tool definitions: from the flagged trace's first model call, which shows them
    exactly as they were that day, else from the hook's optional `agent_context()`."""
    found = _from_trace(trace_id) if trace_id else None
    if found and (found["instructions"] or found["tools"]):
        return found
    provide = getattr(harness.hook, "agent_context", None)
    if provide:
        given = provide() or {}
        return {"instructions": given.get("instructions", ""), "tools": list(given.get("tools", []))}
    return {"instructions": "", "tools": [{"name": name} for name in getattr(harness.hook, "TOOL_NAMES", [])]}


def _from_trace(trace_id: str) -> dict[str, Any] | None:
    try:
        runs = Client().request_with_retries("POST", "/runs/query", json={
            "trace": trace_id, "run_type": "llm", "limit": 5, "select": ["inputs", "extra", "start_time"]}).json().get("runs", [])
    except Exception:  # noqa: BLE001 - a draft without the agent's rules beats no draft
        log.exception("could not read trace %s", trace_id)
        return None
    if not runs:
        return None
    first = min(runs, key=lambda run: run.get("start_time") or "")
    return {"instructions": _system_prompt(first.get("inputs") or {}),
            "tools": [_tool(t) for t in ((first.get("extra") or {}).get("invocation_params") or {}).get("tools") or []]}


def _system_prompt(inputs: dict) -> str:
    messages = inputs.get("messages") or []
    if messages and isinstance(messages[0], list):  # chat models trace a batch: [[message, ...]]
        messages = messages[0]
    texts = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        body = message.get("kwargs") if isinstance(message.get("kwargs"), dict) else message
        kind = str(body.get("type") or body.get("role") or (message.get("id") or [""])[-1]).lower()
        if "system" in kind:
            content = body.get("content")
            texts.append(content if isinstance(content, str) else " ".join(
                part.get("text", "") for part in content or [] if isinstance(part, dict)))
    return "\n\n".join(t for t in texts if t)


def _tool(raw: dict) -> dict[str, str]:
    """A tool definition in Anthropic ({name, description}) or OpenAI ({function: {name, description}}) shape."""
    spec = raw.get("function") if isinstance(raw.get("function"), dict) else raw
    return {"name": str(spec.get("name", "")), "description": str(spec.get("description", ""))}


def _conversation(history: list[dict]) -> str:
    lines = []
    for turn in history:
        role = turn.get("role", "?")
        if turn.get("tool_calls"):
            calls = ", ".join(f"{c.get('name')}({json.dumps(c.get('args', {}))})" for c in turn["tool_calls"])
            lines.append(f"{role}: {turn.get('content') or ''} [called {calls}]".strip())
        else:
            lines.append(f"{role}: {turn.get('content') or ''}")
    return "\n".join(lines)


def _clip(text: str) -> str:
    return text if len(text) <= SECTION_LIMIT else text[:SECTION_LIMIT] + "\n…(cut)"


def rewrite_assertion(assertion: str, cause: str, expert_reasons: list[str], judge_reasons: list[str]) -> list[str]:
    text = REWRITE_PROMPT.format(
        diagnosis=DIAGNOSES.get(cause, "judges disagree about it"), rules=RULES, assertion=assertion,
        expert_reasons="\n".join(f"- {r}" for r in expert_reasons if r.strip()) or "none given",
        judge_reasons="\n".join(f"- {r}" for r in judge_reasons if r.strip()) or "none given")
    return _clean(_draft(text), [assertion])[:2]


def _draft(prompt: str) -> list[str]:
    return harness._judge().with_structured_output(Drafts, method="json_schema").invoke(prompt).assertions


def _clean(drafts: list[str], existing: list[str]) -> list[str]:
    """Trimmed, one per line, no repeats of each other or of what's there, at most MAX_DRAFTS."""
    seen = {e.strip().lower() for e in existing}
    kept = []
    for draft in drafts:
        sentence = " ".join(draft.split())
        if sentence and sentence.lower() not in seen:
            seen.add(sentence.lower())
            kept.append(sentence)
    return kept[:MAX_DRAFTS]
