import { dayDate, friendlyError, INTERNAL_KEYS, type TestSummary } from '../lib/data';

// The test's newest result in a few words in the top bar ("Passed 3/3 · Oct 16"), like an IDE's last-run banner.
// Cost, speed, agent version and per-assertion counts are in its tooltip; clicking it opens Results. When the result
// no longer describes the test (`stale`), it says "Out of date" instead of passing an old result off as current.
export function LastRun({ summary, stale, error = '', onOpen, onRun }: {
  summary?: TestSummary; stale: string | null; error?: string; onOpen: () => void; onRun?: () => void;
}) {
  if (!summary) return null;
  if (summary.runningElsewhere) return <span className="text-xs text-brand-primary" title="Started outside this editor; results land when it's graded.">Running…</span>;
  if (summary.status === 'none') return <span className="text-xs text-tertiary">Never run</span>;
  const keys = Object.entries(summary.keys).filter(([key]) => !INTERNAL_KEYS.has(key));
  const allPassed = keys.filter(([, k]) => k.passed === k.n).length;
  const verdict = {
    pass: `Passed ${summary.runs}/${summary.runs}`,
    fail: 'Failed',
    flaky: 'Mixed results',
    error: friendlyError(error) || "Couldn't run",
    none: '',
  }[summary.status];
  const tone = { pass: 'text-success-primary', fail: 'text-error-primary', flaky: 'text-warning-primary', error: 'text-error-primary', none: '' }[summary.status];
  const details = [
    summary.status === 'error' ? '' : `${allPassed} of ${keys.length} assertions passed every time`,
    `${summary.runs} repetition${summary.runs === 1 ? '' : 's'}`,
    summary.totalCost ? `$${summary.totalCost.toFixed(4)}${summary.runs ? ` ($${(summary.totalCost / summary.runs).toFixed(4)} each)` : ''}` : '',
    summary.latencyP50 ? `median ${summary.latencyP50.toFixed(1)}s` : '',
    summary.agentCommit ? `agent ${summary.agentCommit.slice(0, 8)}` : '',
  ].filter(Boolean).join(' · ');
  const open = (
    <button type="button" className="underline-offset-2 hover:underline" title={`${stale ? `${stale} ` : ''}${details}`} onClick={onOpen}>
      {stale ? 'Out of date' : <><span className={tone}>{verdict}</span><span className="text-tertiary"> · {dayDate(summary.ranAt)}</span></>}
    </button>
  );
  return (
    <span className="flex items-center gap-space-1 whitespace-nowrap text-xs text-tertiary">
      {open}
      {stale && onRun ? <>{'·'}<button type="button" className="font-medium text-brand-primary underline-offset-2 hover:underline" onClick={onRun}>Run again</button></> : null}
    </span>
  );
}
