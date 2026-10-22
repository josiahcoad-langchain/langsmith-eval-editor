import { feedbackLine, isRecord, text, type Example } from '../lib/data';
import { Markdown } from './Markdown';

// What went wrong in the run a proposal came from: the agent's reply and the feedback that flagged it. The expert
// reads this before writing assertions, since the assertions should say what the agent should have done instead.
export function SourcePanel({ example }: { example: Example }) {
  const output = text(example.metadata.source_output);
  const feedback = Array.isArray(example.metadata.source_feedback) ? example.metadata.source_feedback.filter(isRecord) : [];
  if (!output && !feedback.length) return null;
  return (
    <div className="flex flex-col gap-space-2 rounded-md border border-default bg-surface-level-1 p-space-3 text-sm">
      <span className="text-sm font-semibold text-primary">What happened in the original run</span>
      {feedback.map((row, index) => <span key={index} className="text-xs text-secondary">{feedbackLine(row)}</span>)}
      {output ? (
        <div className="flex flex-col gap-space-1">
          <span className="text-xs text-tertiary">The agent replied:</span>
          <div className="max-h-64 overflow-y-auto border-l-2 border-secondary pl-3 text-primary"><Markdown source={output} /></div>
        </div>
      ) : null}
      <span className="text-xs text-tertiary">Write assertions for what it should have done instead.</span>
    </div>
  );
}
