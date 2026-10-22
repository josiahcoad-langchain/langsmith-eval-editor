import type { TestFile } from './lib/data';
// How Run test reaches the eval server, in each mode:
//   web         POST /api/runs on the server that serves this page; it runs the tests right away.
//   custom app  The app can only talk to LangSmith, so it commits the request to a Context Hub prompt repo
//               (REQUESTS_REPO). A prompt webhook on that repo wakes the server, which reads the repo and runs it.
import { REQUESTS_REPO } from './config';

export type RunRequest = { test: string; exampleId: string; repetitions: number };
// A run that hasn't produced results yet: `detail` says what it's waiting on.
export type PendingRun = { requestedAt: string; state: 'requested' | 'queued' | 'running' | 'error'; detail: string };

let web = false;
export function enableWebRunner() {
  web = true;
}
export const isWeb = () => web;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === 'string' ? value : '');

async function errorFrom(response: Response) {
  return new Error(`${response.status}: ${(await response.text()).slice(0, 300)}`);
}

export async function requestRun(request: RunRequest) {
  await requestRuns([request]);
}

// Several tests in one go (Run all, Run failing). The web server runs a few at a time and queues the rest.
export async function requestRuns(requests: RunRequest[]) {
  if (!requests.length) return;
  if (web) {
    const response = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ example_ids: requests.map((r) => r.exampleId), repetitions: requests[0].repetitions }),
    });
    if (!response.ok) throw await errorFrom(response);
    return;
  }
  // One commit per test: that is the custom-app queue's unit, and the server de-duplicates by test.
  for (const request of requests) {
    await commitRequest({
      test: request.test,
      example_id: request.exampleId,
      repetitions: request.repetitions,
      requested_at: new Date().toISOString(),
    });
  }
}

// Tests with a run queued or in progress right now, by example id. Web mode only: the custom-app queue lives in
// a prompt repo the server drains on its own schedule, so the app cannot tell queued from finished.
export async function fetchActiveRuns(): Promise<Record<string, 'queued' | 'running'>> {
  if (!web) return {};
  const response = await fetch('/api/runs');
  if (!response.ok) return {};
  const active: Record<string, 'queued' | 'running'> = {};
  for (const job of (await response.json()) as Json[]) {
    const state = job.state;
    const id = text(job.example_id);
    if (state === 'running') active[id] = 'running';
    else if (state === 'queued' && active[id] !== 'running') active[id] = 'queued';
  }
  return active;
}

// Runs of this test that haven't produced results yet.
export async function fetchPending(exampleId: string, latestResult: string): Promise<PendingRun[]> {
  if (web) {
    const response = await fetch('/api/runs');
    if (!response.ok) throw await errorFrom(response);
    const jobs = ((await response.json()) as Json[]).filter((job) => job.example_id === exampleId && job.state !== 'done');
    return jobs.map((job) => ({
      requestedAt: text(job.requested_at),
      state: job.state as PendingRun['state'],
      detail: job.state === 'error' ? `Failed: ${text(job.error)}` : job.state === 'running'
        ? `Running ${job.repetitions} repetition${job.repetitions === 1 ? '' : 's'}. Results show up as each one is graded.`
        : 'Starting…',
    }));
  }
  const requests = await fetchRequests();
  return requests
    .filter((request) => request.example_id === exampleId && text(request.requested_at) > latestResult)
    .map((request) => ({
      requestedAt: text(request.requested_at),
      state: 'requested' as const,
      detail: 'Waiting for the eval server to pick it up (via the run-requests webhook). Results stream in once it does.',
    }))
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

// --- Custom-app queue: one prompt-repo commit per request, its template holding `key: value` lines -------------

const call = (operation: string, args?: { params?: Record<string, string>; body?: unknown }) => window.langsmith.call(operation, args);

function parseRequest(template: string): Json {
  return Object.fromEntries(template.split('\n').map((line) => {
    const at = line.indexOf(': ');
    return at === -1 ? [line.replace(/:$/, ''), ''] : [line.slice(0, at), line.slice(at + 2)];
  }));
}

async function latestCommit() {
  const page = await call(`GET /api/v1/commits/-/${REQUESTS_REPO}`, { params: { limit: '1' } });
  const [latest] = isRecord(page) && Array.isArray(page.commits) ? page.commits.filter(isRecord) : [];
  return latest ? text(latest.commit_hash) : undefined;
}

// Each commit must name the latest one as its parent, so a click that races another retries once on the new head.
async function commitRequest(request: Json) {
  const template = Object.entries(request).map(([k, v]) => `${k}: ${v ?? ''}`).join('\n');
  const manifest = {
    lc: 1, type: 'constructor', id: ['langchain', 'prompts', 'prompt', 'PromptTemplate'],
    kwargs: { template, input_variables: [], template_format: 'f-string' },
  };
  for (let attempt = 0; ; attempt += 1) {
    try {
      const parent = await latestCommit();
      await call(`POST /api/v1/commits/-/${REQUESTS_REPO}`, { body: { manifest, ...(parent ? { parent_commit: parent } : {}) } });
      return;
    } catch (error) {
      const message = isRecord(error) ? text(error.message) : String(error);
      if (attempt > 0 || !/parent commit/i.test(message)) throw error;
    }
  }
}

async function fetchRequests(): Promise<Json[]> {
  const page = await call(`GET /api/v1/commits/-/${REQUESTS_REPO}`, { params: { limit: '100' } });
  const commits = isRecord(page) && Array.isArray(page.commits) ? page.commits.filter(isRecord) : [];
  return commits.map((commit) => {
    const kwargs = isRecord(commit.manifest) && isRecord(commit.manifest.kwargs) ? commit.manifest.kwargs : {};
    return parseRequest(text(kwargs.template));
  });
}


// --- Re-grade (web mode): grade one assertion again over the test's saved transcripts ---------------------------

export type Regrade = {
  experiment: string; assertion: { name: string; assertion: string }; judges: string[]; times: number;
  repetitions: { number: number; original: boolean | null; regrades: Record<string, (boolean | null)[]>; reasons: Record<string, string>; answer: string; tool_calls: string[] }[];
  cause: 'judge_unreliable' | 'grade_overturned' | 'assertion_ambiguous' | 'agent_varied' | 'consistent_fail' | 'consistent_pass';
  advice: string;
  failing_repetitions: number[]; disputed_repetitions: number[]; unreliable_judges: string[]; overturned_repetitions: number[];
};

export async function requestRegrade(exampleId: string, name: string, times = 3): Promise<Regrade> {
  const response = await fetch('/api/regrade', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ example_id: exampleId, name, times }),
  });
  if (!response.ok) throw await errorFrom(response);
  return (await response.json()) as Regrade;
}

// --- Assertion drafts from the judge model (web mode, server/drafting.py) --------------------------------------

async function postDrafts(path: string, body: Json): Promise<string[]> {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw await errorFrom(response);
  const answer = (await response.json()) as { assertions?: unknown };
  return Array.isArray(answer.assertions) ? answer.assertions.map(text).filter(Boolean) : [];
}

// 2-4 assertions for a proposal, from its message, the original reply and the flag's comment.
export function requestSuggestions(prompt: string, reply: string, feedback: Json[], existing: string[]) {
  return postDrafts('/api/suggest-assertions', { prompt, reply, feedback, existing });
}

// 1-2 rewrites of an assertion Re-grade found ambiguous or unreliably graded, from the expert's and judges' reasons.
export function requestRewrites(assertion: string, cause: string, expertReasons: string[], judgeReasons: string[]) {
  return postDrafts('/api/rewrite-assertion', { assertion, cause, expert_reasons: expertReasons, judge_reasons: judgeReasons });
}

// --- Files in a test's Given (server/attach.py). Web mode only: uploading needs the server. ---

export async function uploadFile(exampleId: string, file: File): Promise<TestFile[]> {
  const response = await fetch(`/api/examples/${exampleId}/files?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!response.ok) throw await errorFrom(response);
  return (await response.json()) as TestFile[];
}

export async function removeFile(exampleId: string, name: string): Promise<TestFile[]> {
  const response = await fetch(`/api/examples/${exampleId}/files/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!response.ok) throw await errorFrom(response);
  return (await response.json()) as TestFile[];
}

export function fileUrl(exampleId: string, file: TestFile) {
  // The hash in the URL makes a replaced file load fresh instead of from the browser cache.
  return `/api/examples/${exampleId}/files/${encodeURIComponent(file.name)}?v=${file.sha256.slice(0, 12)}`;
}
