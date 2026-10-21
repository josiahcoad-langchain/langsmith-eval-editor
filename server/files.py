"""Files a test hands the agent (an image to lighten, a video to caption) and files the agent makes.

A test lists its files in `inputs.attachments`, as [{name, mime_type, sha256}], and carries their bytes as
LangSmith example attachments under the same names. The list sits in the inputs so that swapping a file
changes the test's content hash, which puts results from the old file out of date. The bytes are attachments,
not part of the inputs, because a video stored as JSON would bloat every read of the dataset.

The hook gets the files as `run_agent(..., attachments=[Attachment])`, each one a local path. A hook that makes
files returns `AgentRun(messages, files)` instead of a plain message list. Those files land in `outputs.files`,
where code checks such as `must_output_file`, or the hook's `custom_check`, can open them.
"""

from __future__ import annotations

import hashlib
import tempfile
from pathlib import Path
from typing import Any

from langchain_core.messages import BaseMessage
from pydantic import BaseModel


class Attachment(BaseModel):
    name: str
    mime_type: str
    path: Path


class AgentRun(BaseModel):
    """What a hook returns when the agent made files: its messages, plus those files."""

    model_config = {"arbitrary_types_allowed": True}
    messages: list[BaseMessage]
    files: list[Attachment] = []


class FileProblem(Exception):
    """The test lists a file the dataset doesn't hold as listed. The test needs fixing, not the agent."""


def materialize(manifest: list[dict], stored: dict[str, Any] | None) -> list[Attachment]:
    """Writes each listed file to a fresh folder and returns it. A fresh folder per run, so repetitions running
    side by side can't edit each other's copies."""
    if not manifest:
        return []
    folder = Path(tempfile.mkdtemp(prefix="eval-files-"))
    files = []
    for entry in manifest:
        name = entry["name"]
        info = (stored or {}).get(name)
        if info is None:
            raise FileProblem(f"The test lists {name}, but its dataset example has no attachment by that name. "
                              f"Re-upload it in the editor.")
        data = _read(info["reader"])
        if entry.get("sha256") and hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise FileProblem(f"{name} changed since the test listed it (its sha256 differs). Re-upload it in the editor.")
        path = folder / Path(name).name  # never let a name like ../x write outside the folder
        path.write_bytes(data)
        files.append(Attachment(name=name, mime_type=entry.get("mime_type") or info.get("mime_type") or "application/octet-stream",
                                path=path))
    return files


def _read(reader: Any) -> bytes:
    # LangSmith hands every repetition the SAME reader, so the second one would read nothing without the rewind.
    reader.seek(0)
    return reader.read()


def describe(files: list[Attachment]) -> list[dict]:
    """The agent's output files as JSON for `outputs.files`: enough for a check to find, open and compare them."""
    rows = []
    for file in files:
        data = file.path.read_bytes()
        rows.append({"name": file.name, "mime_type": file.mime_type, "path": str(file.path), "bytes": len(data),
                     "sha256": hashlib.sha256(data).hexdigest()})
    return rows
