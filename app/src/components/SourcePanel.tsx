import { feedbackLine, isRecord, text, type Example } from '../lib/data';
import { Markdown } from './Markdown';

// What went wrong in the run a test was imported from: the agent's reply and the feedback that flagged it. Collapsed
// once the test has assertions; open while there are none, since they should say what it should have done instead.
export function SourcePanel({ example, open }: { example: Example; open: boolean }) {
  const output = text(example.metadata.source_output);
  const feedback = Array.isArray(example.metadata.source_feedback) ? example.metadata.source_feedback.filter(isRecord) : [];
  if (!output && !feedback.length) return null;
  return (
    <details open={open} className="group rounded-md border border-default bg-surface-level-1 p-space-3 text-sm">
      <summary className="cursor-pointer text-sm font-semibold text-primary">What the agent said</summary>
      <div className="mt-space-2 flex flex-col gap-space-2">
        {feedback.map((row, index) => <span key={index} className="text-xs text-secondary">{feedbackLine(row)}</span>)}
        {output ? <div className="max-h-64 overflow-y-auto border-l-2 border-secondary pl-3 text-primary"><Markdown source={output} /></div> : null}
      </div>
    </details>
  );
}
