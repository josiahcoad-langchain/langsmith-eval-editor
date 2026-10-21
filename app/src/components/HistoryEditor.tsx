import { useState } from 'react';
import { Button } from '@langchain/macaw-components/Button';
import { RemoveButton, fieldClass } from './fields';
import { historyChars, keyId, type HistoryTurn } from '../lib/data';

// "get_order(order_id=A1002)": what an assistant turn asked its tools for.
function callLabel(call: { name: string; args: Record<string, unknown> }) {
  const args = Object.entries(call.args).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
  return `${call.name}(${args.length > 60 ? `${args.slice(0, 60)}…` : args})`;
}

function preview(turn: HistoryTurn) {
  if (turn.role === 'tool') return `${turn.toolName || 'tool'} returned ${turn.content.slice(0, 100)}${turn.content.length > 100 ? '…' : ''}`;
  const calls = turn.toolCalls?.length ? `calls ${turn.toolCalls.map(callLabel).join(', ')}` : '';
  const words = `${turn.content.slice(0, 120)}${turn.content.length > 120 ? '…' : ''}`;
  return [words, calls].filter(Boolean).join(' · ') || '(empty)';
}

function sizeLabel(chars: number) {
  return chars >= 1000 ? `${(chars / 1000).toFixed(chars >= 100000 ? 0 : 1)}k chars` : `${chars} chars`;
}

// A turn's text is an uncontrolled textarea committed on blur: histories can reach ~600k chars, and pushing that
// through draft state, the dirty check and a re-render on every keystroke would freeze typing.
function TurnBody({ turn, onChange }: { turn: HistoryTurn; onChange: (patch: Partial<HistoryTurn>) => void }) {
  return (
    <textarea className={`${fieldClass} font-mono text-xs leading-5`} rows={turn.content.length > 400 ? 12 : 3} defaultValue={turn.content}
      spellCheck={false} aria-label="Turn text" placeholder="What was said in this turn"
      onBlur={(event) => { if (event.currentTarget.value !== turn.content) onChange({ content: event.currentTarget.value }); }} />
  );
}

// The conversation before the prompt, as an ordered list of turns. Collapsed by default: only a count and the
// total size render until it is opened, and each turn shows a short preview until it is opened too.
export function HistoryEditor({ history, onChange }: { history: HistoryTurn[]; onChange: (history: HistoryTurn[]) => void }) {
  const [open, setOpen] = useState(false);
  const [openTurn, setOpenTurn] = useState<string | null>(null);
  const patch = (key: string, change: Partial<HistoryTurn>) => onChange(history.map((turn) => (turn.key === key ? { ...turn, ...change } : turn)));
  const move = (index: number, by: number) => {
    const next = [...history];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    onChange(next);
  };
  const summary = history.length ? `${history.length} turn${history.length === 1 ? '' : 's'} · ${sizeLabel(historyChars(history))}` : 'No earlier turns';
  return (
    <div className="flex flex-col gap-space-2 rounded-md border border-default bg-surface-level-1 p-space-3">
      <div className="flex items-center justify-between gap-space-2">
        <button type="button" className="flex items-center gap-space-2 text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className={`text-xs text-tertiary transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
          <span className="text-sm font-semibold text-primary">History</span>
          <span className="text-xs text-tertiary">{summary} · sent before the prompt</span>
        </button>
        <Button size="sm" variant="outlined" color="secondary" onClick={() => {
          const key = keyId();
          // Turns alternate, so a new one defaults to the other role than the last (after a tool result, the assistant's).
          const role = history[history.length - 1]?.role === 'user' || history[history.length - 1]?.role === 'tool' ? 'assistant' : 'user';
          onChange([...history, { key, role, content: '' }]);
          setOpen(true);
          setOpenTurn(key);
        }}>Add turn</Button>
      </div>
      {open ? history.map((turn, index) => (
        <div key={turn.key} className="flex flex-col gap-space-1 rounded-md border border-default p-space-2">
          <div className="flex items-center gap-space-2">
            {/* A tool result belongs to the call before it, so its role is fixed; user and assistant turns can swap. */}
            {turn.role === 'tool' ? (
              <span className="w-32 shrink-0 px-space-3 font-mono text-xs text-tertiary">tool</span>
            ) : (
              <select className={`${fieldClass} w-32`} aria-label="Role" value={turn.role}
                onChange={(event) => patch(turn.key, { role: event.currentTarget.value === 'assistant' ? 'assistant' : 'user' })}>
                <option value="user">user</option>
                <option value="assistant">assistant</option>
              </select>
            )}
            <button type="button" className="min-w-0 flex-1 truncate text-left text-xs text-secondary" aria-expanded={openTurn === turn.key}
              onClick={() => setOpenTurn(openTurn === turn.key ? null : turn.key)}>
              {openTurn === turn.key ? 'Hide text' : `${preview(turn)} · ${sizeLabel(turn.content.length)}`}
            </button>
            <Button size="sm" variant="outlined" color="secondary" disabled={index === 0} onClick={() => move(index, -1)}>Up</Button>
            <Button size="sm" variant="outlined" color="secondary" disabled={index === history.length - 1} onClick={() => move(index, 1)}>Down</Button>
            <RemoveButton label={`Remove turn ${index + 1}`} onClick={() => onChange(history.filter((row) => row.key !== turn.key))} />
          </div>
          {openTurn === turn.key && turn.toolCalls?.length ? (
            <div className="flex flex-wrap gap-space-1">
              {turn.toolCalls.map((call) => <code key={call.id} className="rounded-sm bg-surface-level-2 px-space-1 font-mono text-xs text-primary">{callLabel(call)}</code>)}
            </div>
          ) : null}
          {openTurn === turn.key ? <TurnBody turn={turn} onChange={(change) => patch(turn.key, change)} /> : null}
        </div>
      )) : null}
    </div>
  );
}
