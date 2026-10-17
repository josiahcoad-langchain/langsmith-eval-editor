"""Why an assertion's result varied: the agent, the judge, or the assertion itself."""

from diagnose import diagnose


def rep(original, **judges):
    return {"original": original, "regrades": judges}


def test_judges_consistent_but_repetitions_differ_means_the_agent_varied():
    # Every judge gives the same grade every time on each transcript, and agrees with the others;
    # the transcripts themselves passed and failed differently.
    result = diagnose([
        rep(True, a=[True, True, True], b=[True, True, True]),
        rep(False, a=[False, False, False], b=[False, False, False]),
    ])
    assert result.cause == "agent_varied"
    assert result.failing_repetitions == [2]


def test_the_same_transcript_graded_differently_means_the_judge_is_unreliable():
    result = diagnose([
        rep(True, a=[True, False, True], b=[True, True, True]),
        rep(True, a=[True, True, True], b=[True, True, True]),
    ])
    assert result.cause == "judge_unreliable"
    assert result.unreliable_judges == ["a"]


def test_judges_each_consistent_but_disagreeing_means_the_assertion_is_ambiguous():
    result = diagnose([
        rep(True, a=[True, True, True], b=[False, False, False]),
        rep(True, a=[True, True, True], b=[True, True, True]),
    ])
    assert result.cause == "assertion_ambiguous"
    assert result.disputed_repetitions == [1]


def test_everyone_agrees_it_fails_every_time():
    result = diagnose([rep(False, a=[False] * 3, b=[False] * 3), rep(False, a=[False] * 3, b=[False] * 3)])
    assert result.cause == "consistent_fail"


def test_everyone_agrees_it_passes_every_time():
    assert diagnose([rep(True, a=[True] * 3, b=[True] * 3)]).cause == "consistent_pass"


def test_undecided_grades_count_as_unreliable_not_as_either_answer():
    assert diagnose([rep(True, a=[True, None, True], b=[True] * 3)]).cause == "judge_unreliable"


def test_every_cause_comes_with_advice():
    assert diagnose([rep(False, a=[False] * 3, b=[False] * 3)]).advice


def test_fresh_grades_that_agree_but_contradict_the_original_mean_the_original_was_wrong():
    # Every judge now passes the same reply, every time, but it was originally failed: the grading at run time
    # was broken or has since changed (e.g. its evidence was cut off). Re-run; nothing in the agent to fix.
    result = diagnose([
        rep(True, a=[True] * 3, b=[True] * 3),
        rep(False, a=[True] * 3, b=[True] * 3),
    ])
    assert result.cause == "grade_overturned"
    assert result.overturned_repetitions == [2]
