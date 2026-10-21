"""Why an assertion passed on some repetitions and failed on others: the agent, the judge, or the assertion.

The Re-grade check grades the SAME saved transcripts again, several times and with more than one judge, without
re-running the agent. That separates three causes that look identical in a "2/3":

    judge unreliable      one judge gave the same transcript different grades (or fresh grades disagree with the
                          original one). The judge, or an assertion it can't decide, is the noise.
    assertion ambiguous   each judge is self-consistent but they disagree on the same transcript: the assertion
                          can be read two ways.
    agent varied          every judge agrees, every time, per transcript, and the transcripts got different grades:
                          the agent really did different things across repetitions.

    grade overturned      every judge, every time, now gives the same grade, and it contradicts the original:
                          the grading at run time was broken or has changed since. Re-run; the agent is fine.

When everyone agrees on every repetition it is a plain pass or fail. Checked in this order, because a judge that
contradicts itself makes every other reading of the grades unreliable.

Input: one entry per repetition, {"original": bool | None, "regrades": {judge name: [bool | None, ...]}}.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

ADVICE = {
    "grade_overturned": (
        "Re-grading the same reply now gives a different, consistent answer from every judge, so the original grade "
        "was wrong: the grading at run time was broken or has changed since (a judge or its evidence). The agent "
        "is not the problem. Run the test again to replace the old grade."
    ),
    "judge_unreliable": (
        "The same reply got different grades, so the judge is the noise, not the agent. Make the assertion concrete "
        "and checkable from the reply or tool calls alone (names, numbers, exact behaviours), or grade it with a "
        "stronger judge. If it can be a code check, make it one."
    ),
    "assertion_ambiguous": (
        "Two judges read the same reply differently and each stuck to its reading, so the assertion can be read two "
        "ways. Reword it to say exactly what passes; compare the judges' reasons on the disputed repetition."
    ),
    "agent_varied": (
        "The judges agree with each other and with themselves, so the grades are right: the agent did different "
        "things across repetitions. Fix the agent (its prompt, tools or skill), using a failing repetition's reply "
        "as the example."
    ),
    "consistent_fail": (
        "Every judge fails every repetition, every time. Either the agent consistently does the wrong thing, or the "
        "assertion asks for something the agent shouldn't do. Read the reply: if it is right, fix the assertion."
    ),
    "consistent_pass": "Every judge passes every repetition, every time. Nothing to fix.",
}


@dataclass
class Diagnosis:
    cause: str
    advice: str
    # 1-based repetition numbers, for the UI
    failing_repetitions: list[int] = field(default_factory=list)
    disputed_repetitions: list[int] = field(default_factory=list)
    unreliable_judges: list[str] = field(default_factory=list)
    overturned_repetitions: list[int] = field(default_factory=list)


def diagnose(repetitions: list[dict[str, Any]]) -> Diagnosis:
    unreliable: set[str] = set()
    overturned: list[int] = []
    disputed: list[int] = []
    verdicts: list[bool] = []
    for number, rep in enumerate(repetitions, start=1):
        consensus = []
        for judge, grades in rep["regrades"].items():
            if None in grades or len(set(grades)) > 1:
                unreliable.add(judge)
                continue
            consensus.append(grades[0])
        # Every fresh grade agrees, and they contradict the original: the original grade was the odd one out.
        if consensus and len(consensus) == len(rep["regrades"]) and len(set(consensus)) == 1 \
                and rep["original"] is not None and consensus[0] != rep["original"]:
            overturned.append(number)
        if len(set(consensus)) > 1:
            disputed.append(number)
        verdicts.append(consensus[0] if consensus else bool(rep["original"]))

    failing = [i for i, passed in enumerate(verdicts, start=1) if not passed]
    if unreliable:
        cause = "judge_unreliable"
    elif overturned:
        cause = "grade_overturned"
    elif disputed:
        cause = "assertion_ambiguous"
    elif failing and len(failing) < len(verdicts):
        cause = "agent_varied"
    elif failing:
        cause = "consistent_fail"
    else:
        cause = "consistent_pass"
    return Diagnosis(cause=cause, advice=ADVICE[cause], failing_repetitions=failing,
                     disputed_repetitions=disputed, unreliable_judges=sorted(unreliable),
                     overturned_repetitions=overturned)
