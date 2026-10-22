// Everything the editor reads and writes in LangSmith. Every call goes through window.langsmith.call: inside
// LangSmith that is the custom-app bridge, and in the web build it's a shim over the server's proxy (src/web.tsx).
import { DATASET_NAME, PROPOSALS_QUEUE, TRACE_PROJECT } from '../config';
import { isResult, isRunning, statsFromRuns } from './experimentState';

export type Json = Record<string, unknown>;

// `modifiedAt` is when the test last changed, to tell a result produced by an older version of it from a current one.
export type Example = { id: string; inputs: Json; outputs: Json; metadata: Json; isNew?: boolean; modifiedAt?: string };
// A mock is one response for any arguments, or (cases set) the first case whose `when` matches the call's arguments.
// `anyValue` is the other matcher: the case applies when any argument equals that string (`when_any_value`).
// `after` (JSON text, {tool: {arg: value}}) holds the case back until the run has made those calls successfully.
export type MockCase = { key: string; when: string; response: string; anyValue?: string; after?: string };
export type MockTool = { key: string; tool: string; response: string; cases: MockCase[] | null };
export type Assertion = { key: string; name: string; assertion: string };
// A turn of the conversation before the prompt. An assistant turn can carry the tool calls it made, and a `tool` turn
// is one call's result, so a replayed thread gives the agent the same tool context it had (LangChain message dicts).
export type ToolCall = { id: string; name: string; args: Json };
export type HistoryTurn = { key: string; role: 'user' | 'assistant' | 'tool'; content: string; toolCalls?: ToolCall[]; toolCallId?: string; toolName?: string };
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
    modifiedAt: text(raw.modified_at) || text(raw.created_at),
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
  // Stamped here rather than re-read, so a result goes out of date the moment the edit is saved.
  return { id: example.id, ...payload, modifiedAt: new Date().toISOString() };
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

export const CHECK_TYPES = ['must_call', 'must_not_call', 'max_tool_calls', 'max_tool_rounds', 'must_call_before', 'must_call_with_values', 'max_prompt_tokens', 'max_model_calls', 'must_output_file', 'custom'] as const;
// What each type means, in the words an expert would use. The id stays visible as the saved value.
export const CHECK_LABELS: Record<string, string> = {
  must_call: 'Must use tool…', must_not_call: 'Must never use tool…', max_tool_calls: 'Uses tools at most N times',
  max_tool_rounds: 'At most N rounds of tool calls', must_call_before: 'Uses one tool before another',
  must_call_with_values: 'Uses a tool with specific values', max_prompt_tokens: 'Keeps each prompt under N tokens',
  max_model_calls: 'At most N model calls', must_output_file: 'Must make a file', custom: 'Custom (agent hook)',
};

// A readable default name for an assertion: its first few words, as a feedback key.
export function slugify(sentence: string, words = 5) {
  return sentence.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean).slice(0, words).join('-').slice(0, 48);
}

// Quiet hints under an assertion, for wordings judges tend to grade inconsistently. Advice, never a blocker.
const VAGUE = /\b(appropriate(?:ly)?|good|properly|proper|correctly|reasonabl[ey]|adequate(?:ly)?|helpful|nice|suitabl[ey]|relevant)\b/i;
const OBSERVABLE_VERB = 'says?|tells?|asks?|calls?|mentions?|offers?|repl(?:y|ies)|responds?|refuses?|declines?|includes?|quotes?|confirms?|apologi[sz]es?|promises?|recommends?|uses?|lists?|gives?|states?|explains?|escalates?|creates?|sends?|books?|cancels?|returns?|provides?|suggests?|names?|cites?|links?|writes?|answers?|shows?|requests?|summari[sz]es?|informs?|notes?|warns?|reports?|issues?|looks? up|checks?|refunds?|pass(?:es)?';
const OBSERVABLE = new RegExp(`\\b(${OBSERVABLE_VERB}|does not|doesn't|never|only|before|after)\\b|\`|\\w+_\\w+|"[^"]+"`, 'i');
const SECOND_CLAIM = new RegExp(`^(it|the agent|they|then|also|never|does|doesn't|is|isn't|will|won't|must|can't|cannot|${OBSERVABLE_VERB})\\b`, 'i');

export function assertionHints(sentence: string): string[] {
  const words = sentence.trim().split(/\s+/).filter(Boolean);
  if (words.length < 4) return [];
  const hints: string[] = [];
  const parts = sentence.split(/,?\s+and\s+/i);
  if (parts.slice(1).some((right, i) => parts[i].trim().split(/\s+/).length >= 3 && SECOND_CLAIM.test(right.trim()))) {
    hints.push('Two claims joined by “and”? Split them into two assertions, so a failure says which one broke.');
  }
  const vague = VAGUE.exec(sentence)?.[1];
  if (vague) hints.push(`“${vague}” is vague: judges read it differently. Say what the agent does instead.`);
  if (!OBSERVABLE.test(sentence)) hints.push('Nothing here shows in a transcript. Say what the agent says, asks or calls.');
  return hints;
}

// A default name for a code check, from its type and the tool it's about, so a new check never blocks saving.
export function autoCheckName(check: Pick<Check, 'type' | 'tool' | 'groups' | 'first' | 'second'>) {
  const tool = check.tool || check.groups.flat().find(Boolean) || check.second || '';
  return [check.type, tool].filter(Boolean).join('-').replace(/_/g, '-');
}
// Keys each type owns; anything else on a saved check rides along in `extra`.
const CHECK_KEYS: Record<string, string[]> = {
  must_call: ['tools'], must_not_call: ['tools'], max_tool_calls: ['max', 'tool'], max_tool_rounds: ['max'],
  must_call_before: ['first', 'second'], must_call_with_values: ['tool', 'args'], max_prompt_tokens: ['max'], max_model_calls: ['max'],
};

export function emptyCheck(type = 'must_call'): Check {
  return { key: keyId(), name: type.replace(/_/g, '-'), type, max: '', tool: '', first: '', second: '', groups: [], json: '', extra: {} };
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

function historyTurn(turn: Json): HistoryTurn {
  const role = turn.role === 'assistant' || turn.role === 'tool' ? turn.role : 'user';
  const toolCalls = Array.isArray(turn.tool_calls) ? turn.tool_calls.filter(isRecord).map((call) => ({
    id: text(call.id), name: text(call.name), args: isRecord(call.args) ? call.args : {},
  })) : [];
  return {
    key: keyId(), role, content: text(turn.content),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(role === 'tool' ? { toolCallId: text(turn.tool_call_id), toolName: text(turn.name) } : {}),
  };
}

function historyPayload(turn: HistoryTurn): Json {
  if (turn.role === 'tool') return { role: 'tool', content: turn.content, tool_call_id: turn.toolCallId ?? '', ...(turn.toolName ? { name: turn.toolName } : {}) };
  return { role: turn.role, content: turn.content, ...(turn.toolCalls?.length ? { tool_calls: turn.toolCalls } : {}) };
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
          ...(isRecord(row.after) ? { after: JSON.stringify(row.after) } : {}),
        })) ?? null,
      };
    }),
    history: history.map(historyTurn),
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
      let after: unknown;
      try {
        after = row.after?.trim() ? JSON.parse(row.after) : undefined;
      } catch {
        return { error: `${mock.tool}: a case's "after" isn't valid JSON.` };
      }
      if (after !== undefined && !(isRecord(after) && Object.values(after).every(isRecord))) {
        return { error: `${mock.tool}: "after" must look like {"update_post": {"post_id": "P1"}} ({} = any arguments).` };
      }
      cases.push({
        ...(when ? { when } : {}),
        ...(row.anyValue !== undefined ? { when_any_value: row.anyValue } : {}),
        ...(after ? { after } : {}),
        response: parseResponse(row.response),
      });
    }
    mockTools[mock.tool] = { cases };
  }
  if (draft.mockTools.length) inputs.mock_tools = mockTools;
  // Optional fields are omitted when empty, so a test that doesn't use them keeps its old shape.
  const history = draft.history.filter((turn) => turn.content.trim() || turn.toolCalls?.length).map(historyPayload);
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
  start: string; end: string; status: string; error: string; traceback: string; answer: string; assertions: AssertionResult[];
  // What the agent called this run, with arguments and results, for reading a grade against what it actually did.
  toolCalls: Json[];
};

function feedbackComment(stats: Json) {
  const comments = stats.comments;
  if (Array.isArray(comments)) return comments.map(String).filter(Boolean).join(' ');
  return typeof comments === 'string' ? comments : '';
}

// The test (example) an experiment ran: the harness writes it into the experiment's metadata.
function experimentExampleId(experiment: Json) {
  const extra = isRecord(experiment.extra) ? experiment.extra : {};
  const metadata = isRecord(extra.metadata) ? extra.metadata : {};
  return text(metadata.example_id);
}

// LangSmith's run error is `repr(exception)` followed by the traceback. The first part is what a person reads
// ("`create_reel` is not a tool Max has: ..."); the traceback is for debugging the hook.
export function readableError(error: string) {
  const head = error.split('\n\nTraceback')[0].trim();
  const wrapped = /^\w+\((["'])([\s\S]*)\1\)$/.exec(head);
  return (wrapped ? wrapped[2] : head).replace(/\\(["'])/g, '$1').trim();
}

export function tracebackOf(error: string) {
  const at = error.indexOf('Traceback (most recent call last)');
  return at === -1 ? '' : error.slice(at).trim();
}

// Every experiment run of one test (example), newest first, with its per-assertion scores.
//
// Asks for THIS test's experiments (the harness names them `<test name>-<suffix>`), then keeps the ones whose
// metadata names this example. Fetching "the dataset's 50 newest experiments" and filtering after looked fine
// on a small dataset and showed "No runs" for every test once the dataset had run more than 50.
export async function fetchResults(datasetId: string, exampleId: string, testName: string): Promise<TestResult[]> {
  const params: Record<string, string> = { reference_dataset: datasetId, limit: '50' };
  if (testName) params.name_contains = testName;
  const sessions = await callLangSmith<unknown>('GET /api/v1/sessions', { params });
  const experiments = (Array.isArray(sessions) ? sessions : []).filter(isRecord)
    .filter((experiment) => !experimentExampleId(experiment) || experimentExampleId(experiment) === exampleId);
  if (!experiments.length) return [];
  const names = new Map(experiments.map((e) => [text(e.id), text(e.name)]));
  const page = await callLangSmith<unknown>(`POST /api/v2/datasets/${datasetId}/experiment-runs`, {
    body: {
      experiment_ids: [...names.keys()],
      example_ids: [exampleId],
      page_size: 50,
      // ERROR, not ERROR_PREVIEW: the endpoint silently ignores ERROR_PREVIEW, so every errored run showed no reason.
      selects: ['ID', 'TRACE_ID', 'PROJECT_ID', 'START_TIME', 'END_TIME', 'STATUS', 'ERROR', 'OUTPUTS', 'FEEDBACK_STATS'],
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
      error: readableError(text(run.error) || text(run.error_preview)),
      traceback: tracebackOf(text(run.error)),
      answer: text(outputs.answer).trim(),
      toolCalls: Array.isArray(outputs.tool_calls) ? outputs.tool_calls.filter(isRecord) : [],
      assertions: Object.entries(stats).filter(([, v]) => isRecord(v)).map(([key, v]) => {
        const stat = v as Json;
        return { key, score: typeof stat.avg === 'number' ? stat.avg : null, comment: feedbackComment(stat) };
      }),
    };
  }).sort((a, b) => b.start.localeCompare(a.start));
}

// The judge's reason for one key on each run. The experiment-runs endpoint's FEEDBACK_STATS carries scores but
// `comments: null`, so a reason has to come from the feedback itself. One request per run: fine for one test's
// newest experiment (its few repetitions), too many for every run ever, so the drill-down asks, not the list.
export async function fetchReasons(runIds: string[], key: string): Promise<Record<string, string>> {
  const pairs = await Promise.all(runIds.map(async (runId) => {
    const page = await callLangSmith<unknown>('GET /api/v1/feedback', { params: { run: runId, key, limit: '5' } });
    const first = (Array.isArray(page) ? page : []).filter(isRecord)[0];
    return [runId, first ? text(first.comment) : ''] as const;
  }));
  return Object.fromEntries(pairs);
}

// --- Human labels: the right verdict for one assertion on one run, for the judge bench (server/bench.py) ---------

const LABEL_KEY = 'human-label';
export type Label = { feedbackId: string; correct: boolean; comment: string };

// One feedback item per (run, assertion): key human-label, score = the right verdict (1 pass, 0 fail), value = the
// assertion's name. Read per run, like the reasons, because it is only needed for one test's newest repetitions.
export async function fetchLabels(runIds: string[], name: string): Promise<Record<string, Label>> {
  const pairs = await Promise.all(runIds.map(async (runId) => {
    const page = await callLangSmith<unknown>('GET /api/v1/feedback', { params: { run: runId, key: LABEL_KEY, limit: '50' } });
    const mine = (Array.isArray(page) ? page : []).filter(isRecord).find((f) => text(f.value) === name);
    return mine ? [[runId, { feedbackId: text(mine.id), correct: mine.score === 1, comment: text(mine.comment) }] as const] : [];
  }));
  return Object.fromEntries(pairs.flat());
}

// `comment` is the expert's reason when the judge was wrong; Re-grade's rewrites are built from these reasons.
export async function saveLabel(runId: string, name: string, correct: boolean, existing?: Label, comment = ''): Promise<Label> {
  const score = correct ? 1 : 0;
  if (existing) {
    await callLangSmith(`PATCH /api/v1/feedback/${existing.feedbackId}`, { body: { score, comment } });
    return { ...existing, correct, comment };
  }
  const created = await callLangSmith<unknown>('POST /api/v1/feedback', { body: { run_id: runId, key: LABEL_KEY, score, value: name, ...(comment ? { comment } : {}) } });
  return { feedbackId: isRecord(created) ? text(created.id) : '', correct, comment };
}

// --- Test status (the dot in the test list) ---------------------------------------------------------------------

// pass: every assertion and check passed on every repetition. fail: some assertion or check failed on every
// repetition. flaky: anything in between. error: every run raised (e.g. an incomplete test). none: never run.
export type TestStatus = 'pass' | 'fail' | 'flaky' | 'error' | 'none';

// A test's newest run, as the list needs it. `costPerRun` is that experiment's LangSmith-priced agent cost divided
// by its runs (the agent's model calls only: graders trace elsewhere); null when the test has never been priced.
// `keys` is each assertion's and check's result on that run (passed of n repetitions), for the chip beside it.
export type KeyResult = { passed: number; n: number };
export type TestSummary = {
  status: TestStatus; costPerRun: number | null; keys: Record<string, KeyResult>; ranAt: string;
  runs: number; totalCost: number | null; latencyP50: number | null;
  // What the test asked when it ran (content hash; '' for runs from before it was recorded), the dataset's
  // version then, and the agent commit it ran on.
  testHash: string; testVersion: string; agentCommit: string;
  // A run of this test started somewhere (CLI, CI, another editor) and has no grades yet.
  runningElsewhere?: boolean;
};

function summaryOf(experiment: Json): TestSummary {
  const cost = typeof experiment.total_cost === 'number' ? experiment.total_cost : null;
  const runs = typeof experiment.run_count === 'number' && experiment.run_count > 0 ? experiment.run_count : null;
  const keys: Record<string, KeyResult> = {};
  for (const [key, stat] of Object.entries(isRecord(experiment.feedback_stats) ? experiment.feedback_stats : {})) {
    if (!isRecord(stat) || typeof stat.n !== 'number' || typeof stat.avg !== 'number') continue;
    keys[key] = { passed: Math.round(stat.avg * stat.n), n: stat.n };
  }
  const extra = isRecord(experiment.extra) ? experiment.extra : {};
  const metadata = isRecord(extra.metadata) ? extra.metadata : {};
  const git = isRecord(metadata.git) ? metadata.git : {};
  return {
    status: statusOf(experiment),
    costPerRun: cost !== null && runs !== null && cost > 0 ? cost / runs : null,
    keys,
    ranAt: text(experiment.start_time),
    runs: runs ?? 0,
    totalCost: cost,
    latencyP50: typeof experiment.latency_p50 === 'number' ? experiment.latency_p50 : null,
    testHash: text(metadata.test_hash),
    testVersion: text(metadata.dataset_version) || text(experiment.start_time),
    agentCommit: text(git.commit),
  };
}

function statusOf(experiment: Json): TestStatus {
  const errorRate = typeof experiment.error_rate === 'number' ? experiment.error_rate : 0;
  if (errorRate >= 1) return 'error';
  const stats = Object.values(isRecord(experiment.feedback_stats) ? experiment.feedback_stats : {}).filter(isRecord);
  if (!stats.length) return 'none';
  if (stats.some((stat) => stat.max === 0)) return 'fail';
  if (errorRate > 0 || stats.some((stat) => stat.min !== 1)) return 'flaky';
  return 'pass';
}

// The status of every test's newest experiment, by example id.
//
// Each test's runs are their own experiment, and an experiment's list entry carries its per-key min/max
// (include_stats), so no per-test calls are needed. Pages come newest first and the scan stops as soon as every
// test in `exampleIds` has a status, so it costs one page (~0.6s) however many experiments the dataset has run.
// A test that has never run is the only thing that makes it read every page. `onPage` gets the statuses so far,
// so dots appear while later pages load.
export async function fetchStatuses(
  datasetId: string,
  exampleIds: string[],
  onPage: (summaries: Record<string, TestSummary>) => void,
): Promise<Record<string, TestSummary>> {
  const wanted = new Set(exampleIds);
  const newest: Record<string, Json> = {};
  // Each test's newest experiment that is newer than its result and lists no grades.
  const ungraded: Record<string, Json> = {};
  // Tests whose such experiment really has no grades yet: being run right now, from anywhere.
  const running = new Set<string>();
  const now = Date.now();
  const statuses = () => Object.fromEntries([...new Set([...Object.keys(newest), ...running])].map((id) => [id, {
    ...(newest[id] ? summaryOf(newest[id]) : never()),
    runningElsewhere: running.has(id) && !(id in newest),
  }]));
  for (let offset = 0; ; offset += STATUS_PAGE) {
    const page = await callLangSmith<unknown>('GET /api/v1/sessions', {
      params: {
        reference_dataset: datasetId, include_stats: 'true', sort_by: 'start_time', sort_by_desc: 'true',
        limit: String(STATUS_PAGE), offset: String(offset),
      },
    });
    const experiments = (Array.isArray(page) ? page : []).filter(isRecord);
    for (const experiment of experiments) {
      const exampleId = experimentExampleId(experiment);
      if (!exampleId || exampleId in newest) continue;
      // Newest first, so the first RESULT seen for a test is its newest. One whose list entry shows no grades isn't
      // one yet (it would read as "never run" and hide the real result behind it), but it may only be lagging:
      // its newest such experiment is checked against its runs below.
      if (isResult(experiment)) newest[exampleId] = experiment;
      else ungraded[exampleId] ??= experiment;
    }
    onPage(statuses());
    const allFound = [...wanted].every((id) => id in newest);
    if (allFound || experiments.length < STATUS_PAGE) break;
  }
  await gradeFromRuns(datasetId, ungraded);
  for (const [exampleId, experiment] of Object.entries(ungraded)) {
    // Newer than any result found for the test, so once its runs show grades it IS the newest result.
    if (isResult(experiment)) newest[exampleId] = experiment;
    else if (isRunning(experiment, now)) running.add(exampleId);
  }
  // Every test not found on any page has never run.
  return { ...Object.fromEntries([...wanted].map((id) => [id, never()])), ...statuses() };
}

// Fills in each experiment's feedback_stats and error_rate from its runs, in place: one request per 50 tests, and
// only for experiments whose list entry showed no grades (usually none, a few while something is running).
async function gradeFromRuns(datasetId: string, experiments: Record<string, Json>): Promise<void> {
  const entries = Object.entries(experiments);
  for (let i = 0; i < entries.length; i += 50) {
    const batch = entries.slice(i, i + 50);
    const page = await callLangSmith<unknown>(`POST /api/v2/datasets/${datasetId}/experiment-runs`, {
      body: {
        experiment_ids: batch.map(([, e]) => text(e.id)),
        example_ids: batch.map(([id]) => id),
        page_size: 50,
        selects: ['ID', 'PROJECT_ID', 'STATUS', 'ERROR', 'FEEDBACK_STATS'],
      },
    });
    const items = isRecord(page) && Array.isArray(page.items) ? page.items.filter(isRecord) : [];
    const runs = items.flatMap((item) => (Array.isArray(item.runs) ? item.runs.filter(isRecord) : []));
    for (const [, experiment] of batch) {
      const mine = runs.filter((run) => text(run.project_id) === text(experiment.id));
      // The lagging list entry can lack run_count too, which read as "0 repetitions" beside real grades.
      Object.assign(experiment, statsFromRuns(mine), mine.length ? { run_count: mine.length } : {});
    }
  }
}

function never(): TestSummary {
  return {
    status: 'none', costPerRun: null, keys: {}, ranAt: '', runs: 0, totalCost: null, latencyP50: null, testHash: '', testVersion: '', agentCommit: '',
  };
}

const STATUS_PAGE = 100;

// Why a test's newest result no longer describes it, or null if it still does. Out of date when what the test
// asks changed after the run (its content hash differs from the one the run recorded: metadata such as tags or a
// description does not count), or when the agent's code moved on. Web mode knows the current commit and every
// commit with the same agent code (`sameAgentCommits`: commits that only touched evals or docs don't count); a run
// records its own. `currentHash` is the test's hash now (contentHash.ts); undefined while it is computed.
export function staleness(summary: TestSummary | undefined, currentHash: string | undefined, agentCommit?: string,
  sameAgentCommits?: string[]): string | null {
  if (!summary || summary.status === 'none') return null;
  // Runs from before hashes were recorded can't be compared; saying "out of date" for them would be a guess.
  if (summary.testHash && currentHash && summary.testHash !== currentHash) return 'the test was edited after this run';
  const ran = summary.agentCommit;
  const sameAgent = sameAgentCommits?.length
    ? sameAgentCommits.some((commit) => commit.startsWith(ran.slice(0, 7)))
    : !agentCommit || ran.startsWith(agentCommit.slice(0, 7));
  if (agentCommit && ran && !sameAgent) {
    return `the agent's code changed since this run (${summary.agentCommit.slice(0, 8)} → ${agentCommit.slice(0, 8)})`;
  }
  return null;
}

// --- Import a past run as a test -----------------------------------------------------------------------------

export type PastRun = { traceId: string; prompt: string; start: string; hidden: boolean };

// A traced message, in whichever shape the tracer stored it: a LangChain message dict ({type, content, ...}), an
// OpenAI-style dict ({role, content}), or LangChain's serialized form ({lc, id: [..., "HumanMessage"], kwargs}).
type TracedMessage = { role: 'user' | 'assistant' | 'tool' | 'system'; content: string; toolCalls: ToolCall[]; toolCallId: string; toolName: string };

function tracedMessage(raw: Json): TracedMessage {
  const m = isRecord(raw.kwargs) && Array.isArray(raw.id) ? { ...raw.kwargs, type: String(raw.id[raw.id.length - 1]) } : raw;
  const kind = text(m.type || m.role).toLowerCase();
  const role = /human|user/.test(kind) ? 'user' : /ai|assistant/.test(kind) ? 'assistant' : /tool|function/.test(kind) ? 'tool' : 'system';
  const blocks = Array.isArray(m.content) ? m.content.filter(isRecord) : [];
  const content = typeof m.content === 'string' ? m.content : blocks.filter((b) => !b.type || b.type === 'text').map((b) => text(b.text)).join('');
  // Tool calls are on `tool_calls` in LangChain's format; Anthropic-style content also carries them as tool_use blocks.
  const listed = Array.isArray(m.tool_calls) ? m.tool_calls.filter(isRecord) : [];
  const toolCalls = (listed.length ? listed.map((c) => ({ id: text(c.id), name: text(c.name), args: isRecord(c.args) ? c.args : {} }))
    : blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: text(b.id), name: text(b.name), args: isRecord(b.input) ? b.input : {} })));
  return { role, content, toolCalls, toolCallId: text(m.tool_call_id), toolName: text(m.name) };
}

function tracedMessages(inputs: unknown): TracedMessage[] {
  const raw = isRecord(inputs) && Array.isArray(inputs.messages) ? inputs.messages : [];
  // A chat-model run nests its messages one level deeper ([[...]]).
  const flat = raw.length === 1 && Array.isArray(raw[0]) ? raw[0] : raw;
  return flat.filter(isRecord).map(tracedMessage);
}

// Splits a root run's input messages into the prompt (the last user message) and everything before it.
export function promptAndHistory(inputs: unknown): { prompt: string; history: HistoryTurn[] } {
  const messages = tracedMessages(inputs);
  const last = messages.map((m) => m.role).lastIndexOf('user');
  if (last === -1) return { prompt: '', history: [] };
  const history = messages.slice(0, last).filter((m) => m.role !== 'system' && (m.content.trim() || m.toolCalls.length || m.role === 'tool'))
    .map((m): HistoryTurn => ({
      key: keyId(), role: m.role as HistoryTurn['role'], content: m.content,
      ...(m.toolCalls.length ? { toolCalls: m.toolCalls } : {}),
      ...(m.role === 'tool' ? { toolCallId: m.toolCallId, toolName: m.toolName } : {}),
    }));
  return { prompt: messages[last].content, history };
}

function humanPrompt(inputs: unknown) {
  return promptAndHistory(inputs).prompt;
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

// A recorded trace: its root run and its calls to the agent's tools, oldest first. Read once for the preview and
// reused by Make proposal, so confirming doesn't fetch it again.
export type Trace = { traceId: string; root: Json; toolRuns: Json[] };

export async function fetchTrace(traceId: string, agentTools: string[]): Promise<Trace> {
  const [root] = await queryAll({ trace: traceId, is_root: true, limit: 1 });
  if (!root) throw new Error('No trace with that ID in this workspace.');
  if (root.inputs == null) throw new Error("This trace's inputs are hidden, so there is nothing to import.");
  const toolRuns = (await queryAll({ trace: traceId, run_type: 'tool', limit: 100 }))
    .filter((run) => !agentTools.length || agentTools.includes(text(run.name)))
    .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
  return { traceId, root, toolRuns };
}

// What the preview shows before anything is written: the message, the agent's reply and its tool calls, in the
// shape a test result's tool calls have ({name, args, result | error}).
export function tracePreview(trace: Trace) {
  const { prompt, history } = promptAndHistory(trace.root.inputs);
  const toolCalls = trace.toolRuns.map((run): Json => {
    const response = toolResponse(run);
    const raised = isRecord(response) && 'raise' in response && Object.keys(response).length === 1;
    return { name: text(run.name), args: isRecord(run.inputs) ? run.inputs : {}, ...(raised ? { error: text(response.raise) } : { result: response }) };
  });
  return { prompt, turns: history.filter((t) => t.role === 'user').length, reply: finalReply(trace.root.outputs), toolCalls, start: text(trace.root.start_time) };
}

// Builds a test from a recorded trace: the user's prompt becomes When, and every call to one of the agent's tools
// becomes a mock (one case per distinct argument set). Assertions are left for the user to write.
export function importTrace(trace: Trace) {
  const { traceId, root, toolRuns } = trace;
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
  const { prompt, history } = promptAndHistory(root.inputs);
  const draft: Draft = {
    name: `trace-${traceId.slice(0, 8)}`,
    description: `Imported from trace ${traceId} (${started}).`,
    prompt,
    mockTools,
    history,
    context: '',
    assertions: [{ key: keyId(), name: '', assertion: '' }],
    checks: [],
    splits: ['base'],
  };
  return { draft, recordedOn: started, toolCalls: toolRuns.length, rootRunId: text(root.id), sourceOutput: finalReply(root.outputs) };
}

// The agent's last reply in a traced run's outputs, whichever shape the tracer stored it in.
function finalReply(outputs: unknown): string {
  if (!isRecord(outputs)) return '';
  const messages = Array.isArray(outputs.messages) ? outputs.messages.filter(isRecord).map(tracedMessage) : [];
  const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.content.trim());
  if (last) return last.content.slice(0, 6000);
  return typeof outputs.output === 'string' ? outputs.output.slice(0, 6000) : '';
}

export type SourceFeedback = { key: string; score: number | null; comment: string };

// Feedback on the run a proposal came from: usually the thumbs-down and its comment that flagged it.
export async function fetchRunFeedback(runId: string): Promise<SourceFeedback[]> {
  const rows = await callLangSmith<unknown>('GET /api/v1/feedback', { params: { run: runId, limit: '20' } });
  return (Array.isArray(rows) ? rows : []).filter(isRecord).map((row) => ({
    key: text(row.key), score: typeof row.score === 'number' ? row.score : null, comment: text(row.comment),
  }));
}

// --- Gaps in a test ------------------------------------------------------------------------------------------

export type MockGap = { tool: string; args: Json };

// Tool calls in a run that no mock answered. The agent got an error back that the test never wrote, so the run says
// nothing about the agent: the test needs a mock (or a case) for each of these.
export function mockGaps(run: Pick<TestResult, 'toolCalls' | 'error' | 'assertions'>): MockGap[] {
  const gaps = run.toolCalls
    .filter((call) => /is not mocked in this test/.test(text(call.error)))
    .map((call) => ({ tool: text(call.name), args: isRecord(call.args) ? call.args : {} }));
  // An errored run records no tool calls; its error names the tools ("Test incomplete: no mock answered a, b").
  const named = /no mock answered ([\w, ]+)/.exec(run.error)?.[1].split(',').map((t) => t.trim()).filter(Boolean) ?? [];
  for (const tool of named) if (!gaps.some((gap) => gap.tool === tool)) gaps.push({ tool, args: {} });
  const seen = new Set<string>();
  return gaps.filter((gap) => { const k = `${gap.tool}:${stableStringify(gap.args)}`; return !seen.has(k) && seen.add(k); });
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

// --- Files in a test's Given ------------------------------------------------------------------------------

export type TestFile = { name: string; mime_type: string; sha256: string };

// The files a test lists in inputs.attachments (server/files.py).
export function testFiles(example: Example): TestFile[] {
  const rows = Array.isArray(example.inputs.attachments) ? example.inputs.attachments.filter(isRecord) : [];
  return rows.map((row) => ({ name: text(row.name), mime_type: text(row.mime_type), sha256: text(row.sha256) })).filter((row) => row.name);
}

export function withFiles(example: Example, files: TestFile[]): Example {
  const { attachments: _old, ...inputs } = example.inputs;
  return { ...example, inputs: files.length ? { ...inputs, attachments: files } : inputs };
}

// Opens one run's trace in LangSmith (a new tab), from the Results panel or a drill-down repetition.
export async function openTrace(result: Pick<TestResult, 'runId' | 'experimentId' | 'traceId'>) {
  const response = await callLangSmith<{ url: string }>(`GET /api/v2/runs/${result.runId}/url`, {
    params: { project_id: result.experimentId, trace_id: result.traceId },
  });
  if (response?.url) window.langsmith.openUrl(response.url, { newTab: true });
}

// --- Proposals ------------------------------------------------------------------------------------------------
// A proposal is a test that isn't part of the eval set yet: a dataset example with metadata.status = "proposal".
// Flagged traces arrive in an annotation queue (PROPOSALS_QUEUE); opening one imports it as a proposal that
// remembers its queue run (metadata.source_run_id). Accept makes it a test and takes the run out of the queue.

export function isProposal(example: Example) {
  return example.metadata.status === 'proposal';
}

export type QueuedRun = { runId: string; traceId: string; prompt: string; turns: number; start: string; hidden: boolean };

// The queue's id, or null when it doesn't exist (the server creates it on start; see server/proposals.py).
export async function fetchProposalQueue(): Promise<string | null> {
  const rows = await callLangSmith<unknown>('GET /api/v1/annotation-queues', { params: { name: PROPOSALS_QUEUE } });
  const queue = (Array.isArray(rows) ? rows : []).filter(isRecord).find((q) => q.name === PROPOSALS_QUEUE);
  return queue ? text(queue.id) : null;
}

export async function fetchQueuedRuns(queueId: string): Promise<QueuedRun[]> {
  const rows = await callLangSmith<unknown>(`GET /api/v1/annotation-queues/${queueId}/runs`, { params: { limit: '100' } });
  return (Array.isArray(rows) ? rows : []).filter(isRecord).map((run) => {
    const { prompt, history } = promptAndHistory(run.inputs);
    return {
      runId: text(run.id), traceId: text(run.trace_id) || text(run.id), prompt, turns: history.filter((t) => t.role === 'user').length,
      start: text(run.start_time), hidden: run.inputs == null,
    };
  }).sort((a, b) => b.start.localeCompare(a.start));
}

export async function removeFromQueue(queueId: string, runId: string) {
  await callLangSmith(`DELETE /api/v1/annotation-queues/${queueId}/runs/${runId}`);
}

// A new, unsaved proposal from an imported trace; autosave creates the example once it's valid.
// `source` is what went wrong in the original run (its reply and the feedback that flagged it), kept so the expert
// can see it while writing assertions.
export function proposalExample(prompt: string, recordedOn: string, traceId: string, runId?: string,
  source?: { output: string; feedback: SourceFeedback[] }): Example {
  const example = emptyExample();
  return {
    ...example,
    inputs: { prompt, recorded_on: recordedOn },
    metadata: {
      ...example.metadata, status: 'proposal', source_trace_id: traceId, ...(runId ? { source_run_id: runId } : {}),
      ...(source?.output ? { source_output: source.output } : {}), ...(source?.feedback.length ? { source_feedback: source.feedback } : {}),
    },
  };
}

// Accept: the proposal becomes a test. Only metadata changes, so its results stay current. A flagged trace is
// usually a known bug: `knownBug` (the reason) marks it xfail, so it's expected to fail until the agent is fixed and
// the CLI reports it XPASSED, failing the suite, once it starts passing (server/suite.py).
export async function acceptProposal(example: Example, knownBug?: string): Promise<Example> {
  const metadata = { ...example.metadata, status: 'active', ...(knownBug ? { xfail: knownBug } : {}) };
  await callLangSmith(`PATCH /api/v1/examples/${example.id}`, { body: { metadata } });
  return { ...example, metadata };
}

// Marks a test as a known bug (reason) or clears the mark (null).
export async function setKnownBug(example: Example, reason: string | null): Promise<Example> {
  const { xfail: _old, ...rest } = example.metadata;
  const metadata = reason ? { ...rest, xfail: reason } : rest;
  await callLangSmith(`PATCH /api/v1/examples/${example.id}`, { body: { metadata } });
  return { ...example, metadata };
}
