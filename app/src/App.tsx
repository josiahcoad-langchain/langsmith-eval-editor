import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@langchain/macaw-components/Button';
import { Card } from '@langchain/macaw-components/Card';
import { Spinner } from '@langchain/macaw-components/Spinner';
import { Text } from '@langchain/macaw-components/Text';
import { DATASET_NAME } from './config';
import { fieldClass, RemoveButton, Section, Subsection, TextAreaField, TextField } from './components/fields';
import { ActionsMenu } from './components/ActionsMenu';
import { LastRun } from './components/LastRun';
import { ResultChip } from './components/ResultChip';
import { CheckEditor } from './components/CheckEditor';
import { HistoryEditor } from './components/HistoryEditor';
import { MockToolEditor } from './components/MockToolEditor';
import { ResultsPanel } from './components/ResultsPanel';
import {
  contextProblem, countToolCalls, deleteExample, emptyCheck, emptyExample, errorMessage, fetchAllExamples, fetchDataset, fetchPastRuns, fetchStatuses, importTrace, staleness,
  isDirty, keyId, saveExampleTo, shortDate, text, toDraft, toPayload, traceIdFrom,
  type Dataset, type Draft, type Example, type PastRun, type TestStatus, type TestSummary,
} from './lib/data';
import { fetchActiveRuns, isWeb, requestRun, requestRuns } from './runs';

const AUTOSAVE_MS = 800;
const REPETITION_CHOICES = [1, 3, 5];

type Notice = { kind: 'error' | 'success'; text: string } | null;

// The newest run's verdict, as a dot before the test's name, like an IDE's test explorer.
type ListStatus = TestStatus | 'queued' | 'running';

const STATUS_DOT: Record<ListStatus, { glyph: string; color: string; label: string }> = {
  running: { glyph: '◐', color: 'text-secondary animate-spin', label: 'Running now' },
  queued: { glyph: '◌', color: 'text-tertiary', label: 'Queued: waits for a free slot (4 tests run at a time)' },
  pass: { glyph: '●', color: 'text-success-primary', label: 'Newest run: every assertion and check passed on every repetition' },
  fail: { glyph: '●', color: 'text-error-primary', label: 'Newest run: something failed on every repetition' },
  flaky: { glyph: '●', color: 'text-warning-primary', label: 'Newest run: passed on some repetitions and failed on others' },
  error: { glyph: '!', color: 'text-error-primary', label: 'Newest run errored, e.g. the test is incomplete: no grades' },
  none: { glyph: '○', color: 'text-tertiary', label: 'Never run' },
};

// An out-of-date result keeps its colour but fades, so "was green, has since changed" reads differently from "green".
function StatusDot({ status, stale = false }: { status: ListStatus; stale?: boolean }) {
  const dot = STATUS_DOT[status];
  const label = stale ? `Out of date (changed since this run). ${dot.label}` : dot.label;
  return <span className={`w-3 shrink-0 text-center font-bold ${dot.color} ${stale ? 'opacity-40' : ''}`} title={label} aria-label={label}>{dot.glyph}</span>;
}

function RailButton({ active, title, subtitle, badge, status, stale = false, onClick }: {
  active: boolean; title: string; subtitle: string; badge?: string; status?: ListStatus; stale?: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`rounded-md border px-space-3 py-space-2 text-left text-sm transition ${
        active ? 'border-focus bg-selected text-primary' : 'border-default bg-surface-level-1 text-secondary hover:bg-surface-level-2 hover:text-primary'
      }`}
      onClick={onClick}
    >
      <span className="flex items-center justify-between gap-space-2">
        <span className="flex min-w-0 items-center gap-space-1">
          {status ? <StatusDot status={status} stale={stale} /> : null}
          <span className="truncate font-mono font-medium">{title}</span>
        </span>
        {badge ? <span className="shrink-0 text-xs text-tertiary">{badge}</span> : null}
      </span>
      <span className="line-clamp-2 text-xs text-tertiary">{subtitle}</span>
    </button>
  );
}

export function App({ metadata }: { data: unknown; metadata?: RenderMetadata }) {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [examples, setExamples] = useState<Example[]>([]);
  const [summaries, setSummaries] = useState<Record<string, TestSummary>>({});
  // Runs queued or in progress on the server, by example id (web mode), and a counter that re-reads the dots.
  const [activeRuns, setActiveRuns] = useState<Record<string, 'queued' | 'running'>>({});
  const [statusTick, setStatusTick] = useState(0);
  const [confirmBatch, setConfirmBatch] = useState<'all' | 'failing' | null>(null);
  const [batchNotice, setBatchNotice] = useState<Notice>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const savingIds = useRef(new Set<string>());

  // Test-list dots. Refreshed on a timer so a run started from the Results panel (or the CLI) shows up. Until the
  // first answer arrives a test has no dot at all: showing "never run" while loading would be a false statement.
  const exampleIds = useMemo(() => examples.filter((e) => !e.isNew).map((e) => e.id).sort().join(','), [examples]);
  useEffect(() => {
    if (!dataset || !exampleIds) return;
    let cancelled = false;
    const show = (next: Record<string, TestSummary>) => { if (!cancelled) setSummaries(next); };
    const refresh = () => fetchStatuses(dataset.id, exampleIds.split(','), show).then(show).catch(() => {});
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [dataset, exampleIds, statusTick]);

  // Which tests are queued or running. Polled fast while anything is in flight; when a test finishes, the dots
  // are re-read so its new result shows without waiting for the 30s refresh.
  useEffect(() => {
    if (!isWeb()) return;
    let cancelled = false;
    let previous: Record<string, 'queued' | 'running'> = {};
    const poll = async () => {
      const next = await fetchActiveRuns().catch(() => previous);
      if (cancelled) return;
      if (Object.keys(previous).some((id) => !(id in next))) setStatusTick((tick) => tick + 1);
      previous = next;
      setActiveRuns(next);
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  const [importing, setImporting] = useState<'closed' | 'open' | 'busy'>('closed');
  const [importRef, setImportRef] = useState('');
  const [importStatus, setImportStatus] = useState<Notice>(null);
  const [pastRuns, setPastRuns] = useState<PastRun[] | null>(null);
  const [pastRunError, setPastRunError] = useState<string | null>(null);
  const [pastRunQuery, setPastRunQuery] = useState('');
  const [toolCallCounts, setToolCallCounts] = useState<Record<string, number>>({});
  const [importingTrace, setImportingTrace] = useState<string | null>(null);
  const [showResults, setShowResults] = useState(false);
  const [repetitions, setRepetitions] = useState(3);
  const [running, setRunning] = useState(false);
  const [runStatus, setRunStatus] = useState<Notice>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const found = await fetchDataset();
      const rows = await fetchAllExamples(found.id);
      rows.sort((a, b) => text(a.metadata.name).localeCompare(text(b.metadata.name)));
      setDataset(found);
      setExamples(rows);
      setDrafts(Object.fromEntries(rows.map((row) => [row.id, toDraft(row)])));
      setSelectedId((current) => (current && rows.some((row) => row.id === current) ? current : rows[0]?.id));
    } catch (error) {
      setLoadError(errorMessage(error));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = examples.find((example) => example.id === selectedId);
  const draft = selectedId ? drafts[selectedId] : undefined;
  const dirtyIds = useMemo(
    () => new Set(examples.filter((example) => drafts[example.id] && isDirty(example, drafts[example.id])).map((example) => example.id)),
    [examples, drafts],
  );
  const built = selected && draft ? toPayload(selected, draft) : undefined;
  const tools = dataset?.tools ?? [];
  const dirty = selected ? dirtyIds.has(selected.id) : false;

  const select = (id: string) => {
    // Flush pending edits on the test being left instead of waiting for its autosave timer.
    if (selected && draft && dirty && !built?.error) void saveExample(selected, draft);
    setSelectedId(id);
    setNotice(null);
    setConfirmDelete(false);
    setRunStatus(null);
  };

  const patchDraft = (patch: Partial<Draft>) => {
    if (!selectedId) return;
    setDrafts((current) => ({ ...current, [selectedId]: { ...current[selectedId], ...patch } }));
  };

  function patchRow<K extends 'mockTools' | 'assertions' | 'checks'>(field: K, key: string, patch: Partial<Draft[K][number]>) {
    if (!draft) return;
    patchDraft({ [field]: (draft[field] as { key: string }[]).map((row) => (row.key === key ? { ...row, ...patch } : row)) } as Partial<Draft>);
  }

  function removeRow(field: 'mockTools' | 'assertions' | 'checks', key: string) {
    if (!draft) return;
    patchDraft({ [field]: (draft[field] as { key: string }[]).filter((row) => row.key !== key) } as Partial<Draft>);
  }

  const openImport = () => {
    const next = importing === 'closed' ? 'open' : 'closed';
    setImporting(next);
    setImportStatus(null);
    if (next === 'open') {
      setPastRunError(null);
      fetchPastRuns().then((runs) => {
        setPastRuns(runs);
        void countToolCalls(runs.filter((run) => !run.hidden && !(run.traceId in toolCallCounts)).map((run) => run.traceId),
          (traceId, count) => setToolCallCounts((counts) => ({ ...counts, [traceId]: count })));
      }, (error) => setPastRunError(errorMessage(error)));
    }
  };

  const runImport = async (picked?: string) => {
    const traceId = picked ?? traceIdFrom(importRef);
    setImportingTrace(traceId ?? null);
    if (!traceId) {
      setImportStatus({ kind: 'error', text: 'Paste a trace URL or trace ID.' });
      return;
    }
    setImporting('busy');
    setImportStatus(null);
    try {
      const { draft: imported, recordedOn, toolCalls } = await importTrace(traceId, tools);
      const example = { ...emptyExample(), inputs: { prompt: imported.prompt, recorded_on: recordedOn } };
      setExamples((current) => [...current, example]);
      setDrafts((current) => ({ ...current, [example.id]: imported }));
      select(example.id);
      setImportRef('');
      setImporting('closed');
      setImportStatus({ kind: 'success', text: `Imported ${toolCalls} tool calls as ${imported.mockTools.length} mocks. Add assertions, then run it.` });
    } catch (error) {
      setImporting('open');
      setImportStatus({ kind: 'error', text: errorMessage(error) });
    } finally {
      setImportingTrace(null);
    }
  };

  const addExample = (from?: Draft) => {
    const example = emptyExample();
    const nextDraft = from
      ? {
          ...from,
          name: `${from.name}-copy`,
          mockTools: from.mockTools.map((row) => ({ ...row, key: keyId(), cases: row.cases?.map((c) => ({ ...c, key: keyId() })) ?? null })),
          assertions: from.assertions.map((row) => ({ ...row, key: keyId() })),
          history: from.history.map((row) => ({ ...row, key: keyId() })),
          checks: from.checks.map((row) => ({ ...row, key: keyId() })),
        }
      : toDraft(example);
    setExamples((current) => [...current, example]);
    setDrafts((current) => ({ ...current, [example.id]: nextDraft }));
    select(example.id);
  };

  // Saves one test. Only the saved baseline changes afterwards; the draft is left alone so edits typed while the
  // request was in flight survive (and get picked up by the next autosave).
  const saveExample = async (example: Example, exampleDraft: Draft) => {
    const { payload } = toPayload(example, exampleDraft);
    if (!payload || !dataset || savingIds.current.has(example.id)) return;
    savingIds.current.add(example.id);
    setSaving(true);
    try {
      const saved = await saveExampleTo(dataset.id, example, payload);
      setExamples((current) => current.map((row) => (row.id === example.id ? saved : row)));
      if (saved.id !== example.id) {
        setDrafts((current) => {
          const { [example.id]: moved, ...rest } = current;
          return { ...rest, [saved.id]: moved };
        });
        setSelectedId((current) => (current === example.id ? saved.id : current));
      }
      setNotice(null);
    } catch (error) {
      setNotice({ kind: 'error', text: `Save failed: ${errorMessage(error)}` });
    } finally {
      savingIds.current.delete(example.id);
      setSaving(savingIds.current.size > 0);
    }
  };

  // Autosave the open test a moment after the last edit, once it's valid.
  useEffect(() => {
    if (!selected || !draft || !dirty || built?.error) return;
    const timer = window.setTimeout(() => void saveExample(selected, draft), AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, dirty, built?.error, saving]);

  const remove = async () => {
    if (!selected) return;
    if (selected.isNew) {
      setExamples((current) => current.filter((example) => example.id !== selected.id));
      setSelectedId(examples.find((example) => example.id !== selected.id)?.id);
      setConfirmDelete(false);
      return;
    }
    setSaving(true);
    try {
      await deleteExample(selected.id);
      const remaining = examples.filter((example) => example.id !== selected.id);
      setExamples(remaining);
      setSelectedId(remaining[0]?.id);
      setConfirmDelete(false);
      setNotice(null);
    } catch (error) {
      setNotice({ kind: 'error', text: `Delete failed: ${errorMessage(error)}` });
    } finally {
      setSaving(false);
    }
  };

  const savedExamples = examples.filter((e) => !e.isNew);
  const selectedStale = selected && !selected.isNew
    ? (dirty ? 'the test has unsaved edits' : staleness(summaries[selected.id], selected, metadata?.agentCommit))
    : null;
  const failingExamples = savedExamples.filter((e) => ['fail', 'flaky', 'error'].includes(summaries[e.id]?.status ?? ''));
  const batchFor = (which: 'all' | 'failing') => (which === 'all' ? savedExamples : failingExamples);

  // Predicted agent cost: each test's cost per repetition on its newest run, times the repetitions chosen.
  // Tests with no priced run yet are counted separately rather than guessed.
  const estimate = (batch: Example[]) => {
    const priced = batch.map((e) => summaries[e.id]?.costPerRun).filter((c): c is number => c !== null && c !== undefined);
    return { dollars: priced.reduce((sum, c) => sum + c, 0) * repetitions, unpriced: batch.length - priced.length };
  };
  const formatDollars = (dollars: number) => (dollars < 0.01 ? `$${dollars.toFixed(4)}` : `$${dollars.toFixed(2)}`);

  const runBatch = async (which: 'all' | 'failing') => {
    const batch = batchFor(which);
    setConfirmBatch(null);
    try {
      await requestRuns(batch.map((e) => ({ test: drafts[e.id]?.name ?? '', exampleId: e.id, repetitions })));
      setBatchNotice({ kind: 'success', text: `Started ${batch.length} test${batch.length === 1 ? '' : 's'}. Dots update as each finishes.` });
    } catch (error) {
      setBatchNotice({ kind: 'error', text: `Could not start the runs: ${errorMessage(error)}` });
    }
  };

  const runTest = async () => {
    if (!selected || !draft) return;
    setRunning(true);
    setRunStatus(null);
    try {
      await requestRun({ test: draft.name, exampleId: selected.id, repetitions });
      setRunStatus({ kind: 'success', text: `Run started at ${new Date().toLocaleTimeString()}. Follow it in Results.` });
      setShowResults(true);
    } catch (error) {
      setRunStatus({ kind: 'error', text: `Could not start a run: ${errorMessage(error)}` });
    } finally {
      setRunning(false);
    }
  };

  const openInLangSmith = () => {
    if (!selected || selected.isNew || !metadata?.workspaceId || !dataset) return;
    window.langsmith.openUrl(`/o/${metadata.workspaceId}/datasets/${dataset.id}/e/${selected.id}`, { newTab: true });
  };

  const rail = (
    <>
      <div className="flex items-center justify-between">
        <Text variant="md" weight="semibold">Tests ({examples.filter((e) => !e.isNew).length})</Text>
        <div className="flex gap-space-1">
          <Button size="sm" variant="outlined" color="secondary" onClick={openImport} disabled={loading}>Import</Button>
          <Button size="sm" color="primary" onClick={() => addExample()} disabled={loading}>New</Button>
        </div>
      </div>
      {/* Run several tests at once, like an IDE's test explorer. Both confirm first: every test is a real agent
          run per repetition. "Failing" is every test whose newest result is red, amber or errored. */}
      <div className="flex flex-wrap gap-space-1">
        <Button size="sm" variant="outlined" color="secondary" onClick={() => setConfirmBatch('all')} disabled={loading || !savedExamples.length}>
          Run all ({savedExamples.length})
        </Button>
        <Button size="sm" variant="outlined" color="secondary" onClick={() => setConfirmBatch('failing')} disabled={loading || !failingExamples.length}>
          Run failing ({failingExamples.length})
        </Button>
      </div>
      {confirmBatch ? (
        <div className="flex flex-col gap-space-1 rounded-md border border-default p-space-2 text-xs text-secondary">
          <span>
            Run {batchFor(confirmBatch).length} test{batchFor(confirmBatch).length === 1 ? '' : 's'} × {repetitions} repetition{repetitions === 1 ? '' : 's'}
            {' '}= {batchFor(confirmBatch).length * repetitions} agent runs, 4 tests at a time?
          </span>
          {(() => {
            const { dollars, unpriced } = estimate(batchFor(confirmBatch));
            return (
              <span className="text-tertiary">
                Estimated agent cost ≈ {formatDollars(dollars)}, from each test's last run
                {unpriced ? ` (${unpriced} test${unpriced === 1 ? ' has' : 's have'} no priced run yet)` : ''}. Excludes grading.
              </span>
            );
          })()}
          <span className="flex gap-space-1">
            <Button size="sm" color="primary" onClick={() => void runBatch(confirmBatch)}>Run</Button>
            <Button size="sm" variant="outlined" color="secondary" onClick={() => setConfirmBatch(null)}>Cancel</Button>
          </span>
        </div>
      ) : null}
      {batchNotice ? <Text variant="xs" color={batchNotice.kind === 'error' ? 'error' : 'tertiary'}>{batchNotice.text}</Text> : null}
      {importing !== 'closed' ? (
        <div className="flex flex-col gap-space-2 rounded-md border border-default bg-surface-level-2 p-space-2">
          <div className="flex flex-col">
            <Text variant="sm" weight="semibold">Import a past run</Text>
            <Text variant="xs" color="tertiary">Its prompt becomes When and its tool calls become mocks.</Text>
          </div>
          <input className={fieldClass} value={pastRunQuery} placeholder="Filter by prompt" aria-label="Filter past runs by prompt"
            onChange={(event) => setPastRunQuery(event.currentTarget.value)} />
          {pastRunError ? <Text variant="xs" color="error">{pastRunError}</Text> : null}
          {!pastRuns && !pastRunError ? (
            <div className="flex items-center gap-space-2 py-space-2"><Spinner size="sm" /><Text variant="xs" color="tertiary">Loading recent runs…</Text></div>
          ) : null}
          {pastRuns ? (() => {
            const q = pastRunQuery.trim().toLowerCase();
            const visible = pastRuns.filter((run) => !run.hidden && (!q || run.prompt.toLowerCase().includes(q)));
            const hidden = pastRuns.filter((run) => run.hidden).length;
            return (
              <>
                <div className="flex max-h-80 flex-col gap-space-1 overflow-y-auto">
                  {visible.length === 0 ? <Text variant="xs" color="tertiary">No importable runs{q ? ' match that filter' : ''}.</Text> : null}
                  {visible.map((run) => (
                    <button key={run.traceId} type="button" disabled={importing === 'busy'} onClick={() => void runImport(run.traceId)}
                      className="flex flex-col gap-px rounded-md border border-default bg-surface-level-1 px-space-2 py-space-1 text-left hover:border-focus disabled:opacity-60">
                      <span className="line-clamp-2 text-xs text-primary">{run.prompt || '(no prompt)'}</span>
                      <span className="text-xs text-tertiary">
                        {importingTrace === run.traceId ? 'Importing…' : [
                          shortDate(run.start),
                          run.traceId in toolCallCounts ? `${toolCallCounts[run.traceId]} tool call${toolCallCounts[run.traceId] === 1 ? '' : 's'}` : '',
                        ].filter(Boolean).join(' · ')}
                      </span>
                    </button>
                  ))}
                </div>
                {hidden ? <Text variant="xs" color="tertiary">{hidden} runs aren't listed: their inputs are hidden.</Text> : null}
              </>
            );
          })() : null}
          <div className="flex gap-space-1 border-t border-default pt-space-2">
            <input className={`${fieldClass} min-w-0 flex-1`} value={importRef} placeholder="…or paste a trace link" aria-label="Trace URL or ID"
              onChange={(event) => setImportRef(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runImport(); }} />
            <Button size="sm" variant="outlined" color="secondary" onClick={() => void runImport()} disabled={importing === 'busy' || !importRef.trim()}>Go</Button>
          </div>
        </div>
      ) : null}
      {importStatus ? <Text variant="xs" color={importStatus.kind === 'error' ? 'error' : 'tertiary'}>{importStatus.text}</Text> : null}
      <div className="flex flex-col gap-space-2">
        {examples.map((example) => {
          const exampleDraft = drafts[example.id];
          const count = exampleDraft?.assertions.filter((row) => row.name).length ?? 0;
          return (
            <RailButton
              key={example.id}
              active={example.id === selectedId}
              title={exampleDraft?.name || 'Untitled test'}
              subtitle={exampleDraft?.description || `${count} assertions`}
              badge={example.isNew ? 'new' : dirtyIds.has(example.id) ? '● unsaved' : `${count} asserts`}
              status={example.isNew ? undefined : activeRuns[example.id] ?? summaries[example.id]?.status}
              stale={!activeRuns[example.id] && staleness(summaries[example.id], example, metadata?.agentCommit) !== null}
              onClick={() => select(example.id)}
            />
          );
        })}
      </div>
    </>
  );

  return (
    <main className="flex h-screen flex-col gap-space-4 overflow-hidden bg-surface-level-1 p-space-4 text-primary">
      <header className="flex flex-col">
        <Text variant="h1">Agent tests</Text>
        <Text variant="sm" color="secondary">
          Given (context, history, mocked tools) · When (prompt) · Assert (assertions and code checks). Tests autosave to the {DATASET_NAME} dataset.
        </Text>
      </header>

      <div className={`grid min-h-0 flex-1 gap-space-4 ${showResults && selected && !selected.isNew ? 'grid-cols-[260px_minmax(0,1fr)_360px]' : 'grid-cols-[260px_minmax(0,1fr)]'}`}>
        <aside className="flex min-h-0 flex-col gap-space-3 overflow-y-auto border-r border-default pr-space-4">{rail}</aside>

        <section className="flex min-h-0 min-w-0 flex-col gap-space-4 overflow-y-auto pr-space-1">
          {loading ? (
            <Card intent="neutral" className="flex min-h-48 items-center justify-center gap-space-3 border border-default">
              <Spinner size="md" />
              <Text variant="sm" color="secondary">Loading tests…</Text>
            </Card>
          ) : loadError ? (
            <Card intent="neutral" className="flex flex-col items-start gap-space-3 border border-error">
              <Text variant="sm" color="error">Could not load tests: {loadError}</Text>
              <Button size="sm" variant="outlined" color="secondary" onClick={() => void load()}>Try again</Button>
            </Card>
          ) : !selected || !draft ? (
            <Card intent="neutral" className="border border-default text-center">
              <Text variant="md" color="secondary">No tests yet. Click New to add one.</Text>
            </Card>
          ) : (
            <>
              <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-space-3 rounded-md border border-default bg-surface-level-1 p-space-3">
                <div className="flex min-w-0 flex-col">
                  <Text variant="md" weight="semibold">{draft.name || 'Untitled test'}</Text>
                  <Text variant="xs" color={notice?.kind === 'error' || built?.error ? 'error' : 'tertiary'}>
                    {built?.error
                      ? `Not saved: ${built.error}`
                      : notice?.text ?? (saving ? 'Saving…' : dirty ? 'Unsaved changes…' : 'All changes saved')}
                  </Text>
                  {!selected.isNew ? (
                    <LastRun summary={summaries[selected.id]} onOpen={() => setShowResults(true)}
                      stale={dirty ? 'the test has unsaved edits' : staleness(summaries[selected.id], selected, metadata?.agentCommit)} />
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-space-2">
                  {!selected.isNew && metadata?.workspaceId ? (
                    <Button size="sm" variant="outlined" color="secondary" onClick={openInLangSmith}>Open in LangSmith</Button>
                  ) : null}
                  {!selected.isNew ? (
                    <Button size="sm" variant={showResults ? 'normal' : 'outlined'} color="secondary" onClick={() => setShowResults(!showResults)}>Results</Button>
                  ) : null}
                  {confirmDelete ? (
                    <>
                      <Button size="sm" color="error" onClick={() => void remove()} disabled={saving}>Confirm delete</Button>
                      <Button size="sm" variant="outlined" color="secondary" onClick={() => setConfirmDelete(false)}>Cancel</Button>
                    </>
                  ) : (
                    <ActionsMenu label="Test actions" items={[
                      { label: 'Duplicate', onSelect: () => addExample(draft) },
                      { label: 'Delete…', danger: true, disabled: saving, onSelect: () => setConfirmDelete(true) },
                    ]} />
                  )}
                </div>
              </div>

              <Section>
                <div className="grid grid-cols-[minmax(0,240px)_minmax(0,1fr)] gap-space-3">
                  <TextField label="Name" value={draft.name} onChange={(name) => patchDraft({ name: name.toLowerCase().replace(/[\s_]+/g, '-') })} placeholder="refund-service-down" mono />
                  <TextAreaField label="Description" value={draft.description} onChange={(description) => patchDraft({ description })} rows={1} maxRows={5} placeholder="What this test covers" />
                </div>
              </Section>

              {/* Given is everything true before the prompt arrives: the agent's setup (context), the conversation so
                  far (history) and what its tools answer (mocks). When is only the new message. */}
              <Section title="Given (environment)" hint="The world the agent runs in, before the prompt arrives."
                summary={[
                  `${draft.mockTools.length} mock tool${draft.mockTools.length === 1 ? '' : 's'}`,
                  draft.history.length ? `${draft.history.length} earlier turn${draft.history.length === 1 ? '' : 's'}` : '',
                  draft.context.trim() ? 'context' : '',
                ].filter(Boolean).join(' · ')}>
                <div className="flex flex-col gap-space-1">
                  <TextAreaField label="Context (JSON object passed to the agent hook; empty = none)" value={draft.context} onChange={(context) => patchDraft({ context })}
                    rows={draft.context ? Math.min(12, draft.context.split('\n').length + 1) : 2} mono placeholder='{"now": "2026-10-03T09:00:00Z", "flags": {"beta": true}}' />
                  {contextProblem(draft.context) ? <span className="text-xs text-error-primary">{contextProblem(draft.context)}</span> : null}
                </div>
                <HistoryEditor history={draft.history} onChange={(history) => patchDraft({ history })} />
                <Subsection
                  title="Mock tools"
                  hint={`Every tool the agent may call in this test, with what it returns. A call to a tool that isn't listed makes the run an error: the test is incomplete, so it isn't graded.${
                    text(selected.inputs.recorded_on) ? ` Recorded ${text(selected.inputs.recorded_on)}: on each run, dates in these responses move forward by the days since then, so the data stays as fresh as it was that day.` : ''
                  }`}
                  addLabel="Add mock"
                  onAdd={() => patchDraft({ mockTools: [...draft.mockTools, { key: keyId(), tool: '', response: '', cases: null }] })}
                >
                  {draft.mockTools.length === 0 ? <Text variant="xs" color="tertiary">None, so every tool call fails.</Text> : null}
                  {draft.mockTools.map((mock) => (
                    <MockToolEditor key={mock.key} mock={mock} tools={tools} onChange={(patch) => patchRow('mockTools', mock.key, patch)}
                      onRemove={() => removeRow('mockTools', mock.key)} />
                  ))}
                </Subsection>
              </Section>

              <Section title="When (input)" hint="The new message the agent is sent." summary={draft.prompt}>
                <TextAreaField value={draft.prompt} onChange={(prompt) => patchDraft({ prompt })} rows={3} placeholder="Order A1001 arrived broken, can I get my money back?" />
              </Section>

              <Section title="Assert (output)" hint="Each assertion is one sentence that must be true of the run. An LLM judge grades each one against the transcript and tool calls; its name becomes the feedback key."
                summary={`${draft.assertions.length} assertion${draft.assertions.length === 1 ? '' : 's'}: ${draft.assertions.map((row) => row.name).join(', ')}${draft.checks.length ? ` · ${draft.checks.length} code check${draft.checks.length === 1 ? '' : 's'}` : ''}`}>
                {draft.assertions.map((row) => (
                  <div key={row.key} className="flex flex-col gap-space-2 rounded-md border border-default bg-surface-level-1 p-space-3">
                    <div className="flex items-center gap-space-2">
                      <div className="w-64"><TextField value={row.name} onChange={(name) => patchRow('assertions', row.key, { name: name.toLowerCase().replace(/[\s_]+/g, '-') })} placeholder="assertion-name" mono /></div>
                      <div className="flex-1" />
                      <ResultChip result={summaries[selected.id]?.keys[row.name]} ranAt={summaries[selected.id]?.ranAt ?? ''} stale={selectedStale} onOpen={() => setShowResults(true)} />
                      <RemoveButton label={`Remove assertion ${row.name}`} onClick={() => removeRow('assertions', row.key)} />
                    </div>
                    <TextAreaField value={row.assertion} onChange={(assertion) => patchRow('assertions', row.key, { assertion })} rows={2} placeholder="It tells the customer the refund could not be processed right now." />
                  </div>
                ))}
                <div>
                  <Button size="sm" variant="outlined" color="secondary" onClick={() => patchDraft({ assertions: [...draft.assertions, { key: keyId(), name: '', assertion: '' }] })}>
                    Add assertion
                  </Button>
                </div>
                <Subsection title="Code checks" hint="Deterministic checks on the tool calls, with no judge. Each name becomes a feedback key (1 or 0), like an assertion."
                  addLabel="Add check" onAdd={() => patchDraft({ checks: [...draft.checks, emptyCheck()] })}>
                  {draft.checks.length === 0 ? <Text variant="xs" color="tertiary">None.</Text> : null}
                  {draft.checks.map((check) => (
                    <CheckEditor key={check.key} check={check} tools={tools} onChange={(patch) => patchRow('checks', check.key, patch)} onRemove={() => removeRow('checks', check.key)}
                      result={<ResultChip result={summaries[selected.id]?.keys[check.name]} ranAt={summaries[selected.id]?.ranAt ?? ''} stale={selectedStale} onOpen={() => setShowResults(true)} />} />
                  ))}
                </Subsection>
              </Section>

              <div className="flex flex-col items-center gap-space-2 pb-space-4">
                <div className="flex items-center gap-space-2">
                  <select className="rounded-md border border-default bg-surface-level-1 px-space-2 py-space-2 text-sm text-primary shadow-sm outline-none focus:border-focus"
                    aria-label="Repetitions" value={repetitions} onChange={(event) => setRepetitions(Number(event.currentTarget.value))}>
                    {REPETITION_CHOICES.map((n) => <option key={n} value={n}>{n} repetition{n === 1 ? '' : 's'}</option>)}
                  </select>
                  <Button color="primary" onClick={() => void runTest()} disabled={selected.isNew || dirty || running}>
                    {running ? 'Starting…' : 'Run test'}
                  </Button>
                </div>
                <Text variant="xs" color={runStatus?.kind === 'error' ? 'error' : 'tertiary'}>
                  {runStatus?.text ?? (selected.isNew || dirty ? (built?.error ? 'Finish the test before running it.' : 'Saving…') : 'Runs the real agent against these mocks, in parallel, and grades every assertion on every run.')}
                </Text>
              </div>
            </>
          )}
        </section>
        {showResults && selected && !selected.isNew && dataset ? (
          <ResultsPanel key={selected.id} datasetId={dataset.id} example={selected} workspaceId={metadata?.workspaceId} onClose={() => setShowResults(false)} />
        ) : null}
      </div>
    </main>
  );
}
