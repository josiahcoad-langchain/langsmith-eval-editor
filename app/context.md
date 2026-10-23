# Eval editor: context

A Given / When / Then test editor for an agent, over one LangSmith dataset (default `eval-editor-demo`). The same
`src/App.tsx` runs as a web app (`src/web.tsx`, served by `server/main.py`) and as a LangSmith custom app
(`src/entry.tsx`). See the repo README for setup.

## Key files

- `src/lib/data.ts`: all LangSmith I/O.
  - Dataset lookup by name. Tool names come from the dataset's `metadata.agent_tools`, written by the server.
  - Examples, and draft <-> example (`toDraft` / `toPayload`).
  - Results: `fetchResults` gets the test's experiments by name, then `POST /api/v2/datasets/<id>/experiment-runs` with `selects`.
  - Status dots, last-run line and cost: `fetchStatuses` reads the experiment list with `include_stats`.
  - `staleness`, and Import from the trace project.
- `src/runs.ts`: Run test, Run all, Run failing.
  - Web: `POST /api/runs` on the server, which runs 8 tests at a time (EVAL_PARALLEL changes it), and `GET /api/runs` for queued and running tests.
  - Custom app: one commit per test to the prompt repo `eval-editor-run-requests` (template = `key: value` lines; each commit names the latest as `parent_commit`, retried once on a race), which a prompt webhook turns into a server run.
- `src/web.tsx`: a `window.langsmith` shim over the server's `/api/langsmith/*` proxy, plus light/dark from `prefers-color-scheme`. `/api/config` also reports `agentCommit`.
- `src/components/`:
  - `MockToolEditor`: When / Returns table, cases per argument, `sequence`, `when_any_value`.
  - `CheckEditor`: code checks.
  - `HistoryEditor`: collapsed turn list, uncontrolled while editing.
  - `ResultsPanel`: polls every 15 s, groups repetitions by experiment.
  - `ResultChip`: per assertion and check.
  - `LastRun`: "Passed 3/3 · Oct 16" in the top bar; details in its tooltip.
  - `RunCompare`, `ToolCalls` (shared by the drill-down and compare), `ErrorDetails` (raw error + traceback under "Details").
  - `ActionsMenu`: the "⋯" menus and Given's "Add ▾".
  - `fields`: `TextAreaField` with `maxRows` grows, then scrolls.

## Data shape

- `inputs`:
  - `prompt`
  - `history?` (`[{role, content}]`; an assistant turn may carry `tool_calls: [{id, name, args}]`, and a `tool` turn is one call's result, `{role: "tool", content, tool_call_id, name}`: LangChain message dicts)
  - `context?` (opaque JSON for the hook)
  - `recorded_on?`
  - `mock_tools`: `{tool: response | {"cases": [{when?, when_any_value?, response}]} | {"sequence": [...]} | {"raise": msg}}`
- `outputs`: `assertions` (`[{name, assertion}]`) and `checks?` (`[{name, type, ...params}]`).
- `metadata`: `name`, `description`, `dataset_split`, and for tests imported from a trace `source_run_id` (its annotation-queue run), `source_trace_id`, `source_output`, `source_feedback`. Older examples may carry `status: "proposal"` (the CLI skips them) or `xfail` (the CLI expects a failure); the editor shows neither, and drops `status: "proposal"` when it saves.
- Empty `history` / `context` / `checks` are left out.
- Assertion, check and test names are lowercase-with-dashes (typed `_`/spaces convert). Assertions and checks share one namespace (feedback keys).

## Decisions

- **Autosave.** Tests autosave ~800 ms after the last valid edit; only the saved baseline updates after a save, so typing during a save isn't lost. The dirty check is cached per draft (WeakMap), because recorded mocks can be large. Because a test autosaves when opened if its save would differ, writers must store tests exactly as `toPayload` does: no empty optional fields.
- **Inputs** are native controls styled with Macaw tokens (Macaw `Input` hit an invalid hook call in the sandbox).
- **Given is everything true before the prompt**: tool answers (mocks), earlier messages (history), files, context. When is only the prompt.
- **Status dots.**
  - The status is the newest experiment's: pass = every key's min is 1, fail = some key's max is 0, flaky = anything else, error = every run raised.
  - Experiments are read newest first, stopping once every test has a status.
  - A test has no dot until its status is known: showing "never run" while loading would be false.
- **Out of date** = the test was modified after the run's `dataset_version`, or the run's `git.commit` differs from the server's `agentCommit` (web only). It fades dots and chips and the top bar says "Out of date · Run again" (no hashes; the reason is in the tooltip).
- **Cost estimate** = the newest experiment's `total_cost / run_count` × repetitions, the agent's model calls only. Tests with no priced run are counted, not guessed.
- **The results badge** counts assertions that passed on every repetition that ran ("2 of 5 passed every time"). An errored repetition never counts as a pass; a run where every repetition errored shows the friendly error in red. `INTERNAL_KEYS` (`all-tools-mocked`) are never shown.

- **No proposals in the UI** (2026-10-23, user decision). Importing a flagged trace or a past run creates an ordinary test and opens it; the flagged list is at the top of Import (the annotation queue's runs minus those some example names in `source_run_id`). The queue item is removed when the imported test is first saved, or when it's deleted. The known-bug (`xfail`) bar and Accept-as-known-bug are gone too; server/CLI handling is unchanged. `promptAndHistory` (data.ts) reads a root run's messages in LangChain, OpenAI or serialized-`lc` shape.

- Written for a subject-matter expert, not an engineer (SME reviews 2026-10-22 and -23). Rule: no ids or hashes
  by default, one primary action per screen; debugging detail is hidden (tooltip, ⋯, Details, Advanced), not deleted.
  Before/after screenshots: `/docs/simplify/`. After: ~147 words, 22 buttons, 6 inputs on a passing test (was 424/34/11).
  - Top bar: editable title (stored as the dashed `name`; typed and shown as words; legacy `trace-<id>` names read
    as the message), description line, status dot, `LastRun`, Run ×N, ⋯ (Results, Duplicate, Open in LangSmith,
    Delete). "Saving…" and errors only; no "Saved".
  - Given starts collapsed with a one-line summary; earlier messages and files show only once the test has some
    (Add ▾); context is under Advanced (open when non-empty). Mock conditions read "When order_id is …" for one
    string argument; any-argument and after-calls are under "More conditions".
  - Then: one sentence per row with its chip ("3/3 passed") and a trash button. Names (feedback keys) are never shown:
    they follow the sentence like a slug (`slugify`, `autoCheckName`), and a repeat gets -2 at save. Code checks
    collapse to "+ Add code check" until one exists.
  - A run that called an unmocked tool shows "A tool had no answer, so this result doesn't count." with Add answer
    (`mockGaps`), and hides "Judge right?" on those repetitions.
  - Errors read as `friendlyError` (401 → "Couldn't reach the model (API key rejected)", else "The run failed");
    the raw text and traceback are under Details (`ErrorDetails`).
  - Re-grade shows only when the repetitions disagree ("Why is this inconsistent?", web mode); verdict and advice
    visible, the judge table under Details. Ambiguous/unreliable verdicts draft rewrites (`/api/rewrite-assertion`).
  - "Judge right? ✗" asks for a reason, saved as the `human-label` feedback's comment.
  - Suggest (any test with `source_trace_id`, web mode) posts the prompt, `source_output` and `source_feedback` to
    `/api/suggest-assertions` and appends 2-4 rows, replacing an empty one.
  - Results: per run, one badge line and ✓/✗ per repetition; Compare…/Trace in a repetition's ⋯ (shown on hover),
    Open in LangSmith in the run's ⋯.
  - `assertionHints` (data.ts): quiet hints under an assertion for "and" joining two claims, vague words, or nothing observable.

## Gotchas

- **1 MB custom-app bundle limit**; the bundle is ~953 KB. `postcss.config.js` drops non-Latin font subsets. Don't add Macaw's DropdownMenu back (~90 KB).
- **`langsmith apps dev` token expiry.** It keeps the token it started with; after ~15 minutes calls return 401. Restart it.
- **No binary files in the app directory.** The dev server rejects them; screenshots live in `/docs`.
- **Errored runs.** LangSmith hands an errored run's evaluators `{"output": None}`, not `{}`. The harness detects an errored run by the missing `transcript`.
