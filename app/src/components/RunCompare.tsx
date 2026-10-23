import { useEffect } from 'react';
import { friendlyError, INTERNAL_KEYS, shortDate, stableStringify, text, type TestResult } from '../lib/data';
import { ErrorDetails } from './ErrorDetails';
import { Markdown } from './Markdown';
import { ToolCalls } from './ToolCalls';

// Two runs of one test side by side: their grades, replies and tool calls, with what differs called out first.
// Picked in the Results column: two repetitions of one experiment, or one from each of two experiments.
export function RunCompare({ runs, labels, onClose }: { runs: [TestResult, TestResult]; labels: Record<string, string>; onClose: () => void }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);

  const [a, b] = runs;
  const score = (run: TestResult, key: string) => run.assertions.find((x) => x.key === key)?.score ?? null;
  const keys = [...new Set([...a.assertions, ...b.assertions].map((x) => x.key))].filter((key) => !INTERNAL_KEYS.has(key));
  const gradesDiffer = keys.filter((key) => score(a, key) !== score(b, key));
  const calls = (run: TestResult, withResults = false) => run.toolCalls
    .map((c) => stableStringify(withResults ? { name: c.name, args: c.args, result: c.result, error: c.error } : { name: c.name, args: c.args })).join('\n');
  const sameCalls = calls(a) === calls(b);
  const sameResults = calls(a, true) === calls(b, true);
  const sameNames = a.toolCalls.map((c) => text(c.name)).join() === b.toolCalls.map((c) => text(c.name)).join();
  const mark = (value: number | null) => (value === null ? '–' : value >= 1 ? '✓' : '✗');

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-space-6" onClick={onClose}>
      <div role="dialog" aria-label="Compare two runs" className="flex w-full max-w-6xl flex-col gap-space-3 rounded-md border border-default bg-surface-level-1 p-space-4 text-xs shadow-lg"
        onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-space-2">
          <div className="flex flex-col gap-px">
            <span className="text-sm font-semibold text-primary">Compare two runs</span>
            <span className="text-secondary">
              {gradesDiffer.length ? `Grades differ on ${gradesDiffer.join(', ')}.` : 'Same grades.'}{' '}
              {sameCalls ? (sameResults ? 'Same tool calls with the same arguments.' : 'Same tool calls with the same arguments, but they got different results.') : sameNames ? 'Same tools in the same order, with different arguments.' : 'Different tool calls.'}
            </span>
          </div>
          <button type="button" className="rounded-md px-space-2 text-tertiary hover:bg-surface-level-2 hover:text-primary" aria-label="Close comparison" onClick={onClose}>×</button>
        </div>
        <div className="grid grid-cols-2 gap-space-3">
          {runs.map((run) => (
            <div key={run.runId} className="flex min-w-0 flex-col gap-space-2 rounded-sm border border-default p-space-2">
              <span className="font-medium text-primary">{labels[run.runId] ?? shortDate(run.start)}</span>
              <ul className="flex flex-col gap-px">
                {keys.map((key) => (
                  <li key={key} className={`flex gap-space-2 ${gradesDiffer.includes(key) ? 'rounded-sm bg-warning-subtle' : ''}`}>
                    <span className={`w-4 text-center ${score(run, key) === null ? 'text-tertiary' : (score(run, key) ?? 0) >= 1 ? 'text-success-primary' : 'text-error-primary'}`}>{mark(score(run, key))}</span>
                    <span className="font-mono text-primary">{key}</span>
                  </li>
                ))}
              </ul>
              {run.error ? <span className="text-error-primary">{friendlyError(run.error)}</span> : null}
              <ErrorDetails error={run.error} traceback={run.traceback} />
              <div className="flex flex-col gap-space-1">
                <span className="text-tertiary">Agent replied:</span>
                <div className="max-h-96 overflow-y-auto border-l-2 border-secondary pl-3 text-primary">
                  {run.answer ? <Markdown source={run.answer} /> : <span className="text-tertiary">(no reply)</span>}
                </div>
              </div>
              <ToolCalls calls={run.toolCalls} open />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
