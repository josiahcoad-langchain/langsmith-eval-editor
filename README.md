# Eval editor

A test editor for LangChain agents, backed by a LangSmith dataset. Each test is written as Given / When / Assert:

- **Given**: mocked tools. Every tool the agent may call in the test, with what it returns: one response, a response per argument value, or a failure (`{"raise": "503 ..."}`).
- **When**: the prompt sent to the agent.
- **Assert**: named one-sentence assertions ("It never says or implies that the refund was issued."). An LLM judge grades each one against the transcript and tool calls.

**Run test** runs the real agent against the mocks several times in parallel and logs one LangSmith experiment per run. The Results column shows each assertion's pass rate across repetitions and flags flaky assertions.

![The editor: a test's mocks and prompt on the left, its experiments on the right. The newest run errored because get_shipping_status has no mock.](docs/screenshot.png)

The UI runs either as a normal web app served by the eval server (**standalone**, the default) or inside LangSmith as a **custom app**. Both use the same `App.tsx`.

```
app/          the editor (React + Macaw). Two builds: web (dist-web/) and custom app (dist/bundle.js)
server/
  hook.py       how the harness runs YOUR agent: the one file to change for another agent
  demo_agent.py a small customer-support agent (orders, shipping, refunds) to demo on
  mocks.py      test mocks, applied as LangChain middleware; strict replay
  harness.py    runs tests via langsmith.evaluate: repetitions, judge, code checks
  seed.py       creates the dataset with four starter tests
  main.py       FastAPI: serves the web build, proxies the LangSmith API, runs tests, receives the webhook
  run_queue.py  custom-app mode: reads run requests from a Context Hub prompt repo
  register_webhook.py  custom-app mode: creates that repo and its commit webhook
```

## Run it (standalone)

Needs Python 3.11+ with [uv](https://docs.astral.sh/uv/) and Node 22.12+.

```bash
cd server
cp .env.example .env        # LANGSMITH_API_KEY and ANTHROPIC_API_KEY
uv sync
```

```bash
cd app && npm install && npm run build:web
```

```bash
cd server && uv run uvicorn main:app --port 8765
```

Open http://localhost:8765. On first start the server creates the `eval-editor-demo` dataset with four tests. Pick one and click **Run test**.

For UI work, `npm run dev:web` in `app/` serves the editor with hot reload on http://localhost:5173 and proxies `/api` to the server.

To populate **Import** (turn a real run into a test), run the agent a few times; its traces go to the `eval-editor-demo-agent` project:

```bash
cd server && uv run python demo_agent.py "Where is my order A1002?"
```

From the command line, `uv run python harness.py [test names] -r 3` runs tests without the UI, and `uv run pytest` tests the mock matching.

## How a test runs

1. `harness.target` builds a `MockTools` from the test's `inputs.mock_tools` and calls `hook.run_agent(prompt, mocks)`.
2. `hook.run_agent` runs the agent with `mocks.middleware()`, which answers every tool call from the mocks. Real tools never execute.
3. Replay is strict. A call to a tool the test doesn't mock, or with arguments no case matches, makes the run an **error** ("Test incomplete: no mock answered …"), not a grade: the test is what needs fixing, and anything the agent did after answering an error the test never wrote says nothing about the agent.
4. Dates in mock responses (strings starting `YYYY-MM-DD`) move forward by the days since `inputs.recorded_on`, so recorded data looks exactly as fresh on every run.
5. One judge call grades every assertion. Each assertion name becomes a feedback key with score 1 or 0 and a one-sentence reason.
6. `evaluate(..., num_repetitions=n, max_concurrency=n)` runs the repetitions in parallel as one experiment, prefixed with the test name. Mocks live inside each run, so tests also run side by side.

A test is one dataset example:

```json
{
  "inputs": {
    "prompt": "Order A1001 showed up broken. Please refund it.",
    "recorded_on": "2026-10-03",
    "mock_tools": {
      "get_order": {"id": "A1001", "status": "delivered", "total": 42.5},
      "get_shipping_status": {"cases": [{"when": {"tracking_number": "1Z9"}, "response": {"eta": "2026-10-06"}}]},
      "issue_refund": {"raise": "503 Service Unavailable"}
    }
  },
  "outputs": {"assertions": [{"name": "no-false-claim", "assertion": "It never says or implies that the refund was issued."}]},
  "metadata": {"name": "refund-service-down", "description": "The refund call fails.", "dataset_split": ["base"]}
}
```

## Use it with your agent

Edit `server/hook.py`:

```python
from my_agent import TOOLS, build_agent   # build_agent must accept middleware
from mocks import MockTools

TOOL_NAMES = [t.name for t in TOOLS]       # the "Add mock" dropdown, and which tool runs Import keeps

def run_agent(prompt: str, mocks: MockTools) -> list[BaseMessage]:
    agent = build_agent(middleware=[mocks.middleware()])
    return agent.invoke({"messages": [{"role": "user", "content": prompt}]})["messages"]
```

For an agent that isn't built on LangChain, call `mocks.call(name, args, tool_call_id)` wherever the agent executes a tool, and return the transcript as LangChain messages.

Then set the names in `server/.env` and `app/.env` (copy each `.env.example`): `EVAL_DATASET` / `VITE_DATASET_NAME` for the dataset, and `VITE_TRACE_PROJECT` for the project Import reads. The server writes the agent's tool names to the dataset's metadata (`agent_tools`) on start, which is where the editor reads them from in both modes. `AGENT_MODEL` and `JUDGE_MODEL` take any `init_chat_model` string.

## Turn it into a LangSmith custom app

Inside LangSmith the editor runs in a sandboxed iframe: it can call the LangSmith API (through `window.langsmith.call`, under the viewer's own session) and nothing else. Everything except **Run test** already works there, because the web build only reaches LangSmith through a shim with the same `window.langsmith` shape. Run test can't call your server, so it commits the request to a Context Hub prompt repo, and a prompt webhook on that repo wakes the server:

```
Run test ──commit──► prompt repo eval-editor-run-requests ──webhook──► server /hooks/eval-runs
                                                                         │ reads the repo, runs new requests
Results column ◄──── polls experiments on the dataset ◄────────────────── harness.run_tests
```

Each commit's template holds one request as `key: value` lines (`test`, `example_id`, `repetitions`, `requested_at`). The webhook body is a wake-up call only: the server reads the repo and records what it ran in `server/.run-queue-state.json`, so a missed or repeated delivery never loses or doubles a run. Requests already in the repo when the server first starts are marked done.

1. **Expose the webhook route.** The server holds a real API key behind `/api/langsmith`, so expose only `/hooks/eval-runs`, not the whole server. With ngrok and a static domain:

   ```bash
   ngrok http 8765 --url https://<your-domain>.ngrok-free.app
   ```

   Restrict the tunnel to that path with an ngrok traffic policy (deny any request whose path isn't `/hooks/eval-runs`). On a deployed server, route only that path publicly.

2. **Create the requests repo and register the webhook.** This creates `eval-editor-run-requests` (a private prompt repo) and a prompt webhook limited to it (trigger `commit`), sending an `X-Webhook-Secret` header. The secret is generated and written to `server/.env`; restart the server afterwards.

   ```bash
   cd server
   uv run python register_webhook.py --url https://<your-domain>.ngrok-free.app/hooks/eval-runs
   ```

   `--list` shows prompt webhooks and `--delete <id>` removes one. The same webhook can be set up in LangSmith's prompt webhook settings: URL, header `X-Webhook-Secret: <WEBHOOK_SECRET>`, trigger on commit, limited to the requests repo.

3. **Develop and push the app.** Install the [`langsmith` CLI](https://docs.langchain.com/langsmith/custom-apps), then:

   ```bash
   cd app
   langsmith apps dev                          # the app in a real local sandbox, rebuilt on save
   langsmith apps push --name "Agent tests"    # builds dist/bundle.js and publishes it to the workspace
   ```

   The first push writes `app/.langsmith/app.json` with the app's ID; commit it so later pushes update the same app. Pushing publishes to everyone in the workspace.

4. **Keep the server running.** Open the app in LangSmith, click **Run test**: the Results column shows "Requested" until the server picks it up, then each repetition as it's graded.

Custom-app constraints:

- The bundle must stay under 1 MB (`langsmith apps dev` refuses larger files). It is ~980 KB. `postcss.config.js` keeps only Latin font subsets; Macaw's DropdownMenu costs ~90 KB.
- The app gets `metadata.workspaceId` and `metadata.host` from LangSmith for links; it can't navigate itself, so links go through `window.langsmith.openUrl`.
- The dataset name, requests repo and trace project are baked in at build time (`app/.env`).
- `app/AGENTS.md` documents the custom-app API surface for coding agents, and `app/context.md` is the app's handoff notes.
