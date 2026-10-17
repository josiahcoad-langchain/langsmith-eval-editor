import { shortDate, type TestSummary } from '../lib/data';

// The test's newest result in one line at the top of the test, like an IDE's last-run banner: when, how it went,
// what it cost, how long it took and which agent commit it ran on. When the result no longer describes the test
// (`stale`), it says so instead of passing an old result off as current.
export function LastRun({ summary, stale, onOpen }: { summary?: TestSummary; stale: string | null; onOpen: () => void }) {
  if (!summary) return null;
  if (summary.status === 'none') return <span className="text-xs text-tertiary">Never run.</span>;
  const keys = Object.values(summary.keys);
  const allPassed = keys.filter((k) => k.passed === k.n).length;
  const verdict = summary.status === 'error'
    ? 'errored (no grades)'
    : `${allPassed} of ${keys.length} passed every repetition`;
  const tone = { pass: 'text-success-primary', fail: 'text-error-primary', flaky: 'text-warning-primary', error: 'text-error-primary', none: '' }[summary.status];
  const parts = [
    `${summary.runs} repetition${summary.runs === 1 ? '' : 's'}`,
    summary.totalCost ? `$${summary.totalCost.toFixed(4)}${summary.runs ? ` ($${(summary.totalCost / summary.runs).toFixed(4)}/run)` : ''}` : '',
    summary.latencyP50 ? `median ${summary.latencyP50.toFixed(1)}s` : '',
    summary.agentCommit ? `agent ${summary.agentCommit.slice(0, 8)}` : '',
  ].filter(Boolean);
  return (
    <span className="flex flex-col text-xs">
      <span className={stale ? 'text-tertiary line-through decoration-1' : 'text-secondary'}>
        <button type="button" className="underline-offset-2 hover:underline" onClick={onOpen}>Last run {shortDate(summary.ranAt)}</button>
        {': '}<span className={stale ? '' : tone}>{verdict}</span>{' · '}{parts.join(' · ')}
      </span>
      {stale ? <span className="text-warning-primary">Out of date: {stale}. Run it again to refresh.</span> : null}
    </span>
  );
}
