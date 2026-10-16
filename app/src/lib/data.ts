// Everything the editor reads and writes in LangSmith. Every call goes through window.langsmith.call: inside
// LangSmith that is the custom-app bridge, and in the web build it's a shim over the server's proxy (src/web.tsx).
import { DATASET_NAME, TRACE_PROJECT } from '../config';

export type Json = Record<string, unknown>;

export type Example = { id: string; inputs: Json; outputs: Json; metadata: Json; isNew?: boolean };
// A mock is one response for any arguments, or (cases set) the first case whose `when` matches the call's arguments.
// `anyValue` is the other matcher: the case applies when any argument equals that string (`when_any_value`).
export type MockCase = { key: string; when: string; response: string; anyValue?: string };
export type MockTool = { key: string; tool: string; response: string; cases: MockCase[] | null };
export type Assertion = { key: string; name: string; assertion: string };
export type HistoryTurn = { key: string; role: 'user' | 'assistant'; content: string };
// Code checks are deterministic (no judge). Params are kept as editable strings so half-typed values survive; `groups`
// holds tool names (a group of several means "any of"), `json` the free-form part (args, or all of a custom check),
// and `extra` any keys this editor doesn't know about so a save never drops them.
export type Check = { key: string; name: string; type: string; max: string; tool: string; first: string; second: string; groups: string[][]; json: string; extra: Json };
export type Draft = {
  name: string; description: string; mockTools: MockTool[]; history: HistoryTurn[]; context: string; prompt: string;
  assertions: Assertion[]; checks: Check[]; splits: string[];
};
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

// --- Code checks ---------------------------------------------------------------------------------------------

export const CHECK_TYPES = ['must_call', 'must_not_call', 'max_tool_calls', 'max_tool_rounds', 'must_call_before', 'must_call_with_values', 'max_prompt_tokens', 'max_model_calls', 'custom'] as const;
// Keys each type owns; anything else on a saved check rides along in `extra`.
const CHECK_KEYS: Record<string, string[]> = {
  must_call: ['tools'], must_not_call: ['tools'], max_tool_calls: ['max', 'tool'], max_tool_rounds: ['max'],
  must_call_before: ['first', 'second'], must_call_with_values: ['tool', 'args'], max_prompt_tokens: ['max'], max_model_calls: ['max'],
};

export function emptyCheck(type = 'must_call'): Check {
  return { key: keyId(), name: '', type, max: '', tool: '', first: '', second: '', groups: [], json: '', extra: {} };
}

function toCheck(row: Json): Check {
  const type = text(row.type) || 'custom';
  const check = { ...emptyCheck(type), name: text(row.name) };
  const owned = CHECK_KEYS[type];
  const { name: _name, type: _type, ...rest } = row;
  // custom, and a type this editor doesn't know, is edited as one JSON object.
  if (!owned) return { ...check, json: Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '' };
  if (Array.isArray(row.tools)) check.groups = row.tools.map((tool) => (Array.isArray(tool) ? tool.map(String) : [String(tool)]));
  if (row.max !== undefined) check.max = String(row.max);
  check.tool = text(row.tool);
  check.first = text(row.first);
  check.second = text(row.second);
  if (row.args !== undefined) check.json = JSON.stringify(row.args, null, 2);
  check.extra = Object.fromEntries(Object.entries(rest).filter(([key]) => !owned.includes(key)));
  return check;
}

export function parseJsonObject(source: string): { value?: Json; error?: string } {
  if (!source.trim()) return { value: {} };
  try {
    const value: unknown = JSON.parse(source);
    return isRecord(value) ? { value } : { error: 'Must be a JSON object, like {"key": "value"}.' };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Not valid JSON.' };
  }
}

// What is wrong with a check, if anything, in words fit for the inline error under it.
export function checkProblem(check: Check): string | null {
  const needsMax = ['max_tool_calls', 'max_tool_rounds', 'max_prompt_tokens', 'max_model_calls'].includes(check.type);
  if (needsMax && (!check.max.trim() || !Number.isFinite(Number(check.max)) || Number(check.max) < 0)) return 'Max must be a number, 0 or more.';
  if ((check.type === 'must_call' || check.type === 'must_not_call') && !check.groups.some((group) => group.length)) return 'Pick at least one tool.';
  if (check.type === 'must_call_before' && (!check.first || !check.second)) return 'Pick both tools.';
  if (check.type === 'must_call_with_values') {
    if (!check.tool) return 'Pick a tool.';
    const { error } = parseJsonObject(check.json);
    if (error) return `Args: ${error}`;
  }
  if (!CHECK_KEYS[check.type]) {
    const { error } = parseJsonObject(check.json);
    if (error) return error;
  }
  return null;
}

function checkPayload(check: Check): Json {
  const base = { name: check.name.trim(), type: check.type };
  const max = Number(check.max);
  switch (check.type) {
    case 'must_call': return { ...check.extra, ...base, tools: check.groups.filter((g) => g.length).map((g) => (g.length === 1 ? g[0] : g)) };
    case 'must_not_call': return { ...check.extra, ...base, tools: check.groups.flat() };
    case 'max_tool_calls': return { ...check.extra, ...base, max, ...(check.tool ? { tool: check.tool } : {}) };
    case 'must_call_before': return { ...check.extra, ...base, first: check.first, second: check.second };
    case 'must_call_with_values': return { ...check.extra, ...base, tool: check.tool, args: parseJsonObject(check.json).value ?? {} };
    case 'max_tool_rounds': case 'max_prompt_tokens': case 'max_model_calls': return { ...check.extra, ...base, max };
    default: return { ...(parseJsonObject(check.json).value ?? {}), ...base };
  }
}

export function historyChars(history: HistoryTurn[]) {
  return history.reduce((sum, turn) => sum + turn.content.length, 0);
}

export function contextProblem(context: string) {
  return parseJsonObject(context).error ?? null;
}

export function toDraft(example: Example): Draft {
  const { inputs, outputs, metadata } = example;
  const mocks = isRecord(inputs.mock_tools) ? inputs.mock_tools : {};
  const assertions = Array.isArray(outputs.assertions) ? outputs.assertions.filter(isRecord) : [];
  const history = Array.isArray(inputs.history) ? inputs.history.filter(isRecord) : [];
  const checks = Array.isArray(outputs.checks) ? outputs.checks.filter(isRecord) : [];
  return {
    name: text(metadata.name),
    description: text(metadata.description),
    mockTools: Object.entries(mocks).map(([tool, value]) => {
      const cases = isRecord(value) && Object.keys(value).length === 1 && Array.isArray(value.cases) ? value.cases.filter(isRecord) : null;
      return {
        key: keyId(),
        tool,
        response: cases ? '' : responseText(value),
        cases: cases?.map((row) => ({
          key: keyId(),
          when: isRecord(row.when) ? JSON.stringify(row.when) : '',
          response: responseText(row.response),
          ...(typeof row.when_any_value === 'string' ? { anyValue: row.when_any_value } : {}),
        })) ?? null,
      };
    }),
    history: history.map((turn) => ({ key: keyId(), role: turn.role === 'assistant' ? 'assistant' : 'user', content: text(turn.content) })),
    // Pretty-printed so a small object is readable; empty means the test has no context.
    context: isRecord(inputs.context) ? JSON.stringify(inputs.context, null, 2) : '',
    prompt: text(inputs.prompt),
    assertions: assertions.map((row) => ({ key: keyId(), name: text(row.name), assertion: text(row.assertion) })),
    checks: checks.map(toCheck),
    splits: strings(metadata.dataset_split),
  };
}

// Builds the example payload from the draft, keeping any keys this editor doesn't know about.
export function toPayload(example: Example, draft: Draft): { payload?: Pick<Example, 'inputs' | 'outputs' | 'metadata'>; error?: string } {
  if (!draft.name.trim()) return { error: 'Give the test a name.' };
  if (!draft.prompt.trim()) return { error: 'Write the prompt (When).' };
  // A fully blank row (new and imported tests start with one) is left out rather than blocking the save.
  const assertions = draft.assertions.filter((row) => row.name.trim() || row.assertion.trim());
  if (assertions.some((row) => !row.name.trim())) return { error: 'Every assertion needs a name.' };
  if (draft.checks.some((check) => !check.name.trim())) return { error: 'Every check needs a name.' };
  // Assertions and checks share one namespace: each name becomes a LangSmith feedback key.
  const names = [...assertions.map((row) => row.name.trim()), ...draft.checks.map((check) => check.name.trim())];
  if (names.includes('all-tools-mocked')) return { error: '"all-tools-mocked" is reserved for the built-in check.' };
  const dupe = names.find((name, index) => names.indexOf(name) !== index);
  if (dupe) return { error: `Two assertions or checks are named "${dupe}".` };
  for (const check of draft.checks) {
    const problem = checkProblem(check);
    if (problem) return { error: `Check "${check.name}": ${problem}` };
  }
  const contextError = contextProblem(draft.context);
  if (contextError) return { error: `Context: ${contextError}` };
  if (draft.mockTools.some((mock) => !mock.tool)) return { error: 'Pick a tool for every mock.' };
  const tools = draft.mockTools.map((mock) => mock.tool);
  const dupeTool = tools.find((tool, index) => tools.indexOf(tool) !== index);
  if (dupeTool) return { error: `${dupeTool} is mocked twice.` };

  const { mock_tools: _mocks, history: _history, context: _context, ...inputs } = example.inputs;
  const { checks: _checks, ...outputs } = example.outputs;
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
      cases.push({
        ...(when ? { when } : {}),
        ...(row.anyValue !== undefined ? { when_any_value: row.anyValue } : {}),
        response: parseResponse(row.response),
      });
    }
    mockTools[mock.tool] = { cases };
  }
  if (draft.mockTools.length) inputs.mock_tools = mockTools;
  // Optional fields are omitted when empty, so a test that doesn't use them keeps its old shape.
  const history = draft.history.filter((turn) => turn.content.trim()).map((turn) => ({ role: turn.role, content: turn.content }));
  if (history.length) inputs.history = history;
  const context = parseJsonObject(draft.context).value;
  if (context && Object.keys(context).length) inputs.context = context;
  return {
    payload: {
      inputs: { ...inputs, prompt: draft.prompt },
      outputs: {
        ...outputs,
        assertions: assertions.map((row) => ({ name: row.name.trim(), assertion: row.assertion })),
        ...(draft.checks.length ? { checks: draft.checks.map(checkPayload) } : {}),
      },
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
    history: [],
    context: '',
    assertions: [{ key: keyId(), name: '', assertion: '' }],
    checks: [],
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
