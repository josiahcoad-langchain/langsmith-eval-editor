import { useEffect, useRef, useState } from 'react';
import { DotsThreeIcon } from '@phosphor-icons/react/dist/csr/DotsThree';

// The test's "⋯" menu. Hand-rolled on purpose: Macaw's DropdownMenu cost ~90 KB of a custom-app bundle that
// LangSmith caps at 1 MB, for a menu with two items. Closes on Escape, on a click outside, or after an item.
export type MenuItem = { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean };

export function ActionsMenu({ label, items, compact = false }: { label: string; items: MenuItem[]; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}
        className={compact
          ? 'mr-space-2 inline-flex size-7 items-center justify-center rounded-md text-tertiary hover:bg-surface-level-3 hover:text-primary'
          : 'inline-flex size-8 items-center justify-center rounded-md border border-default text-secondary hover:bg-surface-level-2 hover:text-primary'}>
        <DotsThreeIcon size={18} weight="bold" />
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 z-10 mt-space-1 flex min-w-36 flex-col rounded-md border border-default bg-surface-level-1 p-space-1 shadow-md">
          {items.map((item) => (
            <button key={item.label} type="button" role="menuitem" disabled={item.disabled}
              className={`rounded-sm px-space-2 py-space-1 text-left text-sm hover:bg-surface-level-2 disabled:opacity-50 ${item.danger ? 'text-error-primary' : 'text-primary'}`}
              onClick={() => { setOpen(false); item.onSelect(); }}>
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
