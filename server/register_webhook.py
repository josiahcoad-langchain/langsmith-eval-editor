"""Custom-app mode setup: creates the run-requests prompt repo and points a commit webhook at this server.

    uv run python register_webhook.py --url https://<your-tunnel>/hooks/eval-runs
    uv run python register_webhook.py --list
    uv run python register_webhook.py --delete <webhook_id>

The webhook sends an X-Webhook-Secret header; the secret is generated on first use and written to .env as
WEBHOOK_SECRET, so restart the server afterwards. The webhook is limited to the requests repo (include_prompts),
so commits to your other prompts don't wake the server.
"""

from __future__ import annotations

import argparse
import re
import secrets
import sys
from pathlib import Path

from dotenv import load_dotenv
from langsmith import Client

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")

from run_queue import REQUESTS_REPO  # noqa: E402

client = Client()


def _api(method: str, path: str, **kwargs):
    response = client.request_with_retries(method, path, **kwargs)
    return response.json() if response.content else None


def _secret() -> str:
    env = HERE / ".env"
    text = env.read_text() if env.exists() else ""
    if match := re.search(r"^WEBHOOK_SECRET=(.+)$", text, re.M):
        return match.group(1).strip()
    secret = secrets.token_urlsafe(24)
    env.write_text(text.rstrip("\n") + f"\nWEBHOOK_SECRET={secret}\n")
    print(f"wrote a new WEBHOOK_SECRET to {env} (restart the server to pick it up)")
    return secret


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", help="public HTTPS URL of this server's /hooks/eval-runs")
    ap.add_argument("--list", action="store_true", help="list prompt webhooks")
    ap.add_argument("--delete", metavar="ID", help="delete a prompt webhook")
    args = ap.parse_args()

    if args.list:
        for hook in _api("GET", "/prompt-webhooks") or []:
            print(hook["id"], hook["url"], hook.get("triggers"), hook.get("include_prompts"))
        return
    if args.delete:
        _api("DELETE", f"/prompt-webhooks/{args.delete}")
        print("deleted", args.delete)
        return
    if not args.url or not args.url.startswith("https://"):
        ap.error("pass --url https://.../hooks/eval-runs (or --list / --delete)")

    if not client._prompt_exists(REQUESTS_REPO):
        client.create_prompt(REQUESTS_REPO, description="Run requests from the eval editor custom app, one commit "
                             "per request. A commit webhook wakes the eval server.")
        print(f"created prompt repo {REQUESTS_REPO}")
    repo_id = str(client.get_prompt(REQUESTS_REPO).id)

    for hook in _api("GET", "/prompt-webhooks") or []:
        if hook["url"] == args.url:
            _api("DELETE", f"/prompt-webhooks/{hook['id']}")
            print("replaced the existing webhook for", args.url)
    hook = _api("POST", "/prompt-webhooks", json={
        "url": args.url, "headers": {"X-Webhook-Secret": _secret()},
        "include_prompts": [repo_id], "triggers": ["commit"]})
    print(f"webhook {hook['id']}: commits to {REQUESTS_REPO} -> {args.url}")


if __name__ == "__main__":
    sys.exit(main())
