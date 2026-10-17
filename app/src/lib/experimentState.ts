// Is a dataset experiment a result yet, or still running? LangSmith lists an experiment the moment it starts, with
// its runs counted before any grade lands, so "the newest experiment" alone can be one with nothing to show yet.
// Treating that as the test's result made a test with real results say "Never run" while someone (the CLI, CI,
// another editor) was running it. Self-contained (no imports) so server/tests/test_experiment_state.py can run it
// with plain Node.

type Experiment = Record<string, unknown>;

// How long an experiment with no grades still counts as running. Past this it was abandoned (a killed CLI run, a
// crashed server), and showing it as running forever would be a lie of its own.
export const RUNNING_FOR_AT_MOST_MS = 30 * 60 * 1000;

// A result is something graded: any feedback, or runs that errored (an errored run gets no grades, by design).
export function isResult(experiment: Experiment): boolean {
  const stats = experiment.feedback_stats;
  const graded = typeof stats === 'object' && stats !== null && Object.keys(stats).length > 0;
  const errorRate = typeof experiment.error_rate === 'number' ? experiment.error_rate : 0;
  return graded || errorRate > 0;
}

// An experiment's grades rebuilt from its runs' own grades, in the shape its list entry would carry
// (feedback_stats: {key: {n, avg, min, max}}, error_rate). The list entry's stats can lag the runs by many
// minutes: on 2026-10-17 an experiment graded in 15 s still listed `feedback_stats: null` 10 minutes later.
export function statsFromRuns(runs: Experiment[]): { feedback_stats: Record<string, Experiment>; error_rate: number } {
  const scores: Record<string, number[]> = {};
  for (const run of runs) {
    const stats = typeof run.feedback_stats === 'object' && run.feedback_stats !== null ? run.feedback_stats as Experiment : {};
    for (const [key, stat] of Object.entries(stats)) {
      const avg = typeof stat === 'object' && stat !== null ? (stat as Experiment).avg : undefined;
      if (typeof avg === 'number') (scores[key] ??= []).push(avg);
    }
  }
  const feedback_stats = Object.fromEntries(Object.entries(scores).map(([key, s]) => [key, {
    n: s.length, avg: s.reduce((a, b) => a + b, 0) / s.length, min: Math.min(...s), max: Math.max(...s),
  }]));
  const errored = runs.filter((run) => run.status === 'error' || Boolean(run.error)).length;
  return { feedback_stats, error_rate: runs.length ? errored / runs.length : 0 };
}

export function isRunning(experiment: Experiment, now: number): boolean {
  if (isResult(experiment) || experiment.end_time) return false;
  // LangSmith writes start_time without a zone, and it is UTC; Date.parse would read it as local time.
  const raw = String(experiment.start_time ?? '');
  const started = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`);
  return !Number.isNaN(started) && now - started < RUNNING_FOR_AT_MOST_MS;
}
