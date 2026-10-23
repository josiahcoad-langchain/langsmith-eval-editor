import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@langchain/macaw-components/Button';
import { Card } from '@langchain/macaw-components/Card';
import { Spinner } from '@langchain/macaw-components/Spinner';
import { Text } from '@langchain/macaw-components/Text';
import { fieldClass, Section, Subsection, TextAreaField, TextField } from './components/fields';
import { ActionsMenu } from './components/ActionsMenu';
import { contentHash } from './lib/contentHash';
import { AssertionDrilldown } from './components/AssertionDrilldown';
import { LastRun } from './components/LastRun';
import { ResultChip } from './components/ResultChip';
import { CheckEditor } from './components/CheckEditor';
import { HistoryEditor, nextRole } from './components/HistoryEditor';
import { FilesEditor } from './components/FilesEditor';
import { MockToolEditor, responseSummary } from './components/MockToolEditor';
import { ResultsPanel } from './components/ResultsPanel';
import { SourcePanel } from './components/SourcePanel';
import {
  assertionHints, autoCheckName, contextProblem, countToolCalls, deleteExample, emptyCheck, emptyExample, errorMessage, fetchAllExamples, fetchDataset, fetchPastRuns, fetchTrace, isRecord,
  fetchProposalQueue, fetchQueuedRuns, fetchResults, fetchStatuses, fetchTraceFeedback, importTrace, isDirty, keyId, removeFromQueue,
  nameFromPrompt, saveExampleTo, shortDate, slugify, staleness, testFiles, text, toDraft, toPayload, traceExample, traceIdFrom, withFiles,
  type Dataset, type Draft, type Example, type Json, type MockGap, type PastRun, type QueuedRun, type SourceFeedback, type TestStatus, type TestSummary, type Trace,
} from './lib/data';
import { fetchActiveRuns, isWeb, requestRun, requestRuns, requestSuggestions } from './runs';

const AUTOSAVE_MS = 800;
const REPETITION_CHOICES = [1, 3, 5];

type Notice = { kind: 'error' | 'success'; text: string } | null;

// The newest run's verdict, as a dot before the test's name, like an IDE's test explorer.
type ListStatus = TestStatus | 'queued' | 'running';

const STATUS_DOT: Record<ListStatus, { glyph: string; color: string; label: string }> = {
  running: { glyph: '◐', color: 'text-secondary animate-spin', label: 'Running now' },
  queued: { glyph: '◌', color: 'text-tertiary', label: 'Waiting for a free slot' },
  pass: { glyph: '●', color: 'text-success-primary', label: 'Passed every time' },
  fail: { glyph: '●', color: 'text-error-primary', label: 'Something failed every time' },
  flaky: { glyph: '●', color: 'text-warning-primary', label: 'Passed some times, failed others' },
  error: { glyph: '!', color: 'text-error-primary', label: "Couldn't run" },
  none: { glyph: '○', color: 'text-tertiary', label: 'Never run' },
};

// An out-of-date result keeps its colour but fades, so "was green, has since changed" reads differently from "green".
function StatusDot({ status, stale = false }: { status: ListStatus; stale?: boolean }) {
  const dot = STATUS_DOT[status];
  const label = stale ? `Out of date. ${dot.label}` : dot.label;
  return <span className={`w-3 shrink-0 text-center font-bold ${dot.color} ${stale ? 'opacity-40' : ''}`} title={label} aria-label={label}>{dot.glyph}</span>;
}

function RailButton({ active, title, subtitle, status, stale = false, onClick }: {
  active: boolean; title: string; subtitle: string; status?: ListStatus; stale?: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`rounded-md border px-space-3 py-space-2 text-left text-sm transition ${
        active ? 'border-focus bg-selected text-primary' : 'border-default bg-surface-level-1 text-secondary hover:bg-surface-level-2 hover:text-primary'
      }`}
      onClick={onClick}
    >
      <span className="flex min-w-0 items-center gap-space-1">
        {status ? <StatusDot status={status} stale={stale} /> : null}
        <span className="truncate font-medium">{title}</span>
      </span>
      {subtitle ? <span className="line-clamp-2 text-xs text-tertiary">{subtitle}</span> : null}
    </button>
  );
}

// Names are stored as lowercase-with-dashes (they name the test's experiments); the expert reads and types them as
// plain words. Tests imported before names came from the message are called "trace-<id>": they read as the message.
const LEGACY_TRACE_NAME = /^trace-[0-9a-f]{8}$/;
function titleOf(draft: Draft) {
  return (LEGACY_TRACE_NAME.test(draft.name) && draft.prompt.trim() ? nameFromPrompt(draft.prompt) : draft.name).replace(/-/g, ' ');
}
const nameFrom = (title: string) => title.toLowerCase().replace(/[\s_]+/g, '-');
// "Imported from trace <uuid> (date)." was the old default description: an id, not a description.
const descriptionOf = (draft: Draft) => (/^Imported from trace /.test(draft.description) ? '' : draft.description);

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
  const failedDraft = useRef<Draft | null>(null);
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

  useEffect(() => {
    setDrill(null);
    setHistoryFocus(null);
    setRenaming(new Set());
    // Advanced (context) opens by itself when the test has context.
    setAdvancedOpen(Boolean(selectedId && drafts[selectedId]?.context.trim()));
  }, [selectedId]);

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
  // The trace being imported (flagged or a past run): it becomes a test as soon as it's read.
  const [importingId, setImportingId] = useState<string | null>(null);
  // Given's extras: an earlier message just added (opened for typing), a file picker request, Advanced (context)
  // open, and a counter that opens Given when something lands in it from elsewhere ("Add answer" in a drill-down).
  const [historyFocus, setHistoryFocus] = useState<string | null>(null);
  const [filePick, setFilePick] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [givenSignal, setGivenSignal] = useState(0);
  // Assertions whose name field is showing (⋯ › Rename).
  const [renaming, setRenaming] = useState<Set<string>>(new Set());
  // Suggest assertions on a test imported from a trace (web mode): the test it is for while drafting, then what came of it.
  const [suggesting, setSuggesting] = useState<string | null>(null);
  const [suggestNotice, setSuggestNotice] = useState<Notice>(null);
  // With no feedback anywhere on the trace, Suggest first asks the expert what went wrong (null: not asking).
  const [whatWentWrong, setWhatWentWrong] = useState<string | null>(null);
  const [showResults, setShowResults] = useState(false);
  const [repetitions, setRepetitions] = useState(3);
  const [running, setRunning] = useState(false);
  const [runStatus, setRunStatus] = useState<Notice>(null);
  // Flagged traces: the annotation queue's runs, listed in Import. A run that has been imported is a test
  // (metadata.source_run_id) and is listed as that instead.
  const [queueId, setQueueId] = useState<string | null>(null);
  const [queued, setQueued] = useState<QueuedRun[]>([]);
  const [queueNotice, setQueueNotice] = useState<Notice>(null);

  const loadQueue = useCallback(async () => {
    try {
      const id = await fetchProposalQueue();
      setQueueId(id);
      setQueued(id ? await fetchQueuedRuns(id) : []);
    } catch (error) {
      setQueueNotice({ kind: 'error', text: `Could not read the flagged traces: ${errorMessage(error)}` });
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
    setWhatWentWrong(null);
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
    setGivenSignal((n) => n + 1);
    setNotice({ kind: 'success', text: `Added an answer for ${gap.tool} under Given. Fill it in, then run again.` });
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

  // A trace becomes a test straight away: its message is When, the turns before it earlier messages, its tool calls
  // tool answers. Named from the message, and described by the flag's comment if there is one.
  const importAsTest = (trace: Trace, feedback: SourceFeedback[], queueRunId?: string) => {
    const { draft: imported, recordedOn, sourceOutput } = importTrace(trace, feedback);
    const taken = new Set(Object.values(drafts).map((d) => d.name));
    let name = imported.name;
    for (let n = 2; taken.has(name); n += 1) name = `${imported.name}-${n}`;
    const example = traceExample(imported.prompt, recordedOn, trace.traceId, queueRunId, { output: sourceOutput, feedback });
    setExamples((current) => [...current, example]);
    setDrafts((current) => ({ ...current, [example.id]: { ...imported, name } }));
    select(example.id);
  };

  // Reads the trace with every piece of feedback on any of its runs (any key: a thumbs-down, an online evaluator's
  // score on the model call, a reviewer's correction), then makes the test.
  const importFrom = async (traceId: string, queueRunId?: string) => {
    setImportingId(traceId);
    setImportStatus(null);
    setQueueNotice(null);
    try {
      const trace = await fetchTrace(traceId, tools);
      const feedback = await fetchTraceFeedback(traceId).catch(() => []);
      importAsTest(trace, feedback, queueRunId);
      setImportRef('');
      setImporting('closed');
    } catch (error) {
      setImportStatus({ kind: 'error', text: `Could not import it: ${errorMessage(error)}` });
    } finally {
      setImportingId(null);
    }
  };

  const dismissQueued = async (run: QueuedRun) => {
    if (!queueId) return;
    try {
      await removeFromQueue(queueId, run.runId);
      setQueued((current) => current.filter((row) => row.runId !== run.runId));
    } catch (error) {
      setQueueNotice({ kind: 'error', text: `Could not dismiss it: ${errorMessage(error)}` });
    }
  };

  // Drafts 2-4 assertions from everything known about the imported run (the agent's instructions and tools, the
  // conversation, the tool results, the original reply and the flag). They go in as ordinary rows (an empty one is
  // replaced), named from their sentences, for the expert to edit or delete.
  const suggestAssertions = async (note?: string) => {
    if (!selected || !draft) return;
    const id = selected.id;
    setSuggesting(id);
    setSuggestNotice(null);
    try {
      // Re-read the trace's feedback: an online evaluator or a reviewer may have added some since the import.
      const traceId = text(selected.metadata.source_trace_id);
      const stored = Array.isArray(selected.metadata.source_feedback) ? selected.metadata.source_feedback.filter(isRecord) : [];
      const live = traceId ? await fetchTraceFeedback(traceId).catch(() => null) : null;
      const feedback: Json[] = [...(live && live.length ? live : stored)];
      if (note) feedback.push({ key: 'expert note', score: null, comment: note });
      if (!feedback.length) {
        // Without any feedback the drafter can only guess what went wrong; one line from the expert fixes that.
        setWhatWentWrong('');
        return;
      }
      setWhatWentWrong(null);
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
      if (!sentences.length) setSuggestNotice({ kind: 'success', text: 'No suggestions came back.' });
    } catch (error) {
      setSuggestNotice({ kind: 'error', text: `Could not suggest assertions: ${errorMessage(error)}` });
    } finally {
      setSuggesting(null);
    }
  };

  const runImport = (picked?: string) => {
    const traceId = picked ?? traceIdFrom(importRef);
    if (!traceId) {
      setImportStatus({ kind: 'error', text: 'Paste a trace link.' });
      return;
    }
    void importFrom(traceId);
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
    const built = toPayload(example, exampleDraft).payload;
    if (!built || !dataset || savingIds.current.has(example.id)) return;
    // Proposals are gone from the editor: a test still marked as one (status "proposal") joins the eval set when saved.
    const { status, ...metadata } = built.metadata;
    const payload = status === 'proposal' ? { ...built, metadata } : built;
    savingIds.current.add(example.id);
    setSaving(true);
    try {
      const saved = await saveExampleTo(dataset.id, example, payload);
      setExamples((current) => current.map((row) => (row.id === example.id ? saved : row)));
      // An imported flagged trace leaves the queue once its test exists.
      const queueRun = text(example.metadata.source_run_id);
      if (example.isNew && queueId && queueRun) {
        void removeFromQueue(queueId, queueRun).catch(() => undefined);
        setQueued((current) => current.filter((row) => row.runId !== queueRun));
      }
      if (saved.id !== example.id) {
        setDrafts((current) => {
          const { [example.id]: moved, ...rest } = current;
          return { ...rest, [saved.id]: moved };
        });
        setSelectedId((current) => (current === example.id ? saved.id : current));
      }
      setNotice(null);
    } catch (error) {
      failedDraft.current = exampleDraft;
      setNotice({ kind: 'error', text: `Save failed: ${errorMessage(error)}. It will try again when you next edit the test.` });
    } finally {
      savingIds.current.delete(example.id);
      setSaving(savingIds.current.size > 0);
    }
  };

  // Autosave the open test a moment after the last edit, once it's valid. A draft whose save failed isn't retried
  // until it changes: retrying a persistent error (no permission, LangSmith down) every second would hammer the API.
  useEffect(() => {
    if (!selected || !draft || !dirty || built?.error || failedDraft.current === draft) return;
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
      // Deleting an imported flagged trace also takes it out of the queue, so it isn't offered again.
      const queueRun = text(selected.metadata.source_run_id);
      if (queueId && queueRun) {
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

  // Run all and Run failing work on every saved test.
  const savedExamples = examples.filter((e) => !e.isNew);
  const openedRuns = new Set(examples.map((e) => text(e.metadata.source_run_id)).filter(Boolean));
  const inbox = queued.filter((run) => !openedRuns.has(run.runId) && !run.hidden);
  const selectedStale = selected && !selected.isNew
    ? (dirty ? 'Unsaved edits.' : staleness(summaries[selected.id], hashes[selected.id], metadata?.agentCommit, metadata?.sameAgentCommits))
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
      setBatchNotice({ kind: 'success', text: `Started ${batch.length} test${batch.length === 1 ? '' : 's'}.` });
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
    return (
      <RailButton
        key={example.id}
        active={example.id === selectedId}
        title={exampleDraft ? titleOf(exampleDraft) || 'Untitled test' : 'Untitled test'}
        subtitle={exampleDraft ? descriptionOf(exampleDraft) || exampleDraft.prompt : ''}
        status={example.isNew ? undefined : activeRuns[example.id] ?? (summaries[example.id]?.runningElsewhere ? 'running' : summaries[example.id]?.status)}
        stale={!activeRuns[example.id] && staleness(summaries[example.id], hashes[example.id], metadata?.agentCommit, metadata?.sameAgentCommits) !== null}
        onClick={() => select(example.id)}
      />
    );
  };

  const batchConfirm = confirmBatch ? (() => {
    const count = batchFor(confirmBatch).length;
    const { dollars, unpriced } = estimate(batchFor(confirmBatch));
    return (
      <div className="flex flex-wrap items-center gap-space-2 rounded-md border border-default p-space-2 text-xs text-secondary"
        title={`Each repetition is a real agent run. Cost is from each test's last run${unpriced ? `; ${unpriced} test${unpriced === 1 ? ' has' : 's have'} no priced run yet` : ''}, without grading.`}>
        <span>Run {count} test{count === 1 ? '' : 's'} ×{repetitions}{dollars ? ` (~${formatDollars(dollars)}${unpriced ? '+' : ''})` : ''}?</span>
        <Button size="sm" color="primary" onClick={() => void runBatch(confirmBatch)}>Run</Button>
        <Button size="sm" variant="outlined" color="secondary" onClick={() => setConfirmBatch(null)}>Cancel</Button>
      </div>
    );
  })() : null;

  // Import: flagged traces first (the annotation queue), then recent runs; a pasted link is under More. Picking one
  // makes the test and opens it.
  const importPanel = importing !== 'closed' ? (
    <div className="flex flex-col gap-space-2 rounded-md border border-default bg-surface-level-2 p-space-2">
      {inbox.length ? (
        <>
          <Text variant="xs" weight="semibold">Flagged</Text>
          {inbox.map((run) => (
            <div key={run.runId} className="flex items-start gap-space-1 rounded-md border border-default bg-surface-level-1 px-space-2 py-space-1">
              <button type="button" className="flex min-w-0 flex-1 flex-col text-left" disabled={importingId !== null} onClick={() => void importFrom(run.traceId, run.runId)}>
                <span className="line-clamp-2 text-xs text-primary">{run.prompt || '(no message)'}</span>
                <span className="text-xs text-tertiary">{importingId === run.traceId ? 'Importing…' : shortDate(run.start)}</span>
              </button>
              <button type="button" aria-label="Dismiss this flagged trace" title="Dismiss: take it out of the flagged list"
                className="rounded-md px-space-1 text-tertiary hover:bg-surface-level-2 hover:text-primary" onClick={() => void dismissQueued(run)}>×</button>
            </div>
          ))}
        </>
      ) : null}
      {queueNotice ? <Text variant="xs" color={queueNotice.kind === 'error' ? 'error' : 'tertiary'}>{queueNotice.text}</Text> : null}
      <Text variant="xs" weight="semibold">Recent runs</Text>
      <input className={fieldClass} value={pastRunQuery} placeholder="Filter" aria-label="Filter recent runs"
        onChange={(event) => setPastRunQuery(event.currentTarget.value)} />
      {pastRunError ? <Text variant="xs" color="error">{pastRunError}</Text> : null}
      {!pastRuns && !pastRunError ? (
        <div className="flex items-center gap-space-2 py-space-2"><Spinner size="sm" /><Text variant="xs" color="tertiary">Loading…</Text></div>
      ) : null}
      {pastRuns ? (() => {
        const q = pastRunQuery.trim().toLowerCase();
        const visible = pastRuns.filter((run) => !run.hidden && (!q || run.prompt.toLowerCase().includes(q)));
        const hidden = pastRuns.filter((run) => run.hidden).length;
        return (
          <>
            <div className="flex max-h-80 flex-col gap-space-1 overflow-y-auto">
              {visible.length === 0 ? <Text variant="xs" color="tertiary">No runs{q ? ' match' : ''}.</Text> : null}
              {visible.map((run) => (
                <button key={run.traceId} type="button" onClick={() => runImport(run.traceId)} disabled={importingId !== null}
                  className="flex flex-col gap-px rounded-md border border-default bg-surface-level-1 px-space-2 py-space-1 text-left hover:border-focus">
                  <span className="line-clamp-2 text-xs text-primary">{run.prompt || '(no message)'}</span>
                  <span className="text-xs text-tertiary">
                    {importingId === run.traceId ? 'Importing…' : [
                      shortDate(run.start),
                      run.traceId in toolCallCounts ? `${toolCallCounts[run.traceId]} tool call${toolCallCounts[run.traceId] === 1 ? '' : 's'}` : '',
                    ].filter(Boolean).join(' · ')}
                  </span>
                </button>
              ))}
            </div>
            {hidden ? <Text variant="xs" color="tertiary">{hidden} more with hidden inputs.</Text> : null}
          </>
        );
      })() : null}
      <details className="text-xs text-tertiary">
        <summary className="cursor-pointer">More</summary>
        <div className="mt-space-1 flex gap-space-1">
          <input className={`${fieldClass} min-w-0 flex-1`} value={importRef} placeholder="Paste a trace link" aria-label="Trace link"
            onChange={(event) => setImportRef(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') runImport(); }} />
          <Button size="sm" variant="outlined" color="secondary" onClick={() => runImport()} disabled={!importRef.trim() || importingId !== null}>Import</Button>
        </div>
      </details>
      {importStatus ? <Text variant="xs" color={importStatus.kind === 'error' ? 'error' : 'tertiary'}>{importStatus.text}</Text> : null}
    </div>
  ) : null;

  const rail = (
    <>
      <div className="flex items-center justify-between gap-space-2">
        <Text variant="md" weight="semibold">Tests ({savedExamples.length})</Text>
        <div className="flex items-center gap-space-2">
          <button type="button" className="text-sm text-secondary underline-offset-2 hover:text-primary hover:underline" onClick={openImport} disabled={loading}
            title={inbox.length ? `${inbox.length} flagged trace${inbox.length === 1 ? '' : 's'} to import` : 'Make a test from a real run'}>
            Import{inbox.length ? <span className="ml-space-1 rounded-sm bg-brand-subtle px-space-1 text-xs text-primary">{inbox.length}</span> : null}
          </button>
          <Button size="sm" color="primary" onClick={() => addExample()} disabled={loading}>New</Button>
        </div>
      </div>
      {/* Run several tests at once, like an IDE's test explorer. Both confirm first: every test is a real agent
          run per repetition. "Failing" is every test whose newest result is red, amber or errored. */}
      <div className="flex items-center gap-space-1">
        <Button size="sm" variant="outlined" color="secondary" onClick={() => setConfirmBatch('all')} disabled={loading || !savedExamples.length}>Run all</Button>
        <ActionsMenu label="More run options" compact align="left" items={[
          { label: `Run failing (${failingExamples.length})`, disabled: !failingExamples.length, onSelect: () => setConfirmBatch('failing') },
        ]} />
      </div>
      {batchConfirm}
      {batchNotice ? <Text variant="xs" color={batchNotice.kind === 'error' ? 'error' : 'tertiary'}>{batchNotice.text}</Text> : null}
      {importPanel}
      <div className="flex flex-col gap-space-2">{examples.map(railRow)}</div>
    </>
  );

  // Given in one line while closed: what each tool answers, then anything else set up before the message.
  const givenSummary = draft && selected ? [
    ...draft.mockTools.filter((mock) => mock.tool).map((mock) => `${mock.tool} answers ${mock.cases ? `${mock.cases.length} ways` : responseSummary(mock.response).text}`),
    draft.history.length ? `${draft.history.length} earlier message${draft.history.length === 1 ? '' : 's'}` : '',
    draft.context.trim() ? 'context' : '',
    testFiles(selected).length ? `${testFiles(selected).length} file${testFiles(selected).length === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ') || 'Nothing set up yet' : '';

  const fromTrace = selected ? Boolean(text(selected.metadata.source_trace_id)) : false;
  const hasSource = selected ? Boolean(text(selected.metadata.source_output)) || Array.isArray(selected.metadata.source_feedback) : false;
  const statusLine = built?.error ? `Not saved: ${built.error}` : notice?.text ?? runStatus?.text ?? (saving ? 'Saving…' : '');
  const statusIsError = Boolean(built?.error) || notice?.kind === 'error' || runStatus?.kind === 'error';

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-surface-level-1 p-space-4 text-primary">
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
              {/* One bar for the test: its name and description (edited in place), its newest result, and Run. */}
              <div className="sticky top-0 z-10 flex flex-wrap items-center gap-space-3 rounded-md border border-default bg-surface-level-1 p-space-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <input className="w-full rounded-sm bg-transparent px-space-1 text-lg font-semibold text-primary outline-none hover:bg-surface-level-2 focus:bg-surface-level-2"
                    value={titleOf(draft)} placeholder="Name this test" aria-label="Test name" onChange={(event) => patchDraft({ name: nameFrom(event.currentTarget.value) })} />
                  <input className="w-full rounded-sm bg-transparent px-space-1 text-xs text-secondary outline-none placeholder:text-tertiary hover:bg-surface-level-2 focus:bg-surface-level-2"
                    value={descriptionOf(draft)} placeholder="Add a description" aria-label="Description" onChange={(event) => patchDraft({ description: event.currentTarget.value })} />
                  {statusLine ? <span className={`px-space-1 text-xs ${statusIsError ? 'text-error-primary' : 'text-tertiary'}`}>{statusLine}</span> : null}
                </div>
                {!selected.isNew ? (
                  <span className="flex items-center gap-space-1">
                    {summaries[selected.id] ? (
                      <StatusDot status={activeRuns[selected.id] ?? (summaries[selected.id].runningElsewhere ? 'running' : summaries[selected.id].status)} stale={selectedStale !== null} />
                    ) : null}
                    <LastRun summary={summaries[selected.id]} error={lastError} stale={selectedStale}
                      onOpen={() => setShowResults(true)} onRun={dirty || running ? undefined : () => void runTest()} />
                  </span>
                ) : null}
                <div className="flex items-center gap-space-1">
                  <select className="h-8 w-20 rounded-md border border-default bg-surface-level-1 pl-space-2 text-sm text-secondary outline-none focus:border-focus"
                    aria-label="Repetitions" title="Repetitions per run" value={repetitions} onChange={(event) => setRepetitions(Number(event.currentTarget.value))}>
                    {REPETITION_CHOICES.map((n) => <option key={n} value={n}>×{n}</option>)}
                  </select>
                  <Button size="sm" color="primary" onClick={() => void runTest()} disabled={selected.isNew || dirty || running}
                    title={selected.isNew || dirty ? (built?.error ? 'Finish the test first' : 'Saving…') : 'Runs the agent and grades every assertion'}>
                    {running ? 'Starting…' : 'Run'}
                  </Button>
                </div>
                {confirmDelete ? (
                  <span className="flex gap-space-1">
                    <Button size="sm" color="error" onClick={() => void remove()} disabled={saving}>Confirm delete</Button>
                    <Button size="sm" variant="outlined" color="secondary" onClick={() => setConfirmDelete(false)}>Cancel</Button>
                  </span>
                ) : (
                  <ActionsMenu label="Test actions" items={[
                    ...(!selected.isNew ? [{ label: showResults ? 'Hide results' : 'Results', onSelect: () => setShowResults(!showResults) }] : []),
                    { label: 'Duplicate', onSelect: () => addExample(draft) },
                    ...(!selected.isNew && metadata?.workspaceId ? [{ label: 'Open in LangSmith', onSelect: openInLangSmith }] : []),
                    { label: 'Delete…', danger: true, disabled: saving, onSelect: () => setConfirmDelete(true) },
                  ]} />
                )}
              </div>

              {hasSource ? <SourcePanel key={selected.id} example={selected} open={!draft.assertions.some((row) => row.assertion.trim())} /> : null}

              {/* Given is everything true before the message arrives: what the tools answer, the conversation so far,
                  files and (under Advanced) the agent's setup context. When is only the new message. */}
              <Section title="Given" summary={givenSummary} defaultOpen={false} openSignal={givenSignal}>
                <Subsection title="Tool answers"
                  hint={<span title={text(selected.inputs.recorded_on)
                    ? `Recorded ${text(selected.inputs.recorded_on)}. On each run, dates in these answers move forward by the days since then, so the data stays as fresh as it was that day.`
                    : 'A call to a tool with no answer here makes the run not count.'}>What each tool returns.</span>}>
                  {draft.mockTools.length === 0 ? <Text variant="xs" color="tertiary">None yet.</Text> : null}
                  {draft.mockTools.map((mock) => (
                    <MockToolEditor key={mock.key} mock={mock} tools={tools} onChange={(patch) => patchRow('mockTools', mock.key, patch)}
                      onRemove={() => removeRow('mockTools', mock.key)} />
                  ))}
                </Subsection>
                {draft.history.length ? <HistoryEditor history={draft.history} focusKey={historyFocus} onChange={(history) => patchDraft({ history })} /> : null}
                {!selected.isNew ? (
                  <FilesEditor exampleId={selected.id} files={testFiles(selected)} pick={filePick}
                    // Saved on the server already; the local copy takes the new list so the next autosave keeps it.
                    onChange={(files) => setExamples((current) => current.map((row) => (row.id === selected.id ? withFiles(row, files) : row)))} />
                ) : null}
                <details open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)} className="text-sm">
                  <summary className="cursor-pointer text-xs text-tertiary">Advanced</summary>
                  <div className="mt-space-2 flex flex-col gap-space-1">
                    <TextAreaField label="Context (JSON for the agent hook)" value={draft.context} onChange={(context) => patchDraft({ context })}
                      rows={draft.context ? Math.min(12, draft.context.split('\n').length + 1) : 2} mono placeholder='e.g. {"customer_tier": "gold"}' />
                    {contextProblem(draft.context) ? <span className="text-xs text-error-primary">{contextProblem(draft.context)}</span> : null}
                  </div>
                </details>
                <div>
                  <ActionsMenu label="Add to Given" align="left" trigger={<>Add <span aria-hidden>▾</span></>} items={[
                    { label: 'Tool answer', onSelect: () => patchDraft({ mockTools: [...draft.mockTools, { key: keyId(), tool: '', response: '', cases: null }] }) },
                    { label: 'Earlier message', onSelect: () => {
                      const key = keyId();
                      patchDraft({ history: [...draft.history, { key, role: nextRole(draft.history), content: '' }] });
                      setHistoryFocus(key);
                    } },
                    ...(!selected.isNew && isWeb() ? [{ label: 'File', onSelect: () => setFilePick((n) => n + 1) }] : []),
                    { label: 'Context', onSelect: () => setAdvancedOpen(true) },
                  ]} />
                </div>
              </Section>

              <Section title="When" summary={draft.prompt}>
                <TextAreaField value={draft.prompt} onChange={(prompt) => patchDraft({ prompt })} rows={3} placeholder="Order A1001 arrived broken, can I get my money back?" />
              </Section>

              <Section title="Then" hint="One sentence each that must be true."
                summary={`${draft.assertions.length} assertion${draft.assertions.length === 1 ? '' : 's'}${draft.checks.length ? ` · ${draft.checks.length} code check${draft.checks.length === 1 ? '' : 's'}` : ''}`}>
                {draft.assertions.map((row, index) => (
                  <div key={row.key} className="flex flex-col gap-space-1">
                    <div className="flex items-start gap-space-2">
                      <div className="min-w-0 flex-1">
                        <TextAreaField value={row.assertion} onChange={(assertion) => patchRow('assertions', row.key, { assertion })} rows={1} maxRows={6}
                          placeholder={index === 0 && hasSource ? 'Write what it should have done instead.' : 'e.g. It tells the customer what will happen next.'} />
                      </div>
                      <span className="flex items-center gap-space-1 pt-space-1">
                        <ResultChip result={summaries[selected.id]?.keys[row.name]} ranAt={summaries[selected.id]?.ranAt ?? ''} stale={selectedStale}
                          onOpen={() => setDrill(drill?.name === row.name ? null : { kind: 'assertion', name: row.name })} />
                        <ActionsMenu label="Assertion actions" compact items={[
                          { label: 'Rename', onSelect: () => setRenaming((current) => new Set(current).add(row.key)) },
                          { label: 'Delete', danger: true, onSelect: () => removeRow('assertions', row.key) },
                        ]} />
                      </span>
                    </div>
                    {renaming.has(row.key) ? (
                      <div className="w-64"><TextField label="Name" value={row.name} onChange={(name) => patchRow('assertions', row.key, { name: name.toLowerCase().replace(/[\s_]+/g, '-') })} placeholder="named from the sentence" mono /></div>
                    ) : null}
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
                  {fromTrace && isWeb() && whatWentWrong === null ? (
                    <Button size="sm" variant="outlined" color="secondary" onClick={() => void suggestAssertions()} disabled={suggesting !== null}
                      title="Drafts 2-4 assertions from the agent's instructions and tools, the conversation, the tool results, the original reply and all feedback on the trace">
                      {suggesting === selected.id ? 'Suggesting…' : 'Suggest'}
                    </Button>
                  ) : null}
                  {fromTrace && isWeb() && whatWentWrong !== null ? (
                    <span className="flex flex-wrap items-center gap-space-2">
                      <span className="text-xs text-secondary">What went wrong?</span>
                      <input className={`${fieldClass} w-80`} autoFocus value={whatWentWrong} aria-label="What went wrong"
                        placeholder="e.g. It said no instead of offering options" onChange={(event) => setWhatWentWrong(event.currentTarget.value)}
                        onKeyDown={(event) => { if (event.key === 'Enter' && whatWentWrong.trim()) void suggestAssertions(whatWentWrong.trim()); }} />
                      <Button size="sm" color="primary" onClick={() => void suggestAssertions(whatWentWrong.trim())} disabled={!whatWentWrong.trim() || suggesting !== null}>
                        {suggesting === selected.id ? 'Suggesting…' : 'Suggest'}
                      </Button>
                      <Button size="sm" variant="outlined" color="secondary" onClick={() => setWhatWentWrong(null)}>Cancel</Button>
                    </span>
                  ) : null}
                  {!draft.checks.length ? (
                    <button type="button" className="text-xs text-secondary underline-offset-2 hover:text-primary hover:underline"
                      onClick={() => patchDraft({ checks: [emptyCheck()] })}>+ Add code check</button>
                  ) : null}
                  {suggestNotice ? <Text variant="xs" color={suggestNotice.kind === 'error' ? 'error' : 'tertiary'}>{suggestNotice.text}</Text> : null}
                </div>
                {draft.checks.length ? (
                  <Subsection title="Code checks" addLabel="Add check" onAdd={() => patchDraft({ checks: [...draft.checks, emptyCheck()] })}>
                    {draft.checks.map((check) => (
                      <CheckEditor key={check.key} check={check} tools={tools} onChange={(patch) => patchRow('checks', check.key, patch)} onRemove={() => removeRow('checks', check.key)}
                        result={<ResultChip result={summaries[selected.id]?.keys[check.name]} ranAt={summaries[selected.id]?.ranAt ?? ''} stale={selectedStale}
                          onOpen={() => setDrill(drill?.name === check.name ? null : { kind: 'check', name: check.name })} />} />
                    ))}
                    {drill?.kind === 'check' && dataset && draft.checks.some((c) => c.name === drill.name) ? (
                      <AssertionDrilldown datasetId={dataset.id} exampleId={selected.id} testName={draft.name} name={drill.name} kind="check" onClose={() => setDrill(null)} onAddMock={addMockForGap} />
                    ) : null}
                  </Subsection>
                ) : null}
              </Section>
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
