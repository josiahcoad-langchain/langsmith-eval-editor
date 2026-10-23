import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@langchain/macaw-components/Button';
import { Card } from '@langchain/macaw-components/Card';
import { Text } from '@langchain/macaw-components/Text';
import { TrashIcon } from '@phosphor-icons/react/dist/csr/Trash';

// Native inputs styled with Macaw tokens (Macaw's Input hit an invalid hook call in the custom-app preview).
export const fieldClass =
  'w-full rounded-md border border-default bg-surface-level-1 px-space-3 py-space-2 text-sm text-primary shadow-sm outline-none focus:border-focus disabled:text-disabled';
const labelClass = 'flex flex-col gap-space-1 text-sm font-medium text-secondary';

export function TextField({ label, value, onChange, placeholder, mono = false }: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  const input = (
    <input className={`${fieldClass} ${mono ? 'font-mono' : ''}`} value={value} placeholder={placeholder} aria-label={label ?? placeholder}
      onChange={(event) => onChange(event.currentTarget.value)} />
  );
  return label ? <label className={labelClass}>{label}{input}</label> : input;
}

export function TextAreaField({ label, value, onChange, rows = 2, mono = false, placeholder, maxRows }: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  mono?: boolean;
  placeholder?: string;
  // Grow with the text up to this many lines, then scroll. Without it the box keeps `rows`.
  maxRows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => {
    const el = ref.current;
    if (!el || !maxRows) return;
    const style = getComputedStyle(el);
    const line = parseFloat(style.lineHeight) || 20;
    const chrome = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    el.style.height = 'auto';
    const cap = line * maxRows + chrome;
    el.style.height = `${Math.min(el.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth), cap)}px`;
    el.style.overflowY = el.scrollHeight + chrome > cap ? 'auto' : 'hidden';
  };
  useLayoutEffect(fit, [value, maxRows]);
  // The text wraps differently once the box gets its final width (it can mount narrow), so refit when the width changes.
  useEffect(() => {
    const el = ref.current;
    if (!el || !maxRows) return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== width) { width = el.clientWidth; fit(); }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [maxRows]);
  const area = (
    <textarea ref={ref} className={`${fieldClass} ${mono ? 'font-mono text-xs leading-5' : ''} ${maxRows ? 'resize-none' : ''}`} value={value} rows={rows}
      placeholder={placeholder} spellCheck={!mono} aria-label={label ?? placeholder} onChange={(event) => onChange(event.currentTarget.value)} />
  );
  return label ? <label className={labelClass}>{label}{area}</label> : area;
}

// Titled sections collapse from their header; while closed they show `summary`. The open state lives in the
// section, so it carries over when you switch tests.
// Bumping `openSignal` opens a closed section (e.g. after something was added to it from elsewhere).
export function Section({ title, hint, summary, defaultOpen = true, openSignal = 0, children }: {
  title?: string; hint?: ReactNode; summary?: string; defaultOpen?: boolean; openSignal?: number; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { if (openSignal) setOpen(true); }, [openSignal]);
  if (!title) {
    return <Card intent="neutral" className="flex flex-col gap-space-4 border border-default">{children}</Card>;
  }
  return (
    <Card intent="neutral" className="flex flex-col gap-space-3 border border-default">
      <button type="button" className="flex items-start gap-space-2 text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`mt-space-1 text-xs text-tertiary transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        <span className="flex min-w-0 flex-col">
          <Text variant="h3">{title}</Text>
          {open ? (hint ? <Text variant="xs" color="tertiary">{hint}</Text> : null) : summary ? <span className="truncate text-xs text-tertiary">{summary}</span> : null}
        </span>
      </button>
      {open ? children : null}
    </Card>
  );
}

export function Subsection({ title, hint, onAdd, addLabel, children }: { title: string; hint?: ReactNode; onAdd?: () => void; addLabel?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-space-2">
      <div className="flex items-end justify-between gap-space-3">
        <div className="flex flex-col">
          <Text variant="sm" weight="semibold">{title}</Text>
          {hint ? <Text variant="xs" color="tertiary">{hint}</Text> : null}
        </div>
        {onAdd && addLabel ? <Button size="sm" variant="outlined" color="secondary" onClick={onAdd}>{addLabel}</Button> : null}
      </div>
      {children}
    </div>
  );
}

export function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-tertiary hover:bg-error-subtle hover:text-error-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--border-focus)]">
      <TrashIcon size={16} />
    </button>
  );
}
