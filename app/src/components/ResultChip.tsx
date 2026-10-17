import { shortDate, type KeyResult } from '../lib/data';

// An assertion's or check's result on the test's newest run, shown beside it the way an IDE shows a test's last
// result next to the test. Nothing is shown for a name that run never graded (e.g. one added since): no chip is
// truer than a guessed one.
export function ResultChip({ result, ranAt, stale = null, onOpen }: { result?: KeyResult; ranAt: string; stale?: string | null; onOpen: () => void }) {
  if (!result || !result.n) return null;
  const tone = result.passed === result.n ? 'bg-success-subtle text-success-primary'
    : result.passed === 0 ? 'bg-error-subtle text-error-primary' : 'bg-warning-subtle text-warning-primary';
  const label = `${stale ? `Out of date: ${stale}. ` : ''}Newest run${ranAt ? ` (${shortDate(ranAt)})` : ''}: passed ${result.passed} of ${result.n} repetition${result.n === 1 ? '' : 's'}. Click for the reasons.`;
  return (
    <button type="button" onClick={onOpen} title={label} aria-label={label}
      className={`shrink-0 rounded-sm px-space-2 py-space-1 font-mono text-xs font-medium ${tone} ${stale ? 'opacity-40' : ''}`}>
      {result.passed}/{result.n}
    </button>
  );
}
