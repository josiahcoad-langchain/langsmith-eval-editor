import { useEffect, useState } from 'react';
import { Button } from '@langchain/macaw-components/Button';
import { Spinner } from '@langchain/macaw-components/Spinner';
import { errorMessage, fetchLabels, fetchReasons, fetchResults, friendlyError, mockGaps, openTrace, saveLabel, shortDate, type Label, type MockGap, type TestResult } from '../lib/data';
import { ErrorDetails } from './ErrorDetails';
import { isWeb, requestRegrade, requestRewrites, type Regrade } from '../runs';
import { Markdown } from './Markdown';
import { clip, ToolCalls } from './ToolCalls';

// One assertion's (or code check's) grades on the test's newest run, each beside what the agent actually did, so
// "was the agent wrong, or the grade?" can be answered by reading. When the repetitions disagree, "Why is this
// inconsistent?" (Re-grade, web mode) grades the SAME saved transcripts again with every judge the hook offers and
// says which of agent, judge or assertion is the cause.

const REWRITABLE: Regrade['cause'][] = ['assertion_ambiguous', 'judge_unreliable'];

const CAUSE: Record<Regrade['cause'], { label: string; tone: string }> = {
  agent_varied: { label: 'The agent varied', tone: 'text-warning-primary' },
  judge_unreliable: { label: 'The judge is unreliable', tone: 'text-error-primary' },
  grade_overturned: { label: 'The original grade was wrong', tone: 'text-error-primary' },
  assertion_ambiguous: { label: 'The assertion is ambiguous', tone: 'text-warning-primary' },
  consistent_fail: { label: 'Fails every time, by every judge', tone: 'text-error-primary' },
  consistent_pass: { label: 'Passes every time, by every judge', tone: 'text-success-primary' },
};

export function AssertionDrilldown({ datasetId, exampleId, testName, name, kind, onClose, onAddMock, onRewrite }: {
  datasetId: string; exampleId: string; testName: string; name: string; kind: 'assertion' | 'check'; onClose: () => void;
  onAddMock?: (gap: MockGap) => void;
  // Replaces the assertion's sentence in the draft (its name stays, so its results stay together).
  onRewrite?: (assertion: string) => void;
}) {
  const [runs, setRuns] = useState<TestResult[] | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [labels, setLabels] = useState<Record<string, Label>>({});
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
        const ids = reps.map((r) => r.runId);
        return Promise.all([fetchReasons(ids, name), fetchLabels(ids, name)]).then(([nextReasons, nextLabels]) => {
          if (!cancelled) { setReasons(nextReasons); setLabels(nextLabels); }
        });
      })
      .catch((error) => { if (!cancelled) setLoadError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [datasetId, exampleId, testName, name]);

  const runRegrade = async () => {
    setRegrading(true);
    setRegradeError('');
    try {
      const result = await requestRegrade(exampleId, name);
      setRegrade(result);
      if (REWRITABLE.includes(result.cause)) void loadRewrites(result);
    } catch (error) {
      setRegradeError(errorMessage(error));
    } finally {
      setRegrading(false);
    }
  };

  // An ambiguous or unreliably graded assertion gets 1-2 rewrites, built from the expert's "judge was wrong" reasons
  // and the judges' reasons on the repetitions they disputed.
  const [rewrites, setRewrites] = useState<string[] | null>(null);
  const [rewriteState, setRewriteState] = useState<'idle' | 'loading' | 'applied' | string>('idle');
  const loadRewrites = async (result: Regrade) => {
    setRewrites(null);
    setRewriteState('loading');
    const disputed = new Set([...result.disputed_repetitions, ...result.overturned_repetitions]);
    const judgeReasons = result.repetitions.filter((rep) => !disputed.size || disputed.has(rep.number)).flatMap((rep) => Object.values(rep.reasons));
    const expertReasons = Object.values(labels).map((label) => label.comment).filter(Boolean);
    try {
      setRewrites(await requestRewrites(result.assertion.assertion, result.cause, expertReasons, [...new Set(judgeReasons)]));
      setRewriteState('idle');
    } catch (error) {
      setRewriteState(`Could not draft rewrites: ${errorMessage(error)}`);
    }
  };

  // Mixed: some repetitions passed and some failed. Only then is there anything for Re-grade to explain.
  const scores = (runs ?? []).filter((run) => !run.error).map((run) => run.assertions.find((a) => a.key === name)?.score).filter((v): v is number => typeof v === 'number');
  const mixed = scores.some((v) => v >= 1) && scores.some((v) => v < 1);

  return (
    <div className="flex flex-col gap-space-2 rounded-md border border-default bg-surface-level-2 p-space-3 text-xs">
      <div className="flex items-center justify-between gap-space-2">
        <span className="font-medium text-primary">Newest run{runs?.[0] ? ` · ${shortDate(runs[0].start)}` : ''}</span>
        <button type="button" className="text-tertiary hover:text-primary" aria-label="Close" onClick={onClose}>✕</button>
      </div>

      {loadError ? <span className="text-error-primary">{loadError}</span> : null}
      {runs ? <GapBanner gaps={dedupe(runs.flatMap(mockGaps))} onAddMock={onAddMock} /> : null}
      {!runs && !loadError ? <Spinner size="sm" /> : null}
      {runs?.map((run, index) => {
        const grade = run.assertions.find((a) => a.key === name);
        const passed = grade?.score === 1;
        return (
          <div key={run.runId} className="flex flex-col gap-space-1 rounded-sm border border-default bg-surface-level-1 p-space-2">
            <div className="flex items-center gap-space-2">
              <span className="text-secondary">Repetition {index + 1}</span>
              {run.error ? <span className="text-error-primary">✗ {friendlyError(run.error)}</span> : grade ? (
                <span className={passed ? 'text-success-primary' : 'text-error-primary'}>{passed ? '✓ passed' : grade.score === null ? '? undecided' : '✗ failed'}</span>
              ) : <span className="text-tertiary">not graded</span>}
            </div>
            {reasons[run.runId] || grade?.comment ? (
              <span className="text-secondary"><span className="text-tertiary">Judge: </span>{reasons[run.runId] || grade?.comment}</span>
            ) : null}
            {run.answer ? <div className="border-l-2 border-secondary pl-3 text-primary"><Markdown source={run.answer} /></div> : null}
            {kind === 'assertion' && grade && grade.score !== null && !run.error && !mockGaps(run).length ? (
              <JudgeLabel judgedPass={grade.score === 1} label={labels[run.runId]}
                onLabel={async (judgeRight, reason) => {
                  // The label is the RIGHT verdict: the judge's when it was right, the opposite when it wasn't.
                  const correct = judgeRight === (grade.score === 1);
                  const saved = await saveLabel(run.runId, name, correct, labels[run.runId], reason);
                  setLabels((current) => ({ ...current, [run.runId]: saved }));
                }} />
            ) : null}
            <ErrorDetails error={run.error} traceback={run.traceback} />
            <span className="flex items-center gap-space-2">
              <ToolCalls calls={run.toolCalls} />
              <button type="button" className="ml-auto self-start text-tertiary underline-offset-2 hover:text-primary hover:underline"
                onClick={() => void openTrace(run).catch(() => undefined)}>Trace</button>
            </span>
          </div>
        );
      })}

      {mixed && kind === 'check' ? (
        <span className="text-tertiary">A code check grades the same calls the same way, so the agent called its tools differently across repetitions.</span>
      ) : null}
      {mixed && kind === 'assertion' && isWeb() ? (
        <div className="flex flex-col gap-space-2">
          <div className="flex items-center gap-space-2">
            <Button size="sm" variant="outlined" color="secondary" onClick={() => void runRegrade()} disabled={regrading || !runs?.length}
              title="Grades these same replies again, 3 times with each judge, and says whether the agent, the judge or the wording varies. Doesn't run the agent.">
              {regrading ? 'Checking…' : 'Why is this inconsistent?'}
            </Button>
            {regrading ? <Spinner size="sm" /> : null}
          </div>
          {regradeError ? <span className="text-error-primary">{regradeError}</span> : null}
          {regrade ? <RegradeResult result={regrade} /> : null}
          {regrade && REWRITABLE.includes(regrade.cause) ? (
            <div className="flex flex-col gap-space-1 rounded-sm border border-default bg-surface-level-1 p-space-2"
              title={'Built from your "judge was wrong" reasons and the judges\' reasons. The name stays, so its results stay together.'}>
              <span className="font-medium text-primary">Try a clearer wording</span>
              {rewriteState === 'loading' ? <span className="flex items-center gap-space-1 text-tertiary"><Spinner size="sm" />Drafting…</span> : null}
              {rewriteState === 'applied' ? <span className="text-success-primary">Applied. Run it again to see whether the grades now agree.</span> : null}
              {rewriteState !== 'idle' && rewriteState !== 'loading' && rewriteState !== 'applied' ? <span className="text-error-primary">{rewriteState}</span> : null}
              {rewrites?.length === 0 ? <span className="text-tertiary">No rewrite came back.</span> : null}
              {rewriteState !== 'applied' ? rewrites?.map((rewrite) => (
                <span key={rewrite} className="flex items-start gap-space-2">
                  <span className="flex-1 text-primary">{rewrite}</span>
                  {onRewrite ? (
                    <button type="button" className="shrink-0 rounded-sm border border-default bg-surface-level-1 px-space-2 text-primary hover:border-focus"
                      onClick={() => { onRewrite(rewrite); setRewriteState('applied'); }}>Use this</button>
                  ) : null}
                </span>
              )) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// "Was the judge right?" Each answer is a labelled item for the judge bench (server/bench.py). "No" asks why first:
// the reason is the label's comment, and Re-grade's rewrites are built from these reasons.
function JudgeLabel({ judgedPass, label, onLabel }: { judgedPass: boolean; label?: Label; onLabel: (judgeRight: boolean, reason?: string) => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [error, setError] = useState('');
  const judgeRight = label ? label.correct === judgedPass : null;
  const save = async (right: boolean, why?: string) => {
    setSaving(true);
    setError('');
    try { await onLabel(right, why); setReason(null); } catch (err) { setError(`Could not save the label: ${errorMessage(err)}`); } finally { setSaving(false); }
  };
  const button = (right: boolean, text: string) => (
    <button type="button" disabled={saving} aria-label={right ? 'Judge was right' : 'Judge was wrong'} onClick={() => (right ? void save(true) : setReason(label?.comment ?? ''))}
      className={`rounded-sm border px-space-2 ${judgeRight === right ? 'border-focus bg-selected text-primary' : 'border-default text-secondary hover:text-primary'}`}>
      {text}
    </button>
  );
  return (
    <span className="flex flex-col gap-space-1 text-tertiary">
      <span className="flex items-center gap-space-1">
        Judge right? {button(true, '✓')} {button(false, '✗')}
        {label ? <span>labelled: should {label.correct ? 'pass' : 'fail'}{label.comment ? ` · “${label.comment}”` : ''}</span> : null}
      </span>
      {reason !== null ? (
        <span className="flex items-center gap-space-1">
          <input className="min-w-0 flex-1 rounded-sm border border-default bg-surface-level-1 px-space-2 py-px text-xs text-primary outline-none focus:border-focus"
            autoFocus value={reason} aria-label="Why the judge was wrong" placeholder={`Why? e.g. it ${judgedPass ? 'never asked for' : 'did give'} the order number`}
            onChange={(event) => setReason(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void save(false, reason.trim()); if (event.key === 'Escape') setReason(null); }} />
          <button type="button" disabled={saving} className="rounded-sm border border-default px-space-2 text-primary hover:border-focus" onClick={() => void save(false, reason.trim())}>Save</button>
          <button type="button" disabled={saving} className="text-secondary hover:text-primary" onClick={() => setReason(null)}>Cancel</button>
        </span>
      ) : null}
      {error ? <span className="text-error-primary">{error}</span> : null}
    </span>
  );
}

function RegradeResult({ result }: { result: Regrade }) {
  const cause = CAUSE[result.cause];
  const mark = (grade: boolean | null) => (grade === null ? '?' : grade ? '✓' : '✗');
  return (
    <div className="flex flex-col gap-space-2 rounded-sm border border-default bg-surface-level-1 p-space-2">
      <span className={`text-sm font-semibold ${cause.tone}`}>{cause.label}</span>
      <span className="text-secondary">{result.advice}</span>
      <details>
        <summary className="cursor-pointer text-tertiary">Details</summary>
        <table className="mt-space-1 w-full text-left">
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
      </details>
    </div>
  );
}

function dedupe(gaps: MockGap[]) {
  const seen = new Set<string>();
  return gaps.filter((gap) => { const k = `${gap.tool}:${JSON.stringify(gap.args)}`; return !seen.has(k) && seen.add(k); });
}

// A run that called a tool the test doesn't mock graded the test, not the agent: the agent was answering an error
// the test never wrote. Said first and plainly, so nobody "fixes" an agent that behaved correctly.
function GapBanner({ gaps, onAddMock }: { gaps: MockGap[]; onAddMock?: (gap: MockGap) => void }) {
  if (!gaps.length) return null;
  return (
    <div className="flex flex-col gap-space-1 rounded-sm border border-warning bg-warning-subtle p-space-2">
      <span className="font-semibold text-primary">A tool had no answer, so this result doesn't count.</span>
      {gaps.map((gap, index) => (
        <span key={index} className="flex flex-wrap items-center gap-space-2">
          <span className="font-mono text-primary">{gap.tool}({clip(Object.entries(gap.args).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', '), 120)})</span>
          {onAddMock ? (
            <button type="button" className="rounded-sm border border-default bg-surface-level-1 px-space-2 text-primary hover:border-focus" onClick={() => onAddMock(gap)}>
              Add answer
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}
