"""Judge bench: pick the judge to grade assertions with, from evidence instead of taste.

    uv run python bench.py                    every labelled item, 3 grades per judge each
    uv run python bench.py --times 5          more repeats (sharper consistency)
    uv run python bench.py --unlabelled 20    no labels yet: also grade 20 recent assertions (consistency only)

Labels are what make a judge choosable. A label is a person saying what the right verdict was for one assertion
on one run: the editor's drill-down writes it as feedback `human-label` (score = the right verdict, value = the
assertion's name). Each labelled item is graded `times` times by every candidate judge, and each judge gets:

    accuracy      majority grade == label, over labelled items
    consistency   share of items where every repeat agreed (an undecided grade breaks agreement)
    undecided     share of single grades that came back None
    seconds       median time per grade

Consistency alone can't choose: a judge that always says "pass" is perfectly consistent. So the recommendation is
the FASTEST judge whose accuracy is within ACCURACY_SLACK of the best and whose consistency is at least
MIN_CONSISTENCY, and there is none without labels.

Candidates are the hook's `judges()` (what Re-grade compares) plus `bench_judges()` if it defines one (extra
candidates worth trying, e.g. a cheaper model or a classifier without its fallback).
"""

from __future__ import annotations

import argparse
import statistics
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

ACCURACY_SLACK = 0.01
MIN_CONSISTENCY = 0.95
LABEL_KEY = "human-label"


@dataclass
class Item:
    label: bool | None  # the right verdict, or None for an unlabelled item
    grades: dict[str, list[bool | None]]  # judge -> its repeated grades of this item
    seconds: dict[str, list[float]] = field(default_factory=dict)
    name: str = ""  # "<test> › <assertion>", for the report


@dataclass
class JudgeScore:
    judge: str
    labelled: int
    accuracy: float | None
    consistency: float
    undecided: float
    seconds: float


@dataclass
class Pick:
    judge: str | None
    reason: str


def score_judges(items: list[Item]) -> dict[str, JudgeScore]:
    judges = {judge for it in items for judge in it.grades}
    scores = {}
    for judge in sorted(judges):
        graded = [it for it in items if it.grades.get(judge)]
        labelled = [it for it in graded if it.label is not None]
        correct = sum(_majority(it.grades[judge]) == it.label for it in labelled)
        every = [g for it in graded for g in it.grades[judge]]
        times = [s for it in graded for s in it.seconds.get(judge, [])]
        scores[judge] = JudgeScore(
            judge=judge,
            labelled=len(labelled),
            accuracy=correct / len(labelled) if labelled else None,
            consistency=sum(None not in it.grades[judge] and len(set(it.grades[judge])) == 1 for it in graded) / len(graded) if graded else 0.0,
            undecided=sum(g is None for g in every) / len(every) if every else 0.0,
            seconds=statistics.median(times) if times else 0.0,
        )
    return scores


def recommend(scores: dict[str, JudgeScore]) -> Pick:
    rated = [s for s in scores.values() if s.accuracy is not None]
    if not rated:
        return Pick(None, "No labelled items yet: consistency alone can't pick a judge (one that always says pass is "
                          "perfectly consistent). Label a few verdicts in the editor's drill-down, then run again.")
    best = max(s.accuracy for s in rated)
    good = [s for s in rated if s.accuracy >= best - ACCURACY_SLACK and s.consistency >= MIN_CONSISTENCY]
    if not good:
        return Pick(None, f"No judge is both within {ACCURACY_SLACK:.0%} of the best accuracy ({best:.0%}) and at "
                          f"least {MIN_CONSISTENCY:.0%} consistent. Label more items, or try other judges.")
    pick = min(good, key=lambda s: s.seconds)
    return Pick(pick.judge, f"fastest judge within {ACCURACY_SLACK:.0%} of the best accuracy and at least "
                            f"{MIN_CONSISTENCY:.0%} consistent ({pick.accuracy:.0%} accurate, {pick.consistency:.0%} "
                            f"consistent, {pick.seconds:.1f}s per grade)")


def _majority(grades: list[bool | None]) -> bool | None:
    decided = [g for g in grades if g is not None]
    if not decided:
        return None
    return sum(decided) * 2 > len(decided)


# --- running it ----------------------------------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Compare judges on labelled (and optionally unlabelled) assertions.")
    ap.add_argument("--times", type=int, default=3, help="grades per judge per item (default 3)")
    ap.add_argument("--unlabelled", type=int, default=0, help="also grade this many recent unlabelled assertions")
    args = ap.parse_args(argv)

    from langsmith import Client

    import harness

    client = Client()
    judges = _candidates(harness.hook)
    targets = _labelled_targets(client) + _recent_targets(client, args.unlabelled)
    print(f"{len(targets)} items ({sum(t['label'] is not None for t in targets)} labelled) · "
          f"{len(judges)} judges · {args.times} grades each")
    items = _grade_all(targets, judges, args.times)
    scores = score_judges(items)
    _print(scores, recommend(scores), items)
    return 0


def _candidates(hook: Any) -> dict[str, Any]:
    import regrade

    judges = dict(regrade.judges())
    extra = getattr(hook, "bench_judges", None)
    if extra:
        judges.update(extra())
    return judges


def _labelled_targets(client: Any) -> list[dict[str, Any]]:
    targets = []
    for feedback in client.list_feedback(feedback_key=[LABEL_KEY]):
        if feedback.score is None or not feedback.value:
            continue
        targets.append({"run_id": feedback.run_id, "name": str(feedback.value), "label": feedback.score == 1})
    return targets


def _recent_targets(client: Any, count: int) -> list[dict[str, Any]]:
    """Recent graded assertions without a label: they measure consistency and agreement, not accuracy."""
    if count <= 0:
        return []
    import harness

    dataset = client.read_dataset(dataset_name=harness.DATASET_NAME)
    targets: list[dict[str, Any]] = []
    for project in client.list_projects(reference_dataset_id=dataset.id, limit=50):
        for run in client.list_runs(project_id=project.id, is_root=True, limit=3):
            if run.error or not (run.outputs or {}).get("transcript"):
                continue
            for feedback in client.list_feedback(run_ids=[run.id]):
                if feedback.key != LABEL_KEY and feedback.score is not None and len(targets) < count:
                    targets.append({"run_id": run.id, "name": feedback.key, "label": None})
        if len(targets) >= count:
            break
    return targets


def _grade_all(targets: list[dict[str, Any]], judges: dict[str, Any], times: int) -> list[Item]:
    from langsmith import Client

    import harness
    from evidence import build_evidence

    client = Client()
    prepared = []
    for target in targets:
        run = client.read_run(target["run_id"])
        example = client.read_example(run.reference_example_id)
        assertion = next((a for a in (example.outputs or {}).get("assertions") or [] if a.get("name") == target["name"]), None)
        if assertion is None:  # a code check, or an assertion since renamed
            continue
        evidence = build_evidence(run.inputs or {}, run.outputs or {}, harness.EVIDENCE_LIMIT)
        prepared.append((target, assertion, evidence, harness.test_name(example)))

    def grade(job: tuple[int, str]) -> tuple[bool | None, float]:
        index, judge = job
        _, assertion, evidence, _ = prepared[index]
        started = time.monotonic()
        grades = judges[judge]([{"name": assertion["name"], "assertion": assertion["assertion"]}], evidence)
        passed = next((g.passed for g in grades if g.name == assertion["name"]), None)
        return passed, time.monotonic() - started

    jobs = [(i, judge) for i in range(len(prepared)) for judge in judges for _ in range(times)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(grade, jobs))

    items = []
    for i, (target, assertion, _, test) in enumerate(prepared):
        mine = [(job, result) for job, result in zip(jobs, results, strict=True) if job[0] == i]
        items.append(Item(
            label=target["label"],
            grades={judge: [r[0] for (_, j), r in mine if j == judge] for judge in judges},
            seconds={judge: [r[1] for (_, j), r in mine if j == judge] for judge in judges},
            name=f"{test} › {assertion['name']}",
        ))
    return items


def _print(scores: dict[str, JudgeScore], pick: Pick, items: list[Item]) -> None:
    print(f"\n{'judge':<40} {'accuracy':>9} {'consistent':>11} {'undecided':>10} {'s/grade':>8}")
    for s in sorted(scores.values(), key=lambda s: (-(s.accuracy or 0), s.seconds)):
        accuracy = f"{s.accuracy:.0%} of {s.labelled}" if s.accuracy is not None else "no labels"
        print(f"{s.judge:<40} {accuracy:>9} {s.consistency:>10.0%} {s.undecided:>10.0%} {s.seconds:>8.1f}")
    print(f"\nRecommended: {pick.judge}. {pick.reason}" if pick.judge else f"\n{pick.reason}")
    wrong = [(it, j) for it in items if it.label is not None for j, g in it.grades.items() if _majority(g) != it.label]
    if wrong:
        print("\nWhere judges disagreed with a label:")
        for it, judge in wrong:
            print(f"  {it.name}: {judge} said {_majority(it.grades[judge])}, label {it.label}")


if __name__ == "__main__":
    raise SystemExit(main())
