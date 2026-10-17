"""The eval editor's server.

    uv run uvicorn main:app --port 8765      # then open http://localhost:8765

Standalone mode (the editor runs in your browser, served from here):
  /                       the built editor (app/dist-web)
  /api/langsmith/<path>   the LangSmith API, called with this server's LANGSMITH_API_KEY. The editor's code is
                          written against LangSmith's custom-app bridge (window.langsmith.call); in standalone
                          mode that bridge is a shim that forwards here, so one UI works in both modes.
  /api/runs               POST {example_ids, repetitions} runs tests (4 at a time, the rest queued); GET lists runs.
  /api/config             workspace URL, for links into LangSmith.

Custom-app mode (the editor runs inside LangSmith and can't reach this server):
  /hooks/eval-runs        the Context Hub prompt webhook on the run-requests repo; see run_queue.py.

The proxy holds a real API key, so the server listens on localhost only. Don't expose it; expose only
/hooks/eval-runs (the README's ngrok command does exactly that).
"""

from __future__ import annotations

import logging
import os
import subprocess
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from langsmith import Client
from pydantic import BaseModel

load_dotenv()

import harness  # noqa: E402
import run_queue  # noqa: E402
import seed  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
log = logging.getLogger("server")

LANGSMITH_API = os.environ.get("LANGSMITH_ENDPOINT", "https://api.smith.langchain.com").rstrip("/")
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")
WEB_DIST = Path(__file__).resolve().parents[1] / "app" / "dist-web"

app = FastAPI(title="Eval editor server")
client = Client()
_dataset_url = ""


@app.on_event("startup")
def startup() -> None:
    global _dataset_url
    _dataset_url = seed.ensure_dataset(client).url
    run_queue.init(client)


@app.get("/api/config")
def config() -> dict:
    # https://smith.langchain.com/o/<workspace>/datasets/<id> -> the workspace's base URL and ID
    web, _, rest = _dataset_url.partition("/o/")
    workspace_id = rest.split("/")[0]
    return {"host": web, "workspaceId": workspace_id, "dataset": harness.DATASET_NAME, "agentCommit": _agent_commit()}


def _agent_commit() -> str:
    """The commit the agent under test is on (the server runs from its checkout), so the UI can tell a result
    produced by older agent code from a current one. Experiments record the commit they ran on, the same way."""
    try:
        head = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""
    return head


# --- Runs (standalone) --------------------------------------------------------------------------------

class RunRequest(BaseModel):
    example_ids: list[str]
    repetitions: int = 3


_runs: dict[str, dict] = {}

# How many tests run at once. "Run all" sends every test in one request; starting them all together would put
# (tests x repetitions) agent runs on the model provider at the same moment. The rest wait as "queued". Same
# limit as harness.run_tests uses from the command line.
MAX_PARALLEL_TESTS = 4
_slots = threading.Semaphore(MAX_PARALLEL_TESTS)


def _run(run_id: str) -> None:
    job = _runs[run_id]
    with _slots:
        job["state"] = "running"
        try:
            harness.run_tests(example_ids=[job["example_id"]], repetitions=job["repetitions"])
            job["state"] = "done"
        except Exception as error:  # noqa: BLE001 - surface it in the UI instead of killing the server
            log.exception("run %s failed", run_id)
            job.update(state="error", error=str(error))


@app.post("/api/runs")
def start_runs(body: RunRequest) -> list[dict]:
    started = []
    for example_id in body.example_ids:
        run_id = uuid.uuid4().hex[:8]
        _runs[run_id] = {"id": run_id, "example_id": example_id, "repetitions": max(1, min(body.repetitions, 10)),
                         "requested_at": datetime.now(timezone.utc).isoformat(), "state": "queued"}
        threading.Thread(target=_run, args=(run_id,), daemon=True).start()
        started.append(_runs[run_id])
    return started


@app.get("/api/runs")
def list_runs() -> list[dict]:
    return sorted(_runs.values(), key=lambda job: job["requested_at"], reverse=True)


# --- Webhook (custom app) ------------------------------------------------------------------------------

@app.post("/hooks/eval-runs", status_code=202)
def eval_runs_webhook(background: BackgroundTasks, x_webhook_secret: str = Header(default="")) -> dict:
    if WEBHOOK_SECRET and x_webhook_secret != WEBHOOK_SECRET:
        raise HTTPException(401, "invalid or missing X-Webhook-Secret")
    # Webhook deliveries time out quickly, so answer now and run in the background.
    background.add_task(run_queue.process, client)
    return {"ok": True}


# --- LangSmith API proxy (standalone) -----------------------------------------------------------------

_http = httpx.AsyncClient(base_url=LANGSMITH_API, timeout=120)


@app.api_route("/api/langsmith/{path:path}", methods=["GET", "POST", "PATCH", "PUT", "DELETE"])
async def langsmith_proxy(path: str, request: Request) -> Response:
    headers = {"x-api-key": client.api_key or "", "content-type": "application/json"}
    if os.environ.get("LANGSMITH_WORKSPACE_ID"):
        headers["x-tenant-id"] = os.environ["LANGSMITH_WORKSPACE_ID"]
    upstream = await _http.request(request.method, f"/{path}", params=request.query_params,
                                   content=await request.body() or None, headers=headers)
    return Response(upstream.content, status_code=upstream.status_code,
                    media_type=upstream.headers.get("content-type", "application/json"))


# --- The editor ----------------------------------------------------------------------------------------

if WEB_DIST.exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @app.get("/{_:path}", include_in_schema=False)
    def index(_: str) -> FileResponse:
        return FileResponse(WEB_DIST / "index.html")
