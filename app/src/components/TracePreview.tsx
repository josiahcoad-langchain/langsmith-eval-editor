import { Button } from '@langchain/macaw-components/Button';
import { Spinner } from '@langchain/macaw-components/Spinner';
import { shortDate, tracePreview, type SourceFeedback, type Trace } from '../lib/data';
import { Markdown } from './Markdown';
import { ToolCalls } from './ToolCalls';

// A flagged trace or past run, read before it becomes anything: the message, what the agent replied and which tools
// it called. Nothing is written until Make proposal; Cancel leaves no trace in the dataset.
export function TracePreview({ source, trace, feedback, error, making, onMake, onCancel, onRetry }: {
  source: 'flagged' | 'past run'; trace: Trace | null; feedback: SourceFeedback[]; error: string; making: boolean;
  onMake: () => void; onCancel: () => void; onRetry: () => void;
}) {
  const preview = trace ? tracePreview(trace) : null;
  return (
    <div className="flex flex-col gap-space-3 rounded-md border border-dashed border-focus bg-surface-level-1 p-space-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-space-2">
        <div className="flex min-w-0 flex-col">
          <span className="font-semibold text-primary">Preview: {source}{preview?.start ? ` · ${shortDate(preview.start)}` : ''}</span>
          <span className="text-xs text-tertiary">
            Read it before deciding. Make proposal turns its message into When, earlier turns into History and its tool calls into mocks. Nothing is saved until then.
          </span>
        </div>
        <div className="flex gap-space-2">
          <Button size="sm" variant="outlined" color="secondary" onClick={onCancel} disabled={making}>Cancel</Button>
          <Button size="sm" color="primary" onClick={onMake} disabled={!trace || making}>{making ? 'Making…' : 'Make proposal'}</Button>
        </div>
      </div>
      {error ? (
        <span className="flex items-center gap-space-2 text-xs text-error-primary">
          {error}
          {!trace ? <button type="button" className="text-secondary underline hover:text-primary" onClick={onRetry}>Try again</button> : null}
        </span>
      ) : null}
      {!trace && !error ? <div className="flex items-center gap-space-2"><Spinner size="sm" /><span className="text-xs text-tertiary">Reading the trace…</span></div> : null}
      {feedback.map((row, index) => (
        <span key={index} className="text-xs text-secondary">
          <span className={`mr-space-1 rounded-sm px-space-1 font-medium ${row.score === 0 ? 'bg-error-subtle text-error-primary' : 'bg-surface-level-2 text-secondary'}`}>
            {row.key || 'feedback'}{row.score === null ? '' : `: ${row.score === 0 ? 'thumbs down' : row.score === 1 ? 'thumbs up' : row.score}`}
          </span>
          {row.comment ? `“${row.comment}”` : 'No comment.'}
        </span>
      ))}
      {preview ? (
        <>
          <div className="flex flex-col gap-space-1">
            <span className="text-xs text-tertiary">The message{preview.turns ? ` (after ${preview.turns} earlier turn${preview.turns === 1 ? '' : 's'})` : ''}:</span>
            <div className="whitespace-pre-wrap rounded-sm bg-surface-level-2 p-space-2 text-primary">{preview.prompt || '(no prompt)'}</div>
          </div>
          <div className="flex flex-col gap-space-1">
            <span className="text-xs text-tertiary">The agent replied:</span>
            <div className="max-h-72 overflow-y-auto border-l-2 border-secondary pl-3 text-primary">
              {preview.reply ? <Markdown source={preview.reply} /> : <span className="text-tertiary">(no reply recorded)</span>}
            </div>
          </div>
          <div className="text-xs"><ToolCalls calls={preview.toolCalls} open /></div>
        </>
      ) : null}
    </div>
  );
}
