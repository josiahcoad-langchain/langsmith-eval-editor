// What the editor edits and where it looks. Set these at build time (VITE_* variables in app/.env) to point the
// editor at another agent; they must match the server's EVAL_DATASET / REQUESTS_REPO.
export const DATASET_NAME = import.meta.env.VITE_DATASET_NAME ?? 'eval-editor-demo';
// Custom-app mode only: Run test commits to this Context Hub prompt repo; a commit webhook wakes the server.
export const REQUESTS_REPO = import.meta.env.VITE_REQUESTS_REPO ?? 'eval-editor-run-requests';
// The tracing project of the agent's real (non-eval) runs, for Import.
export const TRACE_PROJECT = import.meta.env.VITE_TRACE_PROJECT ?? 'eval-editor-demo-agent';
// Eval proposals: flagged traces land in this annotation queue (server/proposals.py creates it).
export const PROPOSALS_QUEUE = import.meta.env.VITE_PROPOSALS_QUEUE ?? 'eval-editor-demo-proposals';
