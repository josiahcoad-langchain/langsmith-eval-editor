# Eval editor: context

A Given / When / Assert test editor for an agent, over one LangSmith dataset (default `eval-editor-demo`). The same
`src/App.tsx` runs as a web app (`src/web.tsx`, served by `server/main.py`) and as a LangSmith custom app
(`src/entry.tsx`). See the repo README for setup.

## Key files

- `src/lib/data.ts`: all LangSmith I/O. Dataset lookup by name (tool names come from the dataset's
  `metadata.agent_tools`, written by the server), examples, draft <-> example (`toDraft` / `toPayload`), results
  (`POST /api/v2/datasets/<id>/experiment-runs` with `selects`), Import from the trace project.
- `src/runs.ts`: Run test. Web: `POST /api/runs` on the server. Custom app: a commit to the prompt repo
  `eval-editor-run-requests` (template = `key: value` lines; each commit names the latest as `parent_commit`, retried
  once on a race), which a prompt webhook turns into a server run.
- `src/web.tsx`: a `window.langsmith` shim over the server's `/api/langsmith/*` proxy, plus light/dark from
  `prefers-color-scheme`.
- `src/components/`: `MockToolEditor` (When / Returns table, cases per argument), `ResultsPanel` (polls every 15 s;
  groups repetitions by experiment), `fields`.

## Data shape

`inputs.prompt`, `inputs.mock_tools` (`{tool: response | {"cases": [{when, response}]} | {"raise": msg}}`),
`inputs.recorded_on`, `outputs.assertions` (`[{name, assertion}]`), `metadata.name|description|dataset_split`.
Assertion and test names are lowercase-with-dashes (typed `_`/spaces convert).

## Decisions

- Tests autosave ~800 ms after the last valid edit; only the saved baseline updates after a save, so typing during
  a save isn't lost. The dirty check is cached per draft (WeakMap), because recorded mocks can be large.
- Inputs are native controls styled with Macaw tokens (Macaw `Input` hit an invalid hook call in the sandbox).
- The results badge counts assertions that passed on every repetition; rows that passed on some say "flaky".

## Gotchas

- 1 MB custom-app bundle limit; the bundle is ~980 KB. `postcss.config.js` drops non-Latin font subsets.
- `langsmith apps dev` keeps the token it started with; after ~15 minutes calls return 401. Restart it.
- The dev server rejects binary files in the app directory; screenshots live in `/docs`.
