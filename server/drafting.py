"""Assertion drafts from the judge model: suggestions for a proposal, and rewrites of an assertion Re-grade found
ambiguous or unreliably graded.

Both are drafts for the expert, never saved on their own: the editor inserts them where the expert edits or deletes
them. Both use the judge model (harness._judge), so they bill where grading does.
"""

from __future__ import annotations

import json

from pydantic import BaseModel

import harness

MAX_DRAFTS = 4

RULES = """Each assertion is ONE sentence that a reader of the run's transcript and tool calls could check: what the
agent says, asks, refuses or calls. One claim per sentence (no "and" joining two claims). No vague words such as
"appropriate", "good", "properly" or "helpful": say what the agent does instead. Write in the present tense,
starting with "It" for the agent, e.g. "It asks for the order number before calling lookup_order." """

SUGGEST_PROMPT = """A subject-matter expert flagged a run of an AI agent. Draft {count} assertions for a regression
test: statements that must be true of a GOOD run for the same message. The flag's comment says what went wrong; the
assertions should say what the agent should have done instead, so today's reply fails at least one of them.

{rules}

Don't repeat these assertions, which the test already has:
<existing>
{existing}
</existing>

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


def suggest_assertions(prompt: str, reply: str, feedback: list[dict], existing: list[str]) -> list[str]:
    flag = "\n".join(f"{row.get('key') or 'feedback'} (score {row.get('score')}): {row.get('comment') or 'no comment'}"
                     for row in feedback) or "No comment: infer what went wrong from the reply."
    text = SUGGEST_PROMPT.format(count="2 to 4", rules=RULES, existing=json.dumps(existing) if existing else "none",
                                 prompt=prompt, reply=reply or "(no reply recorded)", feedback=flag)
    return _clean(_draft(text), existing)


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
