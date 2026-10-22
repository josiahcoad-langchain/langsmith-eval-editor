import { text, type Json } from '../lib/data';

// A run's tool calls ({name, args, result | error}), collapsed to their names until opened. Shared by the
// drill-down, the run comparison and the import preview.
export function ToolCalls({ calls, open = false }: { calls: Json[]; open?: boolean }) {
  if (!calls.length) return <span className="text-tertiary">No tool calls.</span>;
  return (
    <details open={open}>
      <summary className="cursor-pointer text-tertiary">Tool calls: {calls.map((c) => text(c.name)).join(', ')}</summary>
      <div className="mt-space-1 flex flex-col gap-space-1">
        {calls.map((call, index) => (
          <div key={index} className="break-all rounded-sm bg-surface-level-2 p-space-1 font-mono">
            <div className={call.error ? 'text-error-primary' : 'text-primary'}>{text(call.name)}({clip(JSON.stringify(call.args ?? {}))})</div>
            <div className="text-tertiary">→ {clip(call.error ? text(call.error) : JSON.stringify(call.result ?? null))}</div>
          </div>
        ))}
      </div>
    </details>
  );
}

export function clip(value: string, length = 300) {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}
