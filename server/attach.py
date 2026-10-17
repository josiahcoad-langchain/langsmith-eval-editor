"""Add a file to a test's Given, or take one away (see files.py for how tests carry files).

    uv run python attach.py lighten-photo photo.jpg          adds (or replaces) photo.jpg on test "lighten-photo"
    uv run python attach.py lighten-photo --remove photo.jpg

The editor's Files section calls the same functions through the server. Each change writes the file's bytes
as an example attachment and its entry (name, mime_type, sha256) in inputs.attachments, in one update, so the
list and the bytes can't disagree.
"""

from __future__ import annotations

import argparse
import hashlib
import mimetypes
from pathlib import Path
from typing import Any

from langsmith import Client

# Big enough for a short phone video; anything larger makes every run download it.
MAX_BYTES = 50 * 1024 * 1024


def attach_file(client: Client, example: Any, name: str, mime_type: str, data: bytes) -> list[dict]:
    """Adds `name` to the example (replacing a file of the same name) and returns its new file list."""
    if len(data) > MAX_BYTES:
        raise ValueError(f"{name} is {len(data) / 1e6:.0f} MB; a test file can be at most {MAX_BYTES / 1e6:.0f} MB.")
    if "/" in name or "\\" in name or name.startswith("."):
        raise ValueError(f"{name!r} isn't a plain file name.")
    manifest = [f for f in _manifest(example) if f["name"] != name]
    manifest.append({"name": name, "mime_type": mime_type, "sha256": hashlib.sha256(data).hexdigest()})
    _write(client, example, manifest, new={name: (mime_type, data)})
    return manifest


def remove_file(client: Client, example: Any, name: str) -> list[dict]:
    manifest = [f for f in _manifest(example) if f["name"] != name]
    _write(client, example, manifest, new={})
    return manifest


def _manifest(example: Any) -> list[dict]:
    return list((example.inputs or {}).get("attachments") or [])


def _write(client: Client, example: Any, manifest: list[dict], new: dict[str, tuple[str, bytes]]) -> None:
    inputs = {**(example.inputs or {}), "attachments": manifest}
    if not manifest:
        inputs.pop("attachments")
    client.update_examples(dataset_id=example.dataset_id, updates=[{
        "id": example.id,
        "inputs": inputs,
        "outputs": example.outputs or {},
        "metadata": example.metadata or {},
        "attachments": new,
        # Keep the files still listed; anything not retained (a removed or replaced file) is deleted.
        "attachments_operations": {"retain": [f["name"] for f in manifest if f["name"] not in new], "rename": {}},
    }])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Add or remove a file on a test.")
    ap.add_argument("test", help="the test's name")
    ap.add_argument("file", nargs="?", help="a file to add (or replace)")
    ap.add_argument("--remove", metavar="NAME", help="remove the file with this name")
    args = ap.parse_args(argv)

    import harness

    client = Client()
    example = next((e for e in client.list_examples(dataset_name=harness.DATASET_NAME) if harness.test_name(e) == args.test), None)
    if example is None:
        ap.error(f"no test named {args.test} in {harness.DATASET_NAME}")
    if args.remove:
        manifest = remove_file(client, example, args.remove)
    elif args.file:
        path = Path(args.file)
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        manifest = attach_file(client, example, path.name, mime, path.read_bytes())
    else:
        ap.error("give a file to add, or --remove NAME")
    print(f"{args.test}: {', '.join(f['name'] for f in manifest) or 'no files'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
