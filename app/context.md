# Eval editor: context

A Given / When / Assert test editor for an agent, over one LangSmith dataset (default `eval-editor-demo`). The same
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
  - `LastRun`: the header line.
  - `TracePreview`, `RunCompare`, `ToolCalls` (shared by the drill-down, compare and preview).
  - `ActionsMenu`: the "⋯" menus.
  - `fields`: `TextAreaField` with `maxRows` grows, then scrolls.

## Data shape

- `inputs`:
  - `prompt`
  - `history?` (`[{role, content}]`; an assistant turn may carry `tool_calls: [{id, name, args}]`, and a `tool` turn is one call's result, `{role: "tool", content, tool_call_id, name}`: LangChain message dicts)
  - `context?` (opaque JSON for the hook)
  - `recorded_on?`
  - `mock_tools`: `{tool: response | {"cases": [{when?, when_any_value?, response}]} | {"sequence": [...]} | {"raise": msg}}`
- `outputs`: `assertions` (`[{name, assertion}]`) and `checks?` (`[{name, type, ...params}]`).
- `metadata`: `name`, `description`, `dataset_split`, and for proposals `status: "proposal"` (accepted: `"active"`), `source_run_id` (its annotation-queue run), `source_trace_id`.
- Empty `history` / `context` / `checks` are left out.
- Assertion, check and test names are lowercase-with-dashes (typed `_`/spaces convert). Assertions and checks share one namespace (feedback keys).

## Decisions

- **Autosave.** Tests autosave ~800 ms after the last valid edit; only the saved baseline updates after a save, so typing during a save isn't lost. The dirty check is cached per draft (WeakMap), because recorded mocks can be large. Because a test autosaves when opened if its save would differ, writers must store tests exactly as `toPayload` does: no empty optional fields.
- **Inputs** are native controls styled with Macaw tokens (Macaw `Input` hit an invalid hook call in the sandbox).
- **Given is everything true before the prompt**: context, history, mocks. When is only the prompt.
- **Status dots.**
  - The status is the newest experiment's: pass = every key's min is 1, fail = some key's max is 0, flaky = anything else, error = every run raised.
  - Experiments are read newest first, stopping once every test has a status.
  - A test has no dot until its status is known: showing "never run" while loading would be false.
- **Out of date** = the test was modified after the run's `dataset_version`, or the run's `git.commit` differs from the server's `agentCommit` (web only). It fades dots and chips and strikes the last-run line through.
- **Cost estimate** = the newest experiment's `total_cost / run_count` × repetitions, the agent's model calls only. Tests with no priced run are counted, not guessed.
- **The results badge** counts assertions that passed on every repetition; rows that passed on some say "flaky".

- **Proposals live in the eval dataset**, flagged by `metadata.status`, not in a separate staging dataset, so a proposal's run history carries over when it's accepted. Accept PATCHes only `metadata`. The inbox is the annotation queue's runs minus those some example already names in `source_run_id`; the queue item is removed on Accept or Delete, not on import, so a half-shaped proposal stays queued. `promptAndHistory` (data.ts) reads a root run's messages in LangChain, OpenAI or serialized-`lc` shape.

- Written for a subject-matter expert, not an engineer (from an SME review, 2026-10-22):
  - A run that called an unmocked tool shows "This run hit a gap in the test, not a problem with the agent" in the
    drill-down (`mockGaps`, `AssertionDrilldown`), with "Add this mock", and hides "Judge right?" on those repetitions.
  - Proposals keep the original reply and the flagging feedback (`metadata.source_output`, `source_feedback`) and
    show them in `SourcePanel`. Accept is "as passing" or "as known bug" (`metadata.xfail` = reason; the CLI then
    expects a failure and reports XPASSED once it passes). Tests with `xfail` show a "Known bug" bar with a clear button.
  - Assertion and check names are generated (`slugify`, `autoCheckName`) until the expert types one, so a new
    assertion or check never blocks saving. Check types show plain-English labels (`CHECK_LABELS`).
  - Results say "2 of 3 checks" and chips say "2/3 runs"; mock rows preview values; turns are counted as user turns
    everywhere; runs from before content hashes say "can't tell whether this result is current".
  - A flagged card or an Import pick opens `TracePreview` in the middle column (message, reply, tool calls, flag);
    nothing is written until Make proposal. `fetchTrace` reads the trace once; `importTrace(trace)` builds the draft from it.
  - "Judge right? no" asks for a reason, saved as the `human-label` feedback's comment. When Re-grade says
    `assertion_ambiguous` or `judge_unreliable`, the drill-down asks `/api/rewrite-assertion` (server/drafting.py) for 1-2
    rewrites from those reasons and the judges'; Use this replaces the sentence and keeps the name.
  - Suggest assertions (proposals, web mode only: it needs the server's judge model) posts the prompt, `source_output`
    and `source_feedback` to `/api/suggest-assertions` and appends 2-4 rows, replacing an empty one.
  - Results: tick two repetitions (any experiments) and Compare opens `RunCompare`, side by side.
  - `assertionHints` (data.ts): quiet hints under an assertion for "and" joining two claims, vague words, or nothing observable.

## Gotchas

- **1 MB custom-app bundle limit**; the bundle is ~957 KB. `postcss.config.js` drops non-Latin font subsets. Don't add Macaw's DropdownMenu back (~90 KB).
- **`langsmith apps dev` token expiry.** It keeps the token it started with; after ~15 minutes calls return 401. Restart it.
- **No binary files in the app directory.** The dev server rejects them; screenshots live in `/docs`.
- **Errored runs.** LangSmith hands an errored run's evaluators `{"output": None}`, not `{}`. The harness detects an errored run by the missing `transcript`.
