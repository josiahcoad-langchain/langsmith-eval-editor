import { useState } from 'react';
import { Button } from '@langchain/macaw-components/Button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@langchain/macaw-components/DropdownMenu';
import { DotsThreeIcon } from '@phosphor-icons/react/dist/csr/DotsThree';
import { RemoveButton, TextAreaField, TextField } from './fields';
import { isRecord, keyId, parseResponse, type Json, type MockCase, type MockTool } from '../lib/data';

function sizeLabel(textValue: string) {
  return textValue.length >= 1024 ? `${Math.round(textValue.length / 1024)} KB` : `${textValue.length} chars`;
}

// A readable one-line description of a response: the failure, the shape of a table, or the top-level fields.
function responseSummary(response: string): { fails: boolean; text: string } {
  if (!response.trim()) return { fails: false, text: 'No response yet' };
  const parsed = parseResponse(response);
  const size = sizeLabel(response);
  const list = (names: string[]) => (names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3} more` : names.join(', '));
  if (isRecord(parsed) && Object.keys(parsed).length === 1 && 'raise' in parsed) return { fails: true, text: String(parsed.raise) };
  if (isRecord(parsed) && Array.isArray(parsed.rows)) {
    const first = parsed.rows.find(isRecord);
    return { fails: false, text: `${parsed.rows.length} rows · ${first ? list(Object.keys(first)) : 'no columns'} · ${size}` };
  }
  if (Array.isArray(parsed)) return { fails: false, text: `${parsed.length} items · ${size}` };
  if (isRecord(parsed)) return { fails: false, text: `fields: ${list(Object.keys(parsed))} · ${size}` };
  const textValue = String(parsed);
  return { fails: false, text: `"${textValue.length > 60 ? `${textValue.slice(0, 60)}…` : textValue}"` };
}

function WhenChips({ when }: { when: string }) {
  let parsed: Json | null = null;
  try {
    parsed = when.trim() ? (JSON.parse(when) as Json) : null;
  } catch {
    return <span className="font-mono text-xs text-error-primary">invalid: {when}</span>;
  }
  if (!parsed || !Object.keys(parsed).length) return <span className="text-xs text-tertiary">Any call</span>;
  return (
    <span className="flex flex-wrap gap-space-1">
      {Object.entries(parsed).map(([arg, value]) => (
        <span key={arg} className="rounded-sm border border-default bg-surface-level-2 px-space-1 font-mono text-xs text-primary">
          {arg} = {typeof value === 'string' ? value : JSON.stringify(value)}
        </span>
      ))}
    </span>
  );
}

const PREVIEW_ROWS = 6;

export // One mocked tool: every response is listed as "when <args> -> <preview>"; clicking a row opens it for editing.
// A recorded tool can carry a case per argument value, so long lists show the first few until expanded.
function MockToolEditor({ mock, tools, onChange, onRemove }: {
  mock: MockTool;
  tools: string[];
  onChange: (patch: Partial<MockTool>) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState<string | null>(mock.tool ? null : 'single');
  const [showAll, setShowAll] = useState(false);
  const rows: MockCase[] = mock.cases ?? [{ key: 'single', when: '', response: mock.response }];
  const visible = showAll ? rows : rows.slice(0, PREVIEW_ROWS);
  const patchRow = (key: string, patch: Partial<MockCase>) => {
    if (!mock.cases) onChange({ response: patch.response ?? mock.response });
    else onChange({ cases: mock.cases.map((row) => (row.key === key ? { ...row, ...patch } : row)) });
  };
  const duplicateCase = (key: string) => {
    if (!mock.cases) return;
    const index = mock.cases.findIndex((row) => row.key === key);
    const copy = { ...mock.cases[index], key: keyId() };
    onChange({ cases: [...mock.cases.slice(0, index + 1), copy, ...mock.cases.slice(index + 1)] });
    setOpen(copy.key);
    setShowAll(true);
  };
  const deleteCase = (key: string) => onChange({ cases: mock.cases?.filter((row) => row.key !== key) ?? null });
  return (
    <div className="flex flex-col gap-space-2 rounded-md border border-default bg-surface-level-1 p-space-3">
      <div className="flex items-center gap-space-2">
        <select className="w-72 shrink-0 rounded-md border border-default bg-surface-level-1 px-space-3 py-space-2 font-mono text-sm text-primary shadow-sm outline-none focus:border-focus"
          aria-label="Tool name" value={mock.tool} onChange={(event) => onChange({ tool: event.currentTarget.value })}>
          <option value="">{tools.length ? 'Pick a tool' : 'Loading tools…'}</option>
          {mock.tool && !tools.includes(mock.tool) ? <option value={mock.tool}>{mock.tool}</option> : null}
          {tools.map((tool) => <option key={tool} value={tool}>{tool}</option>)}
        </select>
        <div className="flex-1" />
        <RemoveButton label={`Remove mock ${mock.tool}`} onClick={onRemove} />
      </div>
      <div className="flex flex-col overflow-hidden rounded-md border border-default">
        <div className="grid grid-cols-[minmax(0,200px)_minmax(0,1fr)_auto] gap-space-3 border-b border-default bg-surface-level-2 px-space-3 py-space-1 text-xs font-medium text-tertiary">
          <span>When</span>
          <span>Returns</span>
          <span />
        </div>
        {visible.map((row) => {
          const preview = responseSummary(row.response);
          const isOpen = open === row.key;
          return (
            <div key={row.key} className="border-b border-default last:border-b-0">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center hover:bg-surface-level-2">
              <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : row.key)}
                className="grid w-full grid-cols-[minmax(0,200px)_minmax(0,1fr)] items-center gap-space-3 px-space-3 py-space-2 text-left">
                <WhenChips when={row.when} />
                {preview.fails ? (
                  <span className="truncate text-xs"><span className="mr-space-1 rounded-sm bg-error-subtle px-space-1 font-medium text-error-primary">Fails</span>{preview.text}</span>
                ) : (
                  <span className="truncate text-xs text-secondary">{preview.text}</span>
                )}
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="Response actions" className="mr-space-2 inline-flex size-7 items-center justify-center rounded-md text-tertiary hover:bg-surface-level-3 hover:text-primary">
                    <DotsThreeIcon size={18} weight="bold" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setOpen(isOpen ? null : row.key)}>{isOpen ? 'Close' : 'Edit'}</DropdownMenuItem>
                  {mock.cases ? (
                    <>
                      <DropdownMenuItem onSelect={() => duplicateCase(row.key)}>Duplicate</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-error-primary" onSelect={() => deleteCase(row.key)}>Delete</DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
              </div>
              {isOpen ? (
                <div className="flex flex-col gap-space-2 border-t border-default bg-surface-level-2 p-space-3">
                  {mock.cases ? (
                    <div className="flex items-end gap-space-2">
                      <div className="flex-1">
                        <TextField label="When the call's arguments include (JSON; empty = any)" value={row.when} onChange={(when) => patchRow(row.key, { when })} placeholder='{"order_id": "A1001"}' mono />
                      </div>
                    </div>
                  ) : null}
                  <TextAreaField label="Returns" value={row.response} onChange={(response) => patchRow(row.key, { response })}
                    rows={row.response.length > 400 ? 12 : 3} mono placeholder='{"raise": "503 Service Unavailable"}' />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="flex gap-space-2">
        {rows.length > PREVIEW_ROWS ? (
          <Button size="sm" variant="outlined" color="secondary" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show fewer' : `Show all ${rows.length}`}
          </Button>
        ) : null}
        <Button size="sm" variant="outlined" color="secondary" onClick={() => {
          const key = keyId();
          const cases = mock.cases ?? [{ key: keyId(), when: '', response: mock.response }];
          // First match wins and an empty `when` matches anything, so new cases go before any catch-all.
          const catchAll = cases.findIndex((row) => !row.when.trim());
          const at = catchAll === -1 ? cases.length : catchAll;
          onChange({ cases: [...cases.slice(0, at), { key, when: '', response: '' }, ...cases.slice(at)], response: '' });
          setOpen(key);
          setShowAll(true);
        }}>
          {mock.cases ? 'Add response' : 'Respond differently per argument'}
        </Button>
      </div>
    </div>
  );
}
