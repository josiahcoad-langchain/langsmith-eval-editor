"""Judge bench metrics: which judge to trust, from labelled items graded several times by each."""

from bench import Item, recommend, score_judges


def item(label, **grades):
    return Item(label=label, grades=grades, seconds={judge: [1.0] * len(g) for judge, g in grades.items()})


ITEMS = [
    item(True, cheap=[True, True, True], strong=[True, True, True], flaky=[True, False, True]),
    item(False, cheap=[False, False, False], strong=[False, False, False], flaky=[False, False, True]),
    item(True, cheap=[False, False, False], strong=[True, True, True], flaky=[True, True, True]),
    item(False, cheap=[False, False, False], strong=[False, False, False], flaky=[None, False, False]),
]


def test_accuracy_is_the_majority_grade_against_the_label():
    scores = score_judges(ITEMS)
    assert scores["strong"].accuracy == 1.0
    assert scores["cheap"].accuracy == 0.75


def test_consistency_is_how_often_every_repeat_agreed():
    scores = score_judges(ITEMS)
    assert scores["strong"].consistency == 1.0
    assert scores["flaky"].consistency == 0.25  # only item 3 got the same answer every time
    assert scores["flaky"].undecided == 1 / 12


def test_unlabelled_items_count_toward_consistency_but_not_accuracy():
    scores = score_judges([item(None, a=[True, True]), item(True, a=[True, True])])
    assert scores["a"].labelled == 1 and scores["a"].accuracy == 1.0 and scores["a"].consistency == 1.0


def test_recommend_the_fastest_judge_that_is_both_accurate_and_consistent():
    scores = score_judges(ITEMS)
    scores["strong"].seconds = 3.0
    scores["cheap"].seconds = 0.2
    # cheap is fast but 25 points less accurate; flaky is inconsistent; strong is the pick
    assert recommend(scores).judge == "strong"
    scores["cheap"].accuracy = 1.0
    assert recommend(scores).judge == "cheap"


def test_no_recommendation_without_labels():
    scores = score_judges([item(None, a=[True, True])])
    pick = recommend(scores)
    assert pick.judge is None and "label" in pick.reason
