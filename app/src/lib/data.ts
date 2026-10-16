// Everything the editor reads and writes in LangSmith. Every call goes through window.langsmith.call: inside
// LangSmith that is the custom-app bridge, and in the web build it's a shim over the server's proxy (src/web.tsx).
import { DATASET_NAME, TRACE_PROJECT } from '../config';

export type Json = Record<string, unknown>;

export type Example = { id: string; inputs: Json; outputs: Json; metadata: Json; isNew?: boolean };
// A mock is one response for any arguments, or (cases set) the first case whose `when` matches the call's arguments.
export type MockCase = { key: string; when: string; response: string };
export type MockTool = { key: string; tool: string; response: string; cases: MockCase[] | null };
export type Assertion = { key: string; name: string; assertion: string };
export type Draft = { name: string; description: string; mockTools: MockTool[]; prompt: string; assertions: Assertion[]; splits: string[] };
export type Dataset = { id: string; tools: string[] };

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

export function keyId() {
  return Math.random().toString(36).slice(2, 10);
}

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return 'Something went wrong talking to LangSmith.';
}

function isRateLimit(error: unknown) {
  if (!isRecord(error)) return false;
  const status = error.status ?? error.statusCode ?? error.code;
  return status === 429 || status === '429';
}

export async function callLangSmith<T>(operation: string, args?: { params?: Record<string, string>; body?: unknown }) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return (await window.langsmith.call(operation, args)) as T;
    } catch (error) {
      lastError = error;
      if (!isRateLimit(error) || attempt === 3) break;
      await new Promise((resolve) => window.setTimeout(resolve, 400 * 2 ** attempt + Math.random() * 250));
    }
  }
  throw lastError;
}

// --- Dataset and tests ---------------------------------------------------------------------------------------

// The server publishes the agent's tool names on the dataset's metadata (`agent_tools`), which is how the custom
// app, which can't reach the server, knows them.
export async function fetchDataset(): Promise<Dataset> {
  const rows = await callLangSmith<unknown>('GET /api/v1/datasets', { params: { name: DATASET_NAME } });
  const dataset = (Array.isArray(rows) ? rows : []).filter(isRecord)[0];
  if (!dataset) throw new Error(`No dataset named ${DATASET_NAME}. Start the eval server once to create it.`);
  const tools = isRecord(dataset.metadata) && Array.isArray(dataset.metadata.agent_tools) ? dataset.metadata.agent_tools.map(String) : [];
  return { id: text(dataset.id), tools };
}

function toExample(raw: unknown): Example | null {
  if (!isRecord(raw) || typeof raw.id !== 'string') return null;
  return {
    id: raw.id,
    inputs: isRecord(raw.inputs) ? raw.inputs : {},
    outputs: isRecord(raw.outputs) ? raw.outputs : {},
    metadata: isRecord(raw.metadata) ? raw.metadata : {},
  };
}

const PAGE_SIZE = 100;

export async function fetchAllExamples(datasetId: string) {
  const all: Example[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const response = await callLangSmith<unknown>('GET /api/v1/examples', {
      params: { dataset: datasetId, limit: String(PAGE_SIZE), offset: String(offset) },
    });
    const rows = Array.isArray(response) ? response : [];
    all.push(...(rows.map(toExample).filter(Boolean) as Example[]));
    if (rows.length < PAGE_SIZE) return all;
  }
}

export async function saveExampleTo(datasetId: string, example: Example, payload: Pick<Example, 'inputs' | 'outputs' | 'metadata'>): Promise<Example> {
  if (example.isNew) {
    const response = await callLangSmith<unknown>('POST /api/v1/examples', { body: { dataset_id: datasetId, ...payload } });
    return toExample(response) ?? { id: example.id, ...payload };
  }
  await callLangSmith(`PATCH /api/v1/examples/${example.id}`, { body: payload });
  return { id: example.id, ...payload };
}

export async function deleteExample(id: string) {
  await callLangSmith(`DELETE /api/v1/examples/${id}`);
}

export function emptyExample(): Example {
  return {
    id: `new-${keyId()}`,
    isNew: true,
    inputs: { prompt: '' },
    outputs: { assertions: [{ name: '', assertion: '' }] },
    metadata: { name: '', description: '', dataset_split: ['base'] },
  };
}

// --- Draft <-> example ---------------------------------------------------------------------------------------

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value) return [value];
  return [];
}

export function responseText(value: unknown) {
  return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2);
}

// A mock response is free text; JSON is stored as JSON so {"raise": "..."} and structured payloads keep their shape.
export function parseResponse(response: string): unknown {
  try {
    return JSON.parse(response);
  } catch {
    return response;
  }
}

export function toDraft(example: Example): Draft {
  const { inputs, outputs, metadata } = example;
  const mocks = isRecord(inputs.mock_tools) ? inputs.mock_tools : {};
  const assertions = Array.isArray(outputs.assertions) ? outputs.assertions.filter(isRecord) : [];
  return {
    name: text(metadata.name),
    description: text(metadata.description),
    mockTools: Object.entries(mocks).map(([tool, value]) => {
      const cases = isRecord(value) && Object.keys(value).length === 1 && Array.isArray(value.cases) ? value.cases.filter(isRecord) : null;
      return {
        key: keyId(),
        tool,
        response: cases ? '' : responseText(value),
        cases: cases?.map((row) => ({ key: keyId(), when: isRecord(row.when) ? JSON.stringify(row.when) : '', response: responseText(row.response) })) ?? null,
      };
    }),
    prompt: text(inputs.prompt),
    assertions: assertions.map((row) => ({ key: keyId(), name: text(row.name), assertion: text(row.assertion) })),
    splits: strings(metadata.dataset_split),
  };
}

// Builds the example payload from the draft, keeping any keys this editor doesn't know about.
export function toPayload(example: Example, draft: Draft): { payload?: Pick<Example, 'inputs' | 'outputs' | 'metadata'>; error?: string } {
  if (!draft.name.trim()) return { error: 'Give the test a name.' };
  if (!draft.prompt.trim()) return { error: 'Write the prompt (When).' };
  // A fully blank row (new and imported tests start with one) is left out rather than blocking the save.
  const assertions = draft.assertions.filter((row) => row.name.trim() || row.assertion.trim());
  const names = assertions.map((row) => row.name.trim());
  if (names.some((name) => !name)) return { error: 'Every assertion needs a name.' };
  if (names.includes('all-tools-mocked')) return { error: '"all-tools-mocked" is reserved for the built-in check.' };
  const dupe = names.find((name, index) => names.indexOf(name) !== index);
  if (dupe) return { error: `Two assertions are named "${dupe}".` };
  if (draft.mockTools.some((mock) => !mock.tool)) return { error: 'Pick a tool for every mock.' };
  const tools = draft.mockTools.map((mock) => mock.tool);
  const dupeTool = tools.find((tool, index) => tools.indexOf(tool) !== index);
  if (dupeTool) return { error: `${dupeTool} is mocked twice.` };

  const { mock_tools: _mocks, ...inputs } = example.inputs;
  const mockTools: Json = {};
  for (const mock of draft.mockTools) {
    if (!mock.cases) {
      mockTools[mock.tool] = parseResponse(mock.response);
      continue;
    }
    const cases: Json[] = [];
    for (const row of mock.cases) {
      let when: unknown;
      try {
        when = row.when.trim() ? JSON.parse(row.when) : undefined;
      } catch {
        return { error: `${mock.tool}: a case's "when" isn't valid JSON.` };
      }
      if (when !== undefined && !isRecord(when)) return { error: `${mock.tool}: "when" must be an object like {"order_id": "A1001"}.` };
      cases.push(when ? { when, response: parseResponse(row.response) } : { response: parseResponse(row.response) });
    }
    mockTools[mock.tool] = { cases };
  }
  if (draft.mockTools.length) inputs.mock_tools = mockTools;
  return {
    payload: {
      inputs: { ...inputs, prompt: draft.prompt },
      outputs: { ...example.outputs, assertions: assertions.map((row) => ({ name: row.name.trim(), assertion: row.assertion })) },
      metadata: { ...example.metadata, name: draft.name.trim(), description: draft.description, dataset_split: draft.splits },
    },
  };
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Recorded mocks make payloads large, so cache the dirty check per (saved example, draft) pair.
const dirtyCache = new WeakMap<Draft, { example: Example; dirty: boolean }>();

export function isDirty(example: Example, draft: Draft) {
  const cached = dirtyCache.get(draft);
  if (cached?.example === example) return cached.dirty;
  let dirty = true;
  if (!example.isNew) {
    const { payload } = toPayload(example, draft);
    dirty = !payload || stableStringify(payload) !== stableStringify({ inputs: example.inputs, outputs: example.outputs, metadata: example.metadata });
  }
  dirtyCache.set(draft, { example, dirty });
  return dirty;
}

// --- Results -------------------------------------------------------------------------------------------------

export type AssertionResult = { key: string; score: number | null; comment: string };
export type TestResult = {
  runId: string; traceId: string; experimentId: string; experimentName: string;
  start: string; end: string; status: string; error: string; answer: string; assertions: AssertionResult[];
};

function feedbackComment(stats: Json) {
  const comments = stats.comments;
  if (Array.isArray(comments)) return comments.map(String).filter(Boolean).join(' ');
  return typeof comments === 'string' ? comments : '';
}

// Every experiment run of one test (example), newest first, with its per-assertion scores.
export async function fetchResults(datasetId: string, exampleId: string): Promise<TestResult[]> {
  const sessions = await callLangSmith<unknown>('GET /api/v1/sessions', { params: { reference_dataset: datasetId, limit: '50' } });
  const experiments = (Array.isArray(sessions) ? sessions : []).filter(isRecord);
  if (!experiments.length) return [];
  const names = new Map(experiments.map((e) => [text(e.id), text(e.name)]));
  const page = await callLangSmith<unknown>(`POST /api/v2/datasets/${datasetId}/experiment-runs`, {
    body: {
      experiment_ids: [...names.keys()],
      example_ids: [exampleId],
      page_size: 50,
      selects: ['ID', 'TRACE_ID', 'PROJECT_ID', 'START_TIME', 'END_TIME', 'STATUS', 'ERROR_PREVIEW', 'OUTPUTS', 'FEEDBACK_STATS'],
    },
  });
  const items = isRecord(page) && Array.isArray(page.items) ? page.items.filter(isRecord) : [];
  const runs = items.flatMap((item) => (Array.isArray(item.runs) ? item.runs.filter(isRecord) : []));
  return runs.map((run) => {
    const stats = isRecord(run.feedback_stats) ? run.feedback_stats : {};
    const outputs = isRecord(run.outputs) ? run.outputs : {};
    return {
      runId: text(run.id),
      traceId: text(run.trace_id),
      experimentId: text(run.project_id),
      experimentName: names.get(text(run.project_id)) ?? 'experiment',
      start: text(run.start_time),
      end: text(run.end_time),
      status: text(run.status),
      error: text(run.error_preview),
      answer: text(outputs.answer).trim(),
      assertions: Object.entries(stats).filter(([, v]) => isRecord(v)).map(([key, v]) => {
        const stat = v as Json;
        return { key, score: typeof stat.avg === 'number' ? stat.avg : null, comment: feedbackComment(stat) };
      }),
    };
  }).sort((a, b) => b.start.localeCompare(a.start));
}

// --- Import a past run as a test -----------------------------------------------------------------------------

export type PastRun = { traceId: string; prompt: string; start: string; hidden: boolean };

function humanPrompt(inputs: unknown) {
  const messages = isRecord(inputs) && Array.isArray(inputs.messages) ? inputs.messages.filter(isRecord) : [];
  const human = [...messages].reverse().find((m) => m.type === 'human' || m.role === 'user');
  const content = human?.content;
  return typeof content === 'string' ? content : Array.isArray(content) ? content.filter(isRecord).map((part) => text(part.text)).join('') : '';
}

async function queryAll(body: Json) {
  const runs: Json[] = [];
  let cursor: string | undefined;
  do {
    const page = await callLangSmith<unknown>('POST /api/v1/runs/query', { body: { ...body, ...(cursor ? { cursor } : {}) } });
    runs.push(...(isRecord(page) && Array.isArray(page.runs) ? page.runs.filter(isRecord) : []));
    const next = isRecord(page) && isRecord(page.cursors) ? page.cursors.next : undefined;
    cursor = typeof next === 'string' ? next : undefined;
  } while (cursor && runs.length < 1000);
  return runs;
}

// The agent's recent root runs in its tracing project, newest first. Runs with hidden inputs are kept (flagged)
// so the list can say why they can't be imported.
export async function fetchPastRuns(): Promise<PastRun[]> {
  const sessions = await callLangSmith<unknown>('GET /api/v1/sessions', { params: { name: TRACE_PROJECT } });
  const session = (Array.isArray(sessions) ? sessions : []).filter(isRecord)[0];
  if (!session) throw new Error(`No tracing project named ${TRACE_PROJECT} yet. Run the agent once to create it.`);
  const page = await callLangSmith<unknown>('POST /api/v1/runs/query', {
    body: { session: [text(session.id)], is_root: true, limit: 50, select: ['id', 'trace_id', 'start_time', 'inputs'] },
  });
  const runs = isRecord(page) && Array.isArray(page.runs) ? page.runs.filter(isRecord) : [];
  return runs.map((run) => ({
    traceId: text(run.trace_id) || text(run.id),
    prompt: humanPrompt(run.inputs),
    start: text(run.start_time),
    hidden: run.inputs == null,
  })).sort((a, b) => b.start.localeCompare(a.start));
}

// Tool calls per trace, counted a few traces at a time; onCount fires as each one lands so the list fills in.
export async function countToolCalls(traceIds: string[], onCount: (traceId: string, count: number) => void) {
  const queue = [...traceIds];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let traceId = queue.shift(); traceId; traceId = queue.shift()) {
      const id = traceId;
      await queryAll({ trace: id, run_type: 'tool', limit: 100, select: ['id'] }).then((runs) => onCount(id, runs.length), () => undefined);
    }
  }));
}

export function traceIdFrom(input: string) {
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  return (new RegExp(`trace/(${uuid})`, 'i').exec(input) ?? new RegExp(`peek=(${uuid})`, 'i').exec(input) ?? new RegExp(uuid, 'i').exec(input))
    ?.slice(-1)[0]?.toLowerCase();
}

function toolResponse(run: Json): unknown {
  if (run.error) return { raise: String(run.error) };
  // LangChain records a ToolMessage ({content, status, ...}); other frameworks record the tool's result itself.
  const output = isRecord(run.outputs) ? run.outputs.output : undefined;
  const isToolMessage = isRecord(output) && (output.type === 'tool' || 'tool_call_id' in output);
  const content = isToolMessage ? output.content : output;
  if (isToolMessage && output.status === 'error') return { raise: String(content ?? 'tool error') };
  return typeof content === 'string' ? parseResponse(content) : content;
}

// Builds a test from a recorded trace: the user's prompt becomes When, and every call to one of the agent's tools
// becomes a mock (one case per distinct argument set). Assertions are left for the user to write.
export async function importTrace(traceId: string, agentTools: string[]) {
  const [root] = await queryAll({ trace: traceId, is_root: true, limit: 1 });
  if (!root) throw new Error('No trace with that ID in this workspace.');
  const toolRuns = (await queryAll({ trace: traceId, run_type: 'tool', limit: 100 }))
    .filter((run) => !agentTools.length || agentTools.includes(text(run.name)))
    .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
  if (root.inputs == null) throw new Error("This trace's inputs are hidden, so there is nothing to import.");

  const byTool = new Map<string, { args: Json; response: unknown }[]>();
  for (const run of toolRuns) {
    const name = text(run.name);
    const calls = byTool.get(name) ?? [];
    const args = isRecord(run.inputs) ? run.inputs : {};
    if (!calls.some((call) => stableStringify(call.args) === stableStringify(args))) calls.push({ args, response: toolResponse(run) });
    byTool.set(name, calls);
  }
  const mockTools: MockTool[] = [...byTool].map(([tool, calls]) => ({
    key: keyId(),
    tool,
    response: calls.length === 1 ? responseText(calls[0].response) : '',
    cases: calls.length === 1 ? null : calls.map((call) => ({ key: keyId(), when: JSON.stringify(call.args), response: responseText(call.response) })),
  }));
  const started = text(root.start_time).slice(0, 10);
  const draft: Draft = {
    name: `trace-${traceId.slice(0, 8)}`,
    description: `Imported from trace ${traceId} (${started}).`,
    prompt: humanPrompt(root.inputs),
    mockTools,
    assertions: [{ key: keyId(), name: '', assertion: '' }],
    splits: ['base'],
  };
  return { draft, recordedOn: started, toolCalls: toolRuns.length };
}

// --- Formatting ----------------------------------------------------------------------------------------------

export function shortDate(iso: string) {
  const date = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`);
  return Number.isNaN(date.getTime()) ? iso.slice(0, 16) : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function duration(start: string, end: string) {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const minutes = Math.floor(ms / 60000);
  return minutes ? `${minutes}m ${Math.round((ms % 60000) / 1000)}s` : `${Math.round(ms / 1000)}s`;
}
