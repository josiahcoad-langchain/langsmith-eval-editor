import { useEffect, useState } from 'react';
import { Button } from '@langchain/macaw-components/Button';
import { Spinner } from '@langchain/macaw-components/Spinner';
import { errorMessage, fetchReasons, fetchResults, shortDate, text, type Json, type TestResult } from '../lib/data';
import { isWeb, requestRegrade, type Regrade } from '../runs';

// One assertion's (or code check's) grades on the test's newest run, each beside what the agent actually did, so
// "was the agent wrong, or the grade?" can be answered by reading. For an assertion, Re-grade grades the SAME saved
// transcripts again with every judge the hook offers and says which of agent, judge or assertion is the cause.

const CAUSE: Record<Regrade['cause'], { label: string; tone: string }> = {
  agent_varied: { label: 'The agent varied', tone: 'text-warning-primary' },
  judge_unreliable: { label: 'The judge is unreliable', tone: 'text-error-primary' },
  grade_overturned: { label: 'The original grade was wrong', tone: 'text-error-primary' },
  assertion_ambiguous: { label: 'The assertion is ambiguous', tone: 'text-warning-primary' },
  consistent_fail: { label: 'Fails every time, by every judge', tone: 'text-error-primary' },
  consistent_pass: { label: 'Passes every time, by every judge', tone: 'text-success-primary' },
};

export function AssertionDrilldown({ datasetId, exampleId, testName, name, kind, onClose }: {
  datasetId: string; exampleId: string; testName: string; name: string; kind: 'assertion' | 'check'; onClose: () => void;
}) {
  const [runs, setRuns] = useState<TestResult[] | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState('');
  const [regrade, setRegrade] = useState<Regrade | null>(null);
  const [regrading, setRegrading] = useState(false);
  const [regradeError, setRegradeError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetchResults(datasetId, exampleId, testName)
      .then((results) => {
        if (cancelled) return;
        // The newest experiment's repetitions, in order.
        const newest = results[0]?.experimentId;
        const reps = results.filter((r) => r.experimentId === newest).sort((a, b) => a.start.localeCompare(b.start));
        setRuns(reps);
        return fetchReasons(reps.map((r) => r.runId), name).then((next) => { if (!cancelled) setReasons(next); });
      })
      .catch((error) => { if (!cancelled) setLoadError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [datasetId, exampleId, testName, name]);

  const runRegrade = async () => {
    setRegrading(true);
    setRegradeError('');
    try {
      setRegrade(await requestRegrade(exampleId, name));
    } catch (error) {
      setRegradeError(errorMessage(error));
    } finally {
      setRegrading(false);
    }
  };

  return (
    <div className="flex flex-col gap-space-2 rounded-md border border-default bg-surface-level-2 p-space-3 text-xs">
      <div className="flex items-center justify-between gap-space-2">
        <span className="font-medium text-primary">
          <span className="font-mono">{name}</span> on the newest run{runs?.[0] ? ` (${shortDate(runs[0].start)})` : ''}
        </span>
        <button type="button" className="text-tertiary hover:text-primary" aria-label="Close" onClick={onClose}>✕</button>
      </div>

      {loadError ? <span className="text-error-primary">{loadError}</span> : null}
      {!runs && !loadError ? <Spinner size="sm" /> : null}
      {runs?.map((run, index) => {
        const grade = run.assertions.find((a) => a.key === name);
        const passed = grade?.score === 1;
        return (
          <div key={run.runId} className="flex flex-col gap-space-1 rounded-sm border border-default bg-surface-level-1 p-space-2">
            <div className="flex items-center gap-space-2">
              <span className="text-secondary">Repetition {index + 1}</span>
              {run.error ? <span className="text-error-primary">errored</span> : grade ? (
                <span className={passed ? 'text-success-primary' : 'text-error-primary'}>{passed ? '✓ passed' : grade.score === null ? '? undecided' : '✗ failed'}</span>
              ) : <span className="text-tertiary">not graded</span>}
            </div>
            {reasons[run.runId] || grade?.comment ? (
              <span className="text-secondary"><span className="text-tertiary">Judge: </span>{reasons[run.runId] || grade?.comment}</span>
            ) : null}
            {run.error ? <span className="text-error-primary">{run.error}</span> : null}
            {run.answer ? <span className="whitespace-pre-wrap text-primary"><span className="text-tertiary">Agent replied: </span>{run.answer}</span> : null}
            {run.toolCalls.length ? <ToolCalls calls={run.toolCalls} /> : <span className="text-tertiary">No tool calls.</span>}
          </div>
        );
      })}

      {kind === 'check' ? (
        <span className="text-tertiary">
          Code checks are deterministic: the same tool calls always grade the same. A mixed result means the agent made different calls across repetitions.
        </span>
      ) : isWeb() ? (
        <div className="flex flex-col gap-space-2">
          <div className="flex items-center gap-space-2">
            <Button size="sm" variant="outlined" color="secondary" onClick={() => void runRegrade()} disabled={regrading || !runs?.length}>
              {regrading ? 'Re-grading…' : 'Re-grade: is it the agent, the judge or the assertion?'}
            </Button>
            {regrading ? <Spinner size="sm" /> : null}
          </div>
          <span className="text-tertiary">Grades these same replies again, 3 times with each judge. Does not run the agent; costs only the judges.</span>
          {regradeError ? <span className="text-error-primary">{regradeError}</span> : null}
          {regrade ? <RegradeResult result={regrade} /> : null}
        </div>
      ) : (
        <span className="text-tertiary">Re-grade needs the eval server (web mode).</span>
      )}
    </div>
  );
}

function ToolCalls({ calls }: { calls: Json[] }) {
  return (
    <details>
      <summary className="cursor-pointer text-tertiary">Tool calls: {calls.map((c) => text(c.name)).join(', ')}</summary>
      <div className="mt-space-1 flex flex-col gap-space-1">
        {calls.map((call, index) => (
          <div key={index} className="rounded-sm bg-surface-level-2 p-space-1 font-mono">
            <div className={call.error ? 'text-error-primary' : 'text-primary'}>{text(call.name)}({clip(JSON.stringify(call.args ?? {}))})</div>
            <div className="text-tertiary">→ {clip(call.error ? text(call.error) : JSON.stringify(call.result ?? null))}</div>
          </div>
        ))}
      </div>
    </details>
  );
}

function RegradeResult({ result }: { result: Regrade }) {
  const cause = CAUSE[result.cause];
  const mark = (grade: boolean | null) => (grade === null ? '?' : grade ? '✓' : '✗');
  return (
    <div className="flex flex-col gap-space-2 rounded-sm border border-default bg-surface-level-1 p-space-2">
      <span className={`text-sm font-semibold ${cause.tone}`}>{cause.label}</span>
      <span className="text-secondary">{result.advice}</span>
      <table className="w-full text-left">
        <thead className="text-tertiary">
          <tr>
            <th className="pr-space-2 font-normal">Rep</th>
            <th className="pr-space-2 font-normal">Original</th>
            {result.judges.map((judge) => <th key={judge} className="pr-space-2 font-normal">{judge} ×{result.times}</th>)}
          </tr>
        </thead>
        <tbody className="font-mono">
          {result.repetitions.map((rep) => (
            <tr key={rep.number} className={result.disputed_repetitions.includes(rep.number) || result.overturned_repetitions.includes(rep.number) ? 'bg-warning-subtle' : ''}>
              <td className="pr-space-2">{rep.number}</td>
              <td className="pr-space-2">{mark(rep.original)}</td>
              {result.judges.map((judge) => (
                <td key={judge} className="pr-space-2" title={rep.reasons[judge]}>{(rep.regrades[judge] ?? []).map(mark).join(' ')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <span className="text-tertiary">Hover a judge's grades for its reason on that repetition.</span>
    </div>
  );
}

function clip(value: string, length = 300) {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}
