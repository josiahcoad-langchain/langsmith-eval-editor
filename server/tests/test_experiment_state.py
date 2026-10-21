"""An experiment that has started but has no grades yet is not the test's result: the editor must keep showing the
last real one (and say a run is in progress), not "Never run"."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

TS = Path(__file__).resolve().parents[2] / "app" / "src" / "lib" / "experimentState.ts"
NOW = "2026-10-17T19:20:00Z"

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="needs Node to run the editor's TypeScript")


def _ts(function, experiment):
    script = (
        f"import {{ isResult, isRunning }} from {json.dumps(str(TS))};"
        f"const e = {json.dumps(experiment)};"
        f"console.log(JSON.stringify({function}));"
    )
    out = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def test_started_but_ungraded_is_not_a_result_and_is_running():
    # Given the experiment LangSmith listed at 19:10 with 3 runs and no grades yet
    started = {"start_time": "2026-10-17T19:10:31.657436", "end_time": None, "run_count": 3, "error_rate": 0,
               "feedback_stats": {}}

    # Then it is not a result, and it is running
    assert _ts("isResult(e)", started) is False
    assert _ts(f"isRunning(e, Date.parse({json.dumps(NOW)}))", started) is True


def test_graded_or_errored_is_a_result():
    assert _ts("isResult(e)", {"feedback_stats": {"must-call": {"n": 3, "avg": 1}}, "error_rate": 0}) is True
    assert _ts("isResult(e)", {"feedback_stats": {}, "error_rate": 1}) is True


def test_an_abandoned_ungraded_experiment_is_not_running_forever():
    abandoned = {"start_time": "2026-10-17T17:00:00", "end_time": None, "error_rate": 0, "feedback_stats": {}}
    assert _ts(f"isRunning(e, Date.parse({json.dumps(NOW)}))", abandoned) is False


def test_grades_are_rebuilt_from_the_runs_when_the_list_entry_lags():
    # Given the 2026-10-17 case: 3 runs graded 1 on every key, while the experiment's list entry said null
    run = {"status": "success", "feedback_stats": {k: {"n": 1, "avg": 1.0} for k in
                                                   ("numbers-come-from-the-data", "causes-not-stated-as-fact", "reads-the-stats")}}
    script = (
        f"import {{ statsFromRuns, isResult }} from {json.dumps(str(TS))};"
        f"const s = statsFromRuns({json.dumps([run, run, run])});"
        f"console.log(JSON.stringify({{s, result: isResult(s)}}));"
    )
    out = json.loads(subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
                                    capture_output=True, text=True, check=True).stdout)

    # Then it is a result: every key 3 of 3, nothing errored
    assert out["result"] is True
    assert out["s"]["error_rate"] == 0
    assert out["s"]["feedback_stats"]["reads-the-stats"] == {"n": 3, "avg": 1, "min": 1, "max": 1}


def test_an_errored_run_counts_toward_the_error_rate():
    script = (
        f"import {{ statsFromRuns }} from {json.dumps(str(TS))};"
        f"console.log(JSON.stringify(statsFromRuns([{{status: 'error', error: 'boom'}}, {{status: 'success', feedback_stats: {{a: {{avg: 0}}}}}}])));"
    )
    out = json.loads(subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
                                    capture_output=True, text=True, check=True).stdout)
    assert out["error_rate"] == 0.5 and out["feedback_stats"]["a"]["max"] == 0
