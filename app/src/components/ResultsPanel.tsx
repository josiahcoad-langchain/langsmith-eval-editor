import { useEffect, useState } from 'react';
import { Spinner } from '@langchain/macaw-components/Spinner';
import { Text } from '@langchain/macaw-components/Text';
import { duration, errorMessage, fetchResults, friendlyError, INTERNAL_KEYS, openTrace, shortDate, text, type Example, type TestResult } from '../lib/data';
import { fetchPending, type PendingRun } from '../runs';
import { ActionsMenu } from './ActionsMenu';
import { ErrorDetails } from './ErrorDetails';
import { RunCompare } from './RunCompare';

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

// The expert's own grades on a run: the harness's bookkeeping keys are never shown.
const grades = (run: TestResult) => run.assertions.filter((a) => !INTERNAL_KEYS.has(a.key));

// Third column: this test's runs, newest first, each a card with one line ("2 of 5 passed every time") and its
// repetitions (✓/✗, the answer). Compare, the trace and the LangSmith experiment are behind each ⋯; raw errors and
// tracebacks behind Details. Refreshed every 15 s while open so new results stream in.
export function ResultsPanel({ datasetId, example, workspaceId, onClose }: { datasetId: string; example: Example; workspaceId?: string; onClose: () => void }) {
  const [results, setResults] = useState<TestResult[] | null>(null);
  const [queued, setQueued] = useState<PendingRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openAnswer, setOpenAnswer] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // Compare: the first run picked from its ⋯, then the second picked from the list.
  const [picked, setPicked] = useState<string | null>(null);
  const [comparing, setComparing] = useState<[string, string] | null>(null);

  useEffect(() => {
    let alive = true;
    setResults(null);
    setError(null);
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
        if (alive) setChecking(false);
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

  const groups = results ? groupByExperiment(results) : [];
  // "Mar 3, 2:10 PM · repetition 2", so a comparison says which run is which.
  const runLabels = Object.fromEntries(groups.flatMap((group) => group.runs.map((run, index) => [run.runId, `${shortDate(group.start)} · repetition ${index + 1}`])));
  const byId = (id: string) => results?.find((r) => r.runId === id);
  const comparedRuns = comparing ? comparing.map(byId).filter((r): r is TestResult => Boolean(r)) : [];
  return (
    <aside className="flex min-h-0 flex-col gap-space-3 overflow-y-auto border-l border-default pl-space-4">
      <div className="flex items-center justify-between gap-space-2">
        <span className="flex items-center gap-space-2">
          <Text variant="md" weight="semibold">Results</Text>
          {checking ? <Spinner size="sm" /> : null}
        </span>
        <button type="button" aria-label="Close results" onClick={onClose} className="rounded-md px-space-2 text-tertiary hover:bg-surface-level-2 hover:text-primary">×</button>
      </div>
      {queued.map((run) => (
        <div key={run.requestedAt} className={`flex flex-col gap-px rounded-md border border-dashed p-space-3 ${run.state === 'error' ? 'border-error' : 'border-default'}`}>
          <span className="flex items-center gap-space-2">
            {run.state === 'running' ? <Spinner size="sm" /> : null}
            <Text variant="sm" weight="semibold">{run.state === 'running' ? 'Running' : run.state === 'error' ? 'Run failed' : 'Waiting to run'} · {shortDate(run.requestedAt)}</Text>
          </span>
          {run.state === 'error' ? <ErrorDetails error={run.detail} /> : null}
        </div>
      ))}
      {error ? <Text variant="xs" color="error">{error}</Text> : null}
      {!results && !error ? <div className="flex items-center gap-space-2"><Spinner size="sm" /><Text variant="xs" color="tertiary">Loading results…</Text></div> : null}
      {results && results.length === 0 && !queued.length ? <Text variant="xs" color="tertiary">Not run yet.</Text> : null}
      {picked ? (
        <div className="flex flex-wrap items-center gap-space-2 rounded-md bg-brand-subtle px-space-2 py-space-1 text-xs text-primary">
          <span>Pick another run to compare with {runLabels[picked]}.</span>
          <button type="button" className="text-secondary underline hover:text-primary" onClick={() => setPicked(null)}>Cancel</button>
        </div>
      ) : null}
      {comparedRuns.length === 2 ? <RunCompare runs={[comparedRuns[0], comparedRuns[1]]} labels={runLabels} onClose={() => setComparing(null)} /> : null}
      {groups.map((group) => {
        const running = group.runs.filter((r) => !r.end || r.status.toLowerCase() === 'pending').length;
        const errored = group.runs.filter((r) => r.error).length;
        // Graded on the repetitions that ran: an errored repetition has no grades, and never counts as a pass.
        const graded = group.runs.filter((r) => !r.error);
        const keys = [...new Set(graded.flatMap((r) => grades(r).map((a) => a.key)))];
        const holding = keys.filter((key) => graded.every((r) => (r.assertions.find((a) => a.key === key)?.score ?? 0) >= 1)).length;
        const reps = group.runs.length;
        const allErrored = errored === reps;
        const tone = allErrored || (keys.length && holding === 0) ? 'bg-error-subtle text-error-primary'
          : holding === keys.length && !errored ? 'bg-success-subtle text-success-primary' : 'bg-warning-subtle text-warning-primary';
        const badge = allErrored
          ? `${friendlyError(group.runs[0].error)}`
          : `${holding} of ${keys.length} passed${reps > 1 ? ' every time' : ''}${errored ? ` · ${errored} couldn't run` : ''}`;
        return (
          <div key={group.experimentId} className="flex flex-col gap-space-2 rounded-md border border-default bg-surface-level-1 p-space-3">
            <div className="flex items-start justify-between gap-space-2">
              <div className="flex min-w-0 flex-col gap-space-1">
                <Text variant="sm" weight="semibold">{shortDate(group.start)}</Text>
                {running ? (
                  <span className="flex items-center gap-space-1 text-xs text-tertiary"><Spinner size="sm" />{running} running</span>
                ) : keys.length || allErrored ? (
                  <span className={`w-fit rounded-sm px-space-1 text-xs font-medium ${tone}`}>{badge}</span>
                ) : null}
              </div>
              {workspaceId ? (
                <ActionsMenu label="Run actions" compact items={[{
                  label: 'Open in LangSmith',
                  onSelect: () => window.langsmith.openUrl(`/o/${workspaceId}/datasets/${datasetId}/compare?selectedSessions=${group.experimentId}`, { newTab: true }),
                }]} />
              ) : null}
            </div>
            <div className="flex flex-col gap-space-1 border-t border-default pt-space-2">
              {group.runs.map((result, index) => {
                const scored = grades(result).filter((a) => a.score !== null);
                const passed = !result.error && scored.every((a) => (a.score ?? 0) >= 1);
                const isRunning = !result.end || result.status.toLowerCase() === 'pending';
                const pickable = picked !== null && picked !== result.runId;
                return (
                  <div key={result.runId} className="group flex flex-col gap-space-1">
                    <div className="flex items-center gap-x-space-2 text-xs">
                      <span className={`w-4 text-center font-medium ${isRunning ? 'text-tertiary' : passed ? 'text-success-primary' : 'text-error-primary'}`}>
                        {isRunning ? '…' : passed ? '✓' : '✗'}
                      </span>
                      <span className="shrink-0 whitespace-nowrap text-secondary">Repetition {index + 1}</span>
                      {result.error ? (allErrored ? null : <span className="min-w-0 truncate text-error-primary">{friendlyError(result.error)}</span>)
                        : result.end && !isRunning ? <span className="text-tertiary">{duration(result.start, result.end)}</span> : null}
                      {result.answer ? (
                        <button type="button" className="text-secondary underline hover:text-primary" onClick={() => setOpenAnswer(openAnswer === result.runId ? null : result.runId)}>
                          {openAnswer === result.runId ? 'Hide answer' : 'Answer'}
                        </button>
                      ) : null}
                      <span className="flex-1" />
                      {pickable ? (
                        <button type="button" className="rounded-sm border border-focus px-space-2 text-primary"
                          onClick={() => { setComparing([picked, result.runId]); setPicked(null); }}>Compare</button>
                      ) : (
                        // Shown on hover (or keyboard focus): every repetition has one, and they'd crowd the card.
                        <span className="opacity-0 focus-within:opacity-100 group-hover:opacity-100">
                          <ActionsMenu label={`Repetition ${index + 1} actions`} compact items={[
                            ...(results && results.length > 1 ? [{ label: 'Compare…', onSelect: () => setPicked(result.runId) }] : []),
                            { label: 'Trace', onSelect: () => void showTrace(result) },
                          ]} />
                        </span>
                      )}
                    </div>
                    {result.error ? <ErrorDetails error={result.error} traceback={result.traceback} /> : null}
                    {openAnswer === result.runId ? (
                      <p className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface-level-2 p-space-2 text-xs text-primary">{result.answer}</p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </aside>
  );
}
