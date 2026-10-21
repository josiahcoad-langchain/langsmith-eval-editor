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

import attach  # noqa: E402
import harness  # noqa: E402
import regrade  # noqa: E402
import run_queue  # noqa: E402
import seed  # noqa: E402
from suite import DEFAULT_PARALLEL_TESTS  # noqa: E402

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
    return {"host": web, "workspaceId": workspace_id, "dataset": harness.DATASET_NAME, "agentCommit": _git("rev-parse", "HEAD"),
            "sameAgentCommits": _same_agent_commits()}


# The agent's own code, as git pathspecs relative to the checkout the server runs from (space-separated). A commit
# that touches none of them (an eval, a doc) leaves the agent as it was, so results run on it stay current.
AGENT_PATHS = (os.environ.get("EVAL_AGENT_PATHS") or ".").split()
SAME_AGENT_LIMIT = 500


def _same_agent_commits() -> list[str]:
    """Every commit whose agent code is the same as HEAD's: HEAD back to the last commit that changed AGENT_PATHS.
    Experiments record the commit they ran on, so the UI calls a result out of date only when that commit isn't
    one of these. Empty when the server isn't in a git checkout, and the UI then can't say."""
    last_change = _git("log", "-1", "--format=%H", "--", *AGENT_PATHS)
    if not last_change:
        return []
    since = _git("rev-list", f"--max-count={SAME_AGENT_LIMIT}", f"{last_change}..HEAD").split()
    return [*since, last_change]


def _git(*args: str) -> str:
    try:
        return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


# --- Runs (standalone) --------------------------------------------------------------------------------

class RunRequest(BaseModel):
    example_ids: list[str]
    repetitions: int = 3


_runs: dict[str, dict] = {}

# How many tests run at once; the rest wait as "queued". DEFAULT_PARALLEL_TESTS (suite.py) says why it isn't "all".
MAX_PARALLEL_TESTS = int(os.environ.get("EVAL_PARALLEL") or DEFAULT_PARALLEL_TESTS)
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


class RegradeRequest(BaseModel):
    example_id: str
    name: str
    times: int = 3


@app.post("/api/regrade")
def regrade_assertion(body: RegradeRequest) -> dict:
    """Re-grade one assertion over the test's newest saved transcripts and say why it varied (regrade.py)."""
    try:
        return regrade.regrade(client, body.example_id, body.name, times=max(1, min(body.times, 5)))
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@app.get("/api/runs")
def list_runs() -> list[dict]:
    return sorted(_runs.values(), key=lambda job: job["requested_at"], reverse=True)


# --- Files in a test's Given (attach.py) ----------------------------------------------------------------
# The file is the raw request body and its type the Content-Type header, so no multipart parser is needed: the
# server often runs from the agent's own environment, which shouldn't need an extra package for this.

@app.post("/api/examples/{example_id}/files")
async def add_file(example_id: str, name: str, request: Request) -> list[dict]:
    mime_type = (request.headers.get("content-type") or "application/octet-stream").split(";")[0]
    try:
        return attach.attach_file(client, client.read_example(example_id), name, mime_type, await request.body())
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@app.delete("/api/examples/{example_id}/files/{name}")
def delete_file(example_id: str, name: str) -> list[dict]:
    return attach.remove_file(client, client.read_example(example_id), name)


@app.get("/api/examples/{example_id}/files/{name}")
def get_file(example_id: str, name: str) -> Response:
    """The file's bytes, for the editor's preview (reading the example downloads its files)."""
    stored = client.read_example(example_id).attachments or {}
    if name not in stored:
        raise HTTPException(404, f"no file named {name} on this test")
    reader = stored[name]["reader"]
    reader.seek(0)
    return Response(reader.read(), media_type=stored[name].get("mime_type") or "application/octet-stream")


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
