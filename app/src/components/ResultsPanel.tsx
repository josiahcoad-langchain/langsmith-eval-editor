import { useEffect, useState } from 'react';
import { Spinner } from '@langchain/macaw-components/Spinner';
import { Text } from '@langchain/macaw-components/Text';
import { duration, errorMessage, fetchResults, isRecord, openTrace, shortDate, text, type Example, type TestResult } from '../lib/data';
import { fetchPending, type PendingRun } from '../runs';

type ExperimentGroup = { experimentId: string; experimentName: string; start: string; runs: TestResult[] };

// Repetitions of one test run land in the same experiment; group them, newest experiment first, repetitions in order.
function groupByExperiment(results: TestResult[]): ExperimentGroup[] {
  const groups = new Map<string, ExperimentGroup>();
  for (const result of results) {
    const group = groups.get(result.experimentId) ?? { experimentId: result.experimentId, experimentName: result.experimentName, start: result.start, runs: [] };
    group.runs.push(result);
    if (result.start < group.start) group.start = result.start;
    groups.set(result.experimentId, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, runs: [...group.runs].sort((a, b) => a.start.localeCompare(b.start)) }))
    .sort((a, b) => b.start.localeCompare(a.start));
}

// Third column: this test's experiments, newest first, each with its repetitions and per-assertion pass rates across
// them; refreshed every 15 s while open so new results stream in.
export function ResultsPanel({ datasetId, example, workspaceId, onClose }: { datasetId: string; example: Example; workspaceId?: string; onClose: () => void }) {
  const [results, setResults] = useState<TestResult[] | null>(null);
  const [queued, setQueued] = useState<PendingRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openAnswer, setOpenAnswer] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // A one-second tick so "Checked N s ago" visibly counts up between refreshes.
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    let alive = true;
    setResults(null);
    setError(null);
    setCheckedAt(null);
    const refresh = async () => {
      setChecking(true);
      try {
        const next = await fetchResults(datasetId, example.id, text(example.metadata.name));
        const pending = await fetchPending(example.id, next[0]?.start ?? '');
        if (!alive) return;
        setResults(next);
        setQueued(pending);
        setError(null);
      } catch (err) {
        if (alive) setError(errorMessage(err));
      } finally {
        if (alive) {
          setChecking(false);
          setCheckedAt(Date.now());
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [datasetId, example.id]);

  const showTrace = async (result: TestResult) => {
    try {
      await openTrace(result);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const checkNames = new Set(Array.isArray(example.outputs.checks) ? example.outputs.checks.map((row) => (isRecord(row) ? text(row.name) : '')) : []);
  return (
    <aside className="flex min-h-0 flex-col gap-space-3 overflow-y-auto border-l border-default pl-space-4">
      <div className="flex items-start justify-between gap-space-2">
        <div className="flex flex-col">
          <Text variant="md" weight="semibold">Results</Text>
          <div className="flex items-center gap-space-1">
            {checking ? <Spinner size="sm" /> : null}
            <Text variant="xs" color="tertiary">
              {checking
                ? 'Checking for results…'
                : checkedAt
                  ? `Checked ${Math.max(0, Math.round((now - checkedAt) / 1000))} s ago · next in ${Math.max(0, 15 - Math.round((now - checkedAt) / 1000))} s`
                  : 'Updates every 15 s'}
            </Text>
          </div>
        </div>
        <button type="button" aria-label="Close results" onClick={onClose} className="rounded-md px-space-2 text-tertiary hover:bg-surface-level-2 hover:text-primary">×</button>
      </div>
      {queued.map((run) => (
        <div key={run.requestedAt} className={`flex flex-col gap-px rounded-md border border-dashed p-space-3 ${run.state === 'error' ? 'border-error' : 'border-default'}`}>
          <span className="flex items-center gap-space-2">
            {run.state === 'running' ? <Spinner size="sm" /> : null}
            <Text variant="sm" weight="semibold">{run.state === 'running' ? 'Running' : run.state === 'error' ? 'Run failed' : 'Requested'} · {shortDate(run.requestedAt)}</Text>
          </span>
          <Text variant="xs" color={run.state === 'error' ? 'error' : 'tertiary'}>{run.detail}</Text>
        </div>
      ))}
      {error ? <Text variant="xs" color="error">{error}</Text> : null}
      {!results && !error ? <div className="flex items-center gap-space-2"><Spinner size="sm" /><Text variant="xs" color="tertiary">Loading results…</Text></div> : null}
      {results && results.length === 0 && !queued.length ? <Text variant="xs" color="tertiary">No runs of this test yet. Click Run test.</Text> : null}
      {results ? groupByExperiment(results).map((group) => {
        // The test's own assertions, then its code checks.
        // Code checks (outputs.checks) log feedback exactly like assertions, so they are told apart by name and listed last.
        const rank = (key: string) => (checkNames.has(key) ? 2 : 1);
        const keys = [...new Set(group.runs.flatMap((r) => r.assertions.map((a) => a.key)))].sort((a, b) => rank(a) - rank(b));
        const running = group.runs.filter((r) => !r.end || r.status.toLowerCase() === 'pending').length;
        const rows = keys.map((key) => {
          const scores = group.runs.map((r) => r.assertions.find((a) => a.key === key)?.score ?? null).filter((v): v is number => v !== null);
          const passed = scores.filter((v) => v >= 1).length;
          return { key, passed, scored: scores.length, comment: group.runs.map((r) => r.assertions.find((a) => a.key === key)?.comment).find(Boolean) ?? '' };
        });
        const graded = rows.filter((row) => row.scored);
        // An assertion holds only if it passed on every repetition; one that passed on some is flaky.
        const holding = graded.filter((row) => row.passed === row.scored).length;
        const tone = holding === graded.length ? 'bg-success-subtle text-success-primary' : holding === 0 ? 'bg-error-subtle text-error-primary' : 'bg-warning-subtle text-warning-primary';
        const reps = group.runs.length;
        return (
          <div key={group.experimentId} className="flex flex-col gap-space-2 rounded-md border border-default bg-surface-level-1 p-space-3">
            <div className="flex items-start justify-between gap-space-2">
              <div className="flex min-w-0 flex-col">
                <Text variant="sm" weight="semibold">{shortDate(group.start)}</Text>
                <span className="truncate text-xs text-tertiary">{group.experimentName} · {reps} repetition{reps === 1 ? '' : 's'}</span>
              </div>
              {running ? (
                <span className="flex items-center gap-space-1 text-xs text-tertiary"><Spinner size="sm" />{running} running</span>
              ) : graded.length ? (
                <span className={`shrink-0 rounded-sm px-space-1 text-xs font-medium ${tone}`}>
                  {holding} of {graded.length} {graded.length === 1 ? 'check' : 'checks'} passed{reps > 1 ? ' every run' : ''}
                </span>
              ) : null}
            </div>
            {rows.length ? (
              <ul className="flex flex-col gap-px">
                {rows.map((row) => {
                  const tone = !row.scored ? 'text-tertiary' : row.passed === row.scored ? 'text-success-primary' : row.passed === 0 ? 'text-error-primary' : 'text-warning-primary';
                  return (
                    <li key={row.key} className="flex items-baseline gap-space-2 text-xs" title={row.comment || undefined}>
                      <span className={`w-9 shrink-0 text-right font-medium ${tone}`}>{row.scored ? (reps > 1 ? `${row.passed} of ${row.scored}` : row.passed ? '✓' : '✗') : '–'}</span>
                      <span className="font-mono text-primary">{row.key}</span>
                      {checkNames.has(row.key) ? <span className="rounded-sm border border-default px-space-1 text-tertiary">code check</span> : null}
                      {row.scored && row.passed > 0 && row.passed < row.scored ? <span className="text-warning-primary">flaky</span> : null}
                    </li>
                  );
                })}
              </ul>
            ) : running ? <Text variant="xs" color="tertiary">Grading starts as each repetition finishes.</Text> : null}
            <div className="flex flex-col gap-space-1 border-t border-default pt-space-2">
              {group.runs.map((result, index) => {
                const scored = result.assertions.filter((a) => a.score !== null);
                const passed = scored.filter((a) => (a.score ?? 0) >= 1).length;
                const isRunning = !result.end || result.status.toLowerCase() === 'pending';
                return (
                  <div key={result.runId} className="flex flex-col gap-space-1">
                    <div className="flex flex-wrap items-baseline gap-x-space-2 text-xs">
                      <span className="text-secondary">Repetition {index + 1}</span>
                      <span className="text-tertiary">
                        {isRunning ? 'running' : result.error ? 'error' : `${passed} of ${scored.length} ${scored.length === 1 ? 'check' : 'checks'} passed${result.end ? ` · ${duration(result.start, result.end)}` : ''}`}
                      </span>
                      {result.answer ? (
                        <button type="button" className="text-secondary underline hover:text-primary" onClick={() => setOpenAnswer(openAnswer === result.runId ? null : result.runId)}>
                          {openAnswer === result.runId ? 'Hide answer' : 'Answer'}
                        </button>
                      ) : null}
                      <button type="button" className="text-secondary underline hover:text-primary" onClick={() => void showTrace(result)}>Trace</button>
                    </div>
                    {result.error ? <Text variant="xs" color="error">{result.error}</Text> : null}
                    {result.traceback ? (
                      <details className="text-xs text-tertiary">
                        <summary className="cursor-pointer">Show traceback</summary>
                        <pre className="mt-space-1 max-h-60 overflow-auto whitespace-pre-wrap font-mono">{result.traceback}</pre>
                      </details>
                    ) : null}
                    {openAnswer === result.runId ? (
                      <p className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface-level-2 p-space-2 text-xs text-primary">{result.answer}</p>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {workspaceId ? (
              <button type="button" className="w-fit text-xs text-secondary underline hover:text-primary"
                onClick={() => window.langsmith.openUrl(`/o/${workspaceId}/datasets/${datasetId}/compare?selectedSessions=${group.experimentId}`, { newTab: true })}>
                Open experiment
              </button>
            ) : null}
          </div>
        );
      }) : null}
    </aside>
  );
}
