import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@langchain/macaw-components/Button';
import { Card } from '@langchain/macaw-components/Card';
import { Spinner } from '@langchain/macaw-components/Spinner';
import { Text } from '@langchain/macaw-components/Text';
import { fieldClass, RemoveButton, Section, Subsection, TextAreaField, TextField } from './components/fields';
import { ActionsMenu } from './components/ActionsMenu';
import { contentHash } from './lib/contentHash';
import { AssertionDrilldown } from './components/AssertionDrilldown';
import { LastRun } from './components/LastRun';
import { ResultChip } from './components/ResultChip';
import { CheckEditor } from './components/CheckEditor';
import { HistoryEditor } from './components/HistoryEditor';
import { FilesEditor } from './components/FilesEditor';
import { MockToolEditor } from './components/MockToolEditor';
import { ResultsPanel } from './components/ResultsPanel';
import { SourcePanel } from './components/SourcePanel';
import { TracePreview } from './components/TracePreview';
import {
  acceptProposal, assertionHints, autoCheckName, contextProblem, countToolCalls, deleteExample, emptyCheck, emptyExample, errorMessage, fetchAllExamples, fetchDataset, fetchPastRuns, fetchTrace, isRecord,
  fetchProposalQueue, fetchQueuedRuns, fetchResults, fetchRunFeedback, fetchStatuses, importTrace, isDirty, isProposal, keyId, proposalExample, removeFromQueue,
  saveExampleTo, setKnownBug, shortDate, slugify, staleness, testFiles, text, toDraft, toPayload, traceIdFrom, withFiles,
  type Dataset, type Draft, type Example, type MockGap, type PastRun, type QueuedRun, type SourceFeedback, type TestStatus, type TestSummary, type Trace,
} from './lib/data';
import { fetchActiveRuns, isWeb, requestRun, requestRuns, requestSuggestions } from './runs';

const AUTOSAVE_MS = 800;
const REPETITION_CHOICES = [1, 3, 5];

type Notice = { kind: 'error' | 'success'; text: string } | null;

// The newest run's verdict, as a dot before the test's name, like an IDE's test explorer.
type ListStatus = TestStatus | 'queued' | 'running';

const STATUS_DOT: Record<ListStatus, { glyph: string; color: string; label: string }> = {
  running: { glyph: '◐', color: 'text-secondary animate-spin', label: 'Running now' },
  queued: { glyph: '◌', color: 'text-tertiary', label: 'Queued: waits for a free slot (8 tests run at a time; EVAL_PARALLEL changes it)' },
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
  // Each test's content hash as it is now (contentHash.ts), compared with the one its newest run recorded.
  const [hashes, setHashes] = useState<Record<string, string>>({});
  // Runs queued or in progress on the server, by example id (web mode), and a counter that re-reads the dots.
  const [activeRuns, setActiveRuns] = useState<Record<string, 'queued' | 'running'>>({});
  const [statusTick, setStatusTick] = useState(0);
  const [confirmBatch, setConfirmBatch] = useState<'all' | 'failing' | null>(null);
  const [batchNotice, setBatchNotice] = useState<Notice>(null);
  // Why the selected test's newest run errored, for the header. Read only for an errored test: one small request.
  const [lastError, setLastError] = useState('');
  // The assertion or check whose grades are open beside what the agent did (AssertionDrilldown).
  const [drill, setDrill] = useState<{ kind: 'assertion' | 'check'; name: string } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Accepting a proposal as a known bug asks for the reason first (null: not asking).
  const [knownBugReason, setKnownBugReason] = useState<string | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    Promise.all(examples.filter((e) => !e.isNew).map(async (e) => [e.id, await contentHash(e.inputs, e.outputs)] as const))
      .then((pairs) => { if (!cancelled) setHashes(Object.fromEntries(pairs)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [examples]);

  useEffect(() => setDrill(null), [selectedId]);

  const selectedStatus = selectedId ? summaries[selectedId]?.status : undefined;
  const selectedName = selectedId ? text(examples.find((e) => e.id === selectedId)?.metadata.name) : '';
  useEffect(() => {
    setLastError('');
    if (!dataset || !selectedId || selectedStatus !== 'error') return;
    let cancelled = false;
    fetchResults(dataset.id, selectedId, selectedName)
      .then((results) => { if (!cancelled) setLastError(results.find((r) => r.error)?.error ?? ''); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [dataset, selectedId, selectedStatus, selectedName]);

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
  const [importing, setImporting] = useState<'closed' | 'open'>('closed');
  const [importRef, setImportRef] = useState('');
  const [importStatus, setImportStatus] = useState<Notice>(null);
  const [pastRuns, setPastRuns] = useState<PastRun[] | null>(null);
  const [pastRunError, setPastRunError] = useState<string | null>(null);
  const [pastRunQuery, setPastRunQuery] = useState('');
  const [toolCallCounts, setToolCallCounts] = useState<Record<string, number>>({});
  // A flagged trace or past run being read before it becomes a proposal (TracePreview). Nothing is written yet.
  const [preview, setPreview] = useState<{
    source: 'flagged' | 'past run'; traceId: string; queueRunId?: string; trace: Trace | null; feedback: SourceFeedback[]; error: string;
  } | null>(null);
  const [making, setMaking] = useState(false);
  // Suggest assertions on a proposal (web mode): the test it is for while drafting, then what came of it.
  const [suggesting, setSuggesting] = useState<string | null>(null);
  const [suggestNotice, setSuggestNotice] = useState<Notice>(null);
  const previewing = useRef('');
  const [showResults, setShowResults] = useState(false);
  const [repetitions, setRepetitions] = useState(3);
  const [running, setRunning] = useState(false);
  const [runStatus, setRunStatus] = useState<Notice>(null);
  // The proposals inbox: the annotation queue's runs (flagged traces). A run that has been opened is a proposal
  // example (metadata.source_run_id) and is listed as that instead.
  const [queueId, setQueueId] = useState<string | null>(null);
  const [queued, setQueued] = useState<QueuedRun[]>([]);
  const [queueNotice, setQueueNotice] = useState<Notice>(null);

  const loadQueue = useCallback(async () => {
    try {
      const id = await fetchProposalQueue();
      setQueueId(id);
      setQueued(id ? await fetchQueuedRuns(id) : []);
    } catch (error) {
      setQueueNotice({ kind: 'error', text: `Could not read the proposals queue: ${errorMessage(error)}` });
    }
  }, []);

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
    void loadQueue();
    // New flagged traces arrive by run rule at any time.
    const timer = window.setInterval(() => void loadQueue(), 60000);
    return () => window.clearInterval(timer);
  }, [load, loadQueue]);

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
    setPreview(null);
    setSuggestNotice(null);
    setNotice(null);
    setQueueNotice(null);
    setConfirmDelete(false);
    setRunStatus(null);
  };

  const patchDraft = (patch: Partial<Draft>) => {
    if (!selectedId) return;
    setDrafts((current) => ({ ...current, [selectedId]: { ...current[selectedId], ...patch } }));
  };

  function patchRow<K extends 'mockTools' | 'assertions' | 'checks'>(field: K, key: string, patch: Partial<Draft[K][number]>) {
    if (!draft) return;
    patchDraft({ [field]: (draft[field] as { key: string }[]).map((row) => (row.key === key ? withAutoName(field, row, { ...row, ...patch }, patch) : row)) } as Partial<Draft>);
  }

  // An assertion or check that still has its generated name (or none) is renamed as it's written, so nobody has to
  // invent a feedback key before they can save. A name the expert typed is never touched.
  function withAutoName(field: string, before: object, after: object, patch: object) {
    if ('name' in patch) return after;
    if (field === 'assertions') {
      const [b, a] = [before as Draft['assertions'][number], after as Draft['assertions'][number]];
      return !b.name || b.name === slugify(b.assertion) ? { ...a, name: slugify(a.assertion) } : a;
    }
    if (field === 'checks') {
      const [b, a] = [before as Draft['checks'][number], after as Draft['checks'][number]];
      return !b.name || b.name === autoCheckName(b) || b.name === b.type.replace(/_/g, '-') ? { ...a, name: autoCheckName(a) } : a;
    }
    return after;
  }

  // "Add this mock" from a run that hit a gap: a mock for the tool, or a case for these arguments on an existing one.
  const addMockForGap = (gap: MockGap) => {
    if (!draft) return;
    const when = Object.keys(gap.args).length ? JSON.stringify(gap.args) : '';
    const existing = draft.mockTools.find((mock) => mock.tool === gap.tool);
    if (!existing) {
      patchDraft({ mockTools: [...draft.mockTools, { key: keyId(), tool: gap.tool, response: '', cases: when ? [{ key: keyId(), when, response: '' }] : null }] });
    } else {
      const cases = existing.cases ?? [{ key: keyId(), when: '', response: existing.response }];
      patchRow('mockTools', existing.key, { cases: [{ key: keyId(), when, response: '' }, ...cases], response: '' });
    }
    setNotice({ kind: 'success', text: `Added a mock for ${gap.tool} under Given. Fill in what it returns, then run again.` });
  };

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

  // A trace becomes a proposal, not a test: it joins the eval set only once the expert accepts it.
  const importAsProposal = (trace: Trace, feedback: SourceFeedback[], queueRunId?: string) => {
    const { draft: imported, recordedOn, toolCalls, sourceOutput } = importTrace(trace);
    const example = proposalExample(imported.prompt, recordedOn, trace.traceId, queueRunId, { output: sourceOutput, feedback });
    setExamples((current) => [...current, example]);
    setDrafts((current) => ({ ...current, [example.id]: imported }));
    select(example.id);
    const turns = imported.history.filter((turn) => turn.role === 'user').length;
    return `Imported as a proposal: ${toolCalls} tool call${toolCalls === 1 ? '' : 's'} as ${imported.mockTools.length} mock${imported.mockTools.length === 1 ? '' : 's'}`
      + `${turns ? `, ${turns} earlier turn${turns === 1 ? '' : 's'} as history` : ''}. Add assertions, then run it.`;
  };

  // Reads a trace for the preview. The feedback that flagged it (a thumbs-down and its comment) sits on the queued
  // run, or on the trace's root run.
  const openPreview = async (source: 'flagged' | 'past run', traceId: string, queueRunId?: string) => {
    previewing.current = traceId;
    setPreview({ source, traceId, queueRunId, trace: null, feedback: [], error: '' });
    setQueueNotice(null);
    setImportStatus(null);
    try {
      const trace = await fetchTrace(traceId, tools);
      const feedback = await fetchRunFeedback(queueRunId || text(trace.root.id)).catch(() => []);
      if (previewing.current === traceId) setPreview((current) => (current?.traceId === traceId ? { ...current, trace, feedback } : current));
    } catch (error) {
      if (previewing.current === traceId) setPreview((current) => (current?.traceId === traceId ? { ...current, error: errorMessage(error) } : current));
    }
  };

  const makeProposal = () => {
    if (!preview?.trace) return;
    setMaking(true);
    try {
      const message = importAsProposal(preview.trace, preview.feedback, preview.queueRunId);
      if (preview.source === 'flagged') setQueueNotice({ kind: 'success', text: message });
      else {
        setImportRef('');
        setImporting('closed');
        setImportStatus({ kind: 'success', text: message });
      }
      setPreview(null);
    } catch (error) {
      setPreview({ ...preview, error: errorMessage(error) });
    } finally {
      setMaking(false);
    }
  };

  const openQueued = (run: QueuedRun) => void openPreview('flagged', run.traceId, run.runId);

  const dismissQueued = async (run: QueuedRun) => {
    if (!queueId) return;
    try {
      await removeFromQueue(queueId, run.runId);
      setQueued((current) => current.filter((row) => row.runId !== run.runId));
    } catch (error) {
      setQueueNotice({ kind: 'error', text: `Could not dismiss it: ${errorMessage(error)}` });
    }
  };

  // Drafts 2-4 assertions from everything known about the proposal's run (the agent's instructions and tools, the
  // conversation, the tool results, the original reply and the flag). They go in as ordinary rows (an empty one is
  // replaced), named from their sentences, for the expert to edit or delete.
  const suggestAssertions = async () => {
    if (!selected || !draft) return;
    const id = selected.id;
    setSuggesting(id);
    setSuggestNotice(null);
    try {
      const feedback = Array.isArray(selected.metadata.source_feedback) ? selected.metadata.source_feedback.filter(isRecord) : [];
      const existing = draft.assertions.map((row) => row.assertion.trim()).filter(Boolean);
      // The test as it would be saved: its history and mocks are what the run saw before and during the reply.
      const inputs = toPayload(selected, draft).payload?.inputs ?? {};
      const sentences = await requestSuggestions({
        prompt: draft.prompt, reply: text(selected.metadata.source_output), feedback, existing,
        history: Array.isArray(inputs.history) ? inputs.history.filter(isRecord) : [],
        mocks: isRecord(inputs.mock_tools) ? inputs.mock_tools : {},
        traceId: text(selected.metadata.source_trace_id),
      });
      setDrafts((current) => {
        if (!current[id]) return current;
        const kept = current[id].assertions.filter((row) => row.assertion.trim() || row.name);
        const added = sentences.map((assertion) => ({ key: keyId(), name: slugify(assertion), assertion }));
        return { ...current, [id]: { ...current[id], assertions: [...kept, ...added] } };
      });
      setSuggestNotice({ kind: 'success', text: sentences.length
        ? `Added ${sentences.length} suggested assertion${sentences.length === 1 ? '' : 's'} below. Edit or delete any that don't say what you mean.`
        : 'No suggestions came back.' });
    } catch (error) {
      setSuggestNotice({ kind: 'error', text: `Could not suggest assertions: ${errorMessage(error)}` });
    } finally {
      setSuggesting(null);
    }
  };

  const runImport = (picked?: string) => {
    const traceId = picked ?? traceIdFrom(importRef);
    if (!traceId) {
      setImportStatus({ kind: 'error', text: 'Paste a trace URL or trace ID.' });
      return;
    }
    void openPreview('past run', traceId);
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
      // Deleting a proposal also takes its trace out of the queue, so it isn't proposed again.
      const queueRun = text(selected.metadata.source_run_id);
      if (isProposal(selected) && queueId && queueRun) {
        await removeFromQueue(queueId, queueRun).catch(() => undefined);
        setQueued((current) => current.filter((row) => row.runId !== queueRun));
      }
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

  const accept = async (knownBug?: string) => {
    if (!selected || selected.isNew || dirty) return;
    setSaving(true);
    try {
      const accepted = await acceptProposal(selected, knownBug);
      setKnownBugReason(null);
      setExamples((current) => current.map((row) => (row.id === accepted.id ? accepted : row)));
      const queueRun = text(selected.metadata.source_run_id);
      if (queueId && queueRun) {
        await removeFromQueue(queueId, queueRun).catch(() => undefined);
        setQueued((current) => current.filter((row) => row.runId !== queueRun));
      }
      setNotice({ kind: 'success', text: knownBug
        ? 'Accepted as a known bug: it is expected to fail until the agent is fixed, and the CLI flags it once it passes.'
        : 'Accepted: it is part of the eval set now.' });
    } catch (error) {
      setNotice({ kind: 'error', text: `Accept failed: ${errorMessage(error)}` });
    } finally {
      setSaving(false);
    }
  };

  // The eval set is every test that isn't a proposal; Run all, Run failing and the CLI work on it alone.
  const savedExamples = examples.filter((e) => !e.isNew && !isProposal(e));
  const proposalExamples = examples.filter(isProposal);
  const openedRuns = new Set(examples.map((e) => text(e.metadata.source_run_id)).filter(Boolean));
  const inbox = queued.filter((run) => !openedRuns.has(run.runId) && !run.hidden);
  const selectedStale = selected && !selected.isNew
    ? (dirty ? 'the test has unsaved edits' : staleness(summaries[selected.id], hashes[selected.id], metadata?.agentCommit, metadata?.sameAgentCommits))
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

  const railRow = (example: Example) => {
    const exampleDraft = drafts[example.id];
    const count = exampleDraft?.assertions.filter((row) => row.name).length ?? 0;
    return (
      <RailButton
        key={example.id}
        active={example.id === selectedId}
        title={exampleDraft?.name || 'Untitled test'}
        subtitle={exampleDraft?.description || `${count} assertions`}
        badge={example.isNew ? 'new' : dirtyIds.has(example.id) ? '● unsaved' : `${count} asserts`}
        status={example.isNew ? undefined : activeRuns[example.id] ?? (summaries[example.id]?.runningElsewhere ? 'running' : summaries[example.id]?.status)}
        stale={!activeRuns[example.id] && staleness(summaries[example.id], hashes[example.id], metadata?.agentCommit, metadata?.sameAgentCommits) !== null}
        onClick={() => select(example.id)}
      />
    );
  };

  // Proposals first: the staging ground. Flagged traces not opened yet, then proposals being shaped into tests.
  const proposalsSection = (
    <div className="flex flex-col gap-space-2 border-b border-default pb-space-3">
      <div className="flex flex-col">
        <Text variant="md" weight="semibold">Proposals ({inbox.length + proposalExamples.length})</Text>
        <Text variant="xs" color="tertiary">
          {queueId ? 'Flagged traces and imports. Add assertions, run until the grades are consistent, then Accept into the eval set.'
            : 'No proposals queue yet: start the server once (server/proposals.py creates it).'}
        </Text>
      </div>
      {inbox.map((run) => (
        <div key={run.runId} className="flex items-start gap-space-1 rounded-md border border-dashed border-default bg-surface-level-1 px-space-3 py-space-2">
          <button type="button" className="flex min-w-0 flex-1 flex-col text-left" onClick={() => openQueued(run)}>
            <span className="flex items-center gap-space-1 text-sm">
              <span className="shrink-0 rounded-sm bg-brand-subtle px-space-1 text-xs text-primary">flagged</span>
              <span className="truncate text-secondary">{preview?.queueRunId === run.runId ? 'Previewing' : shortDate(run.start)}</span>
            </span>
            <span className="line-clamp-2 text-xs text-primary">{run.prompt || '(no prompt)'}</span>
            {run.turns ? <span className="text-xs text-tertiary">{run.turns} earlier turn{run.turns === 1 ? '' : 's'}</span> : null}
          </button>
          <button type="button" aria-label="Dismiss this flagged trace" title="Dismiss: take it out of the queue"
            className="rounded-md px-space-1 text-tertiary hover:bg-surface-level-2 hover:text-primary" onClick={() => void dismissQueued(run)}>×</button>
        </div>
      ))}
      {proposalExamples.map(railRow)}
      {!inbox.length && !proposalExamples.length && queueId ? <Text variant="xs" color="tertiary">Nothing waiting.</Text> : null}
      {queueNotice ? <Text variant="xs" color={queueNotice.kind === 'error' ? 'error' : 'tertiary'}>{queueNotice.text}</Text> : null}
    </div>
  );

  const rail = (
    <>
      {proposalsSection}
      <div className="flex items-center justify-between">
        <Text variant="md" weight="semibold">Tests ({savedExamples.length})</Text>
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
            {' '}= {batchFor(confirmBatch).length * repetitions} agent runs, 8 tests at a time?
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
            <Text variant="sm" weight="semibold">Import a past run as a proposal</Text>
            <Text variant="xs" color="tertiary">Click one to read it first. Its last message becomes When, the turns before it History, and its tool calls mocks.</Text>
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
                    <button key={run.traceId} type="button" onClick={() => runImport(run.traceId)}
                      className={`flex flex-col gap-px rounded-md border bg-surface-level-1 px-space-2 py-space-1 text-left hover:border-focus ${preview?.traceId === run.traceId ? 'border-focus' : 'border-default'}`}>
                      <span className="line-clamp-2 text-xs text-primary">{run.prompt || '(no prompt)'}</span>
                      <span className="text-xs text-tertiary">
                        {preview?.traceId === run.traceId ? 'Previewing' : [
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
              onChange={(event) => setImportRef(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') runImport(); }} />
            <Button size="sm" variant="outlined" color="secondary" onClick={() => runImport()} disabled={!importRef.trim()}>Preview</Button>
          </div>
        </div>
      ) : null}
      {importStatus ? <Text variant="xs" color={importStatus.kind === 'error' ? 'error' : 'tertiary'}>{importStatus.text}</Text> : null}
      <div className="flex flex-col gap-space-2">
        {examples.filter((e) => !isProposal(e)).map(railRow)}
      </div>
    </>
  );

  return (
    <main className="flex h-screen flex-col gap-space-4 overflow-hidden bg-surface-level-1 p-space-4 text-primary">
      <header className="flex flex-col">
        <Text variant="h1">Agent tests</Text>
        
      </header>

      <div className={`grid min-h-0 flex-1 gap-space-4 ${showResults && selected && !selected.isNew && !preview ? 'grid-cols-[260px_minmax(0,1fr)_360px]' : 'grid-cols-[260px_minmax(0,1fr)]'}`}>
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
          ) : preview ? (
            <TracePreview source={preview.source} trace={preview.trace} feedback={preview.feedback} error={preview.error} making={making}
              onMake={makeProposal} onCancel={() => setPreview(null)} onRetry={() => void openPreview(preview.source, preview.traceId, preview.queueRunId)} />
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
                    <LastRun summary={summaries[selected.id]} error={lastError} onOpen={() => setShowResults(true)}
                      onRun={dirty || running ? undefined : () => void runTest()}
                      stale={dirty ? 'the test has unsaved edits' : staleness(summaries[selected.id], hashes[selected.id], metadata?.agentCommit, metadata?.sameAgentCommits)} />
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
                      { label: isProposal(selected) ? 'Delete proposal…' : 'Delete…', danger: true, disabled: saving, onSelect: () => setConfirmDelete(true) },
                    ]} />
                  )}
                </div>
              </div>

              {isProposal(selected) ? (
                <div className="flex flex-wrap items-center justify-between gap-space-3 rounded-md border border-dashed border-focus bg-brand-subtle p-space-3">
                  <div className="flex min-w-0 flex-col">
                    <Text variant="sm" weight="semibold">Proposal · not in the eval set yet</Text>
                    <Text variant="xs" color="secondary">
                      Write assertions for what the agent should have done, fill in any missing mocks, and run it until the grades agree.
                      A flagged trace is usually a known bug: accept it as one to keep it in the set, expected to fail until the agent is fixed.
                      Until you accept it, Run all and the CLI skip it.
                    </Text>
                  </div>
                  <div className="flex flex-wrap items-center gap-space-2">
                    {knownBugReason === null ? (
                      <>
                        <Button size="sm" variant="outlined" color="secondary" onClick={() => setKnownBugReason('')} disabled={selected.isNew || dirty || saving}
                          title={selected.isNew || dirty ? 'Save the proposal first' : 'It fails today and should, until the agent is fixed'}>
                          Accept as known bug
                        </Button>
                        <Button size="sm" color="primary" onClick={() => void accept()} disabled={selected.isNew || dirty || saving}
                          title={selected.isNew || dirty ? 'Save the proposal first' : 'It passes today and must keep passing'}>
                          Accept as passing
                        </Button>
                      </>
                    ) : (
                      <>
                        <input className={`${fieldClass} w-72`} autoFocus value={knownBugReason} placeholder="What's wrong today, e.g. promises refunds over $200"
                          aria-label="Known bug reason" onChange={(event) => setKnownBugReason(event.currentTarget.value)}
                          onKeyDown={(event) => { if (event.key === 'Enter' && knownBugReason.trim()) void accept(knownBugReason.trim()); }} />
                        <Button size="sm" color="primary" onClick={() => void accept(knownBugReason.trim())} disabled={!knownBugReason.trim() || saving}>Accept</Button>
                        <Button size="sm" variant="outlined" color="secondary" onClick={() => setKnownBugReason(null)}>Cancel</Button>
                      </>
                    )}
                  </div>
                </div>
              ) : null}
              {isProposal(selected) ? <SourcePanel example={selected} /> : null}
              {!isProposal(selected) && text(selected.metadata.xfail) ? (
                <div className="flex flex-wrap items-center justify-between gap-space-2 rounded-md border border-warning bg-warning-subtle p-space-2 text-xs">
                  <span className="text-primary"><span className="font-semibold">Known bug:</span> {text(selected.metadata.xfail)}. Expected to fail until the agent is fixed; the CLI flags it once it passes.</span>
                  <button type="button" className="text-secondary underline hover:text-primary" disabled={saving}
                    onClick={() => void setKnownBug(selected, null).then((updated) => setExamples((current) => current.map((row) => (row.id === updated.id ? updated : row))))
                      .catch((error) => setNotice({ kind: 'error', text: errorMessage(error) }))}>
                    It's fixed: clear the mark
                  </button>
                </div>
              ) : null}

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
                  // Counted as the user's turns, the same way the proposal cards count them.
                  draft.history.some((t) => t.role === 'user') ? `${draft.history.filter((t) => t.role === 'user').length} earlier turn${draft.history.filter((t) => t.role === 'user').length === 1 ? '' : 's'}` : '',
                  draft.context.trim() ? 'context' : '',
                  testFiles(selected).length ? `${testFiles(selected).length} file${testFiles(selected).length === 1 ? '' : 's'}` : '',
                ].filter(Boolean).join(' · ')}>
                <div className="flex flex-col gap-space-1">
                  <TextAreaField label="Context (JSON object passed to the agent hook; empty = none)" value={draft.context} onChange={(context) => patchDraft({ context })}
                    rows={draft.context ? Math.min(12, draft.context.split('\n').length + 1) : 2} mono placeholder='Leave empty unless the agent needs setup. e.g. {"customer_tier": "gold"}' />
                  {contextProblem(draft.context) ? <span className="text-xs text-error-primary">{contextProblem(draft.context)}</span> : null}
                </div>
                {!selected.isNew ? (
                  <FilesEditor exampleId={selected.id} files={testFiles(selected)}
                    // Saved on the server already; the local copy takes the new list so the next autosave keeps it.
                    onChange={(files) => setExamples((current) => current.map((row) => (row.id === selected.id ? withFiles(row, files) : row)))} />
                ) : null}
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
                      <div className="w-64"><TextField value={row.name} onChange={(name) => patchRow('assertions', row.key, { name: name.toLowerCase().replace(/[\s_]+/g, '-') })} placeholder="named from the sentence" mono /></div>
                      <div className="flex-1" />
                      <ResultChip result={summaries[selected.id]?.keys[row.name]} ranAt={summaries[selected.id]?.ranAt ?? ''} stale={selectedStale}
                        onOpen={() => setDrill(drill?.name === row.name ? null : { kind: 'assertion', name: row.name })} />
                      <RemoveButton label={`Remove assertion ${row.name}`} onClick={() => removeRow('assertions', row.key)} />
                    </div>
                    <TextAreaField value={row.assertion} onChange={(assertion) => patchRow('assertions', row.key, { assertion })} rows={2} placeholder="e.g. It tells the customer what will happen next." />
                    {assertionHints(row.assertion).map((hint) => <span key={hint} className="text-xs text-tertiary">{hint}</span>)}
                    {drill?.kind === 'assertion' && drill.name === row.name && dataset ? (
                      <AssertionDrilldown datasetId={dataset.id} exampleId={selected.id} testName={draft.name} name={row.name} kind="assertion" onClose={() => setDrill(null)} onAddMock={addMockForGap}
                        onRewrite={(assertion) => patchRow('assertions', row.key, { assertion, name: row.name })} />
                    ) : null}
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-space-2">
                  <Button size="sm" variant="outlined" color="secondary" onClick={() => patchDraft({ assertions: [...draft.assertions, { key: keyId(), name: '', assertion: '' }] })}>
                    Add assertion
                  </Button>
                  {/* Needs the server's judge model, so web mode only. */}
                  {isProposal(selected) && isWeb() ? (
                    <Button size="sm" variant="outlined" color="secondary" onClick={() => void suggestAssertions()} disabled={suggesting !== null}
                      title="Drafts 2-4 assertions from the message, the original reply and the flag's comment">
                      {suggesting === selected.id ? 'Suggesting…' : 'Suggest assertions'}
                    </Button>
                  ) : null}
                  {suggestNotice ? <Text variant="xs" color={suggestNotice.kind === 'error' ? 'error' : 'tertiary'}>{suggestNotice.text}</Text> : null}
                </div>
                <Subsection title="Code checks" hint="Deterministic checks on the tool calls, with no judge. Each name becomes a feedback key (1 or 0), like an assertion."
                  addLabel="Add check" onAdd={() => patchDraft({ checks: [...draft.checks, emptyCheck()] })}>
                  {draft.checks.length === 0 ? <Text variant="xs" color="tertiary">None.</Text> : null}
                  {draft.checks.map((check) => (
                    <CheckEditor key={check.key} check={check} tools={tools} onChange={(patch) => patchRow('checks', check.key, patch)} onRemove={() => removeRow('checks', check.key)}
                      result={<ResultChip result={summaries[selected.id]?.keys[check.name]} ranAt={summaries[selected.id]?.ranAt ?? ''} stale={selectedStale}
                        onOpen={() => setDrill(drill?.name === check.name ? null : { kind: 'check', name: check.name })} />} />
                  ))}
                  {drill?.kind === 'check' && dataset && draft.checks.some((c) => c.name === drill.name) ? (
                    <AssertionDrilldown datasetId={dataset.id} exampleId={selected.id} testName={draft.name} name={drill.name} kind="check" onClose={() => setDrill(null)} onAddMock={addMockForGap} />
                  ) : null}

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
        {showResults && selected && !selected.isNew && dataset && !preview ? (
          <ResultsPanel key={selected.id} datasetId={dataset.id} example={selected} workspaceId={metadata?.workspaceId} onClose={() => setShowResults(false)} />
        ) : null}
      </div>
    </main>
  );
}
