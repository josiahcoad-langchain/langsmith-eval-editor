"""A test can hand the agent files (an image to lighten, a video to caption) and grade the files it makes."""

import hashlib
import io
from types import SimpleNamespace

import pytest

import harness
from checks import run_checks
from files import AgentRun, Attachment, FileProblem, materialize

PNG = b"\x89PNG\r\n\x1a\nfake"
MANIFEST = [{"name": "photo.png", "mime_type": "image/png", "sha256": hashlib.sha256(PNG).hexdigest()}]


def stored(data: bytes = PNG) -> dict:
    """What LangSmith hands a target: {name: {presigned_url, mime_type, reader}}."""
    return {"photo.png": {"presigned_url": "https://x", "mime_type": "image/png", "reader": io.BytesIO(data)}}


def test_each_run_gets_its_own_copy_of_the_files():
    # Given one stored attachment that two repetitions read
    attachments = stored()

    # When each repetition materializes it (the reader was already read once by the first)
    first = materialize(MANIFEST, attachments)
    second = materialize(MANIFEST, attachments)

    # Then both get the full bytes, in separate folders, so one run editing its copy can't touch another's
    assert first[0].path.read_bytes() == PNG == second[0].path.read_bytes()
    assert first[0].path != second[0].path
    assert first[0].mime_type == "image/png"


def test_a_listed_file_missing_from_the_example_is_a_broken_test():
    with pytest.raises(FileProblem, match="photo.png"):
        materialize(MANIFEST, {})


def test_bytes_that_dont_match_the_listed_hash_are_a_broken_test():
    with pytest.raises(FileProblem, match="changed"):
        materialize(MANIFEST, stored(b"other bytes"))


def test_the_agent_gets_the_files_and_its_output_files_are_graded(monkeypatch, tmp_path):
    # Given a hook that lightens the photo it was given and returns the result
    received = []

    def run_agent(prompt, mocks, attachments=None):
        received.extend(attachments)
        out = tmp_path / "photo-light.png"
        out.write_bytes(attachments[0].path.read_bytes() + b"light")
        return AgentRun(messages=[], files=[Attachment(name="photo-light.png", mime_type="image/png", path=out)])

    monkeypatch.setattr(harness, "hook", SimpleNamespace(run_agent=run_agent))

    # When the test runs
    outputs = harness.target({"prompt": "Lighten this up", "mock_tools": {}, "attachments": MANIFEST}, stored())

    # Then the agent saw the photo, and the file it made is in the outputs for checks to inspect
    assert [a.name for a in received] == ["photo.png"]
    assert outputs["files"][0]["name"] == "photo-light.png"
    assert outputs["files"][0]["bytes"] == len(PNG) + 5
    results = run_checks(outputs, [{"name": "made-an-image", "type": "must_output_file", "mime": "image/"}])
    assert results[0]["score"] == 1


def test_a_hook_that_cant_take_files_fails_a_test_that_has_them(monkeypatch):
    monkeypatch.setattr(harness, "hook", SimpleNamespace(run_agent=lambda prompt, mocks: []))
    with pytest.raises(harness.IncompleteTest, match="attachments"):
        harness.target({"prompt": "Lighten this up", "mock_tools": {}, "attachments": MANIFEST}, stored())


def test_no_output_file_fails_must_output_file():
    results = run_checks({"files": []}, [{"name": "made-a-video", "type": "must_output_file", "mime": "video/"}])
    assert results[0]["score"] == 0


def test_the_demo_hook_puts_files_in_the_users_message(tmp_path):
    # Given a text file and an image
    import hook
    (tmp_path / "note.txt").write_text("Order A1001")
    (tmp_path / "photo.png").write_bytes(b"\x89PNG")
    # Then the text is inlined and the image becomes an image block
    text = hook._block(Attachment(name="note.txt", mime_type="text/plain", path=tmp_path / "note.txt"))
    image = hook._block(Attachment(name="photo.png", mime_type="image/png", path=tmp_path / "photo.png"))
    assert text["type"] == "text" and "Order A1001" in text["text"]
    assert image == {"type": "image", "base64": "iVBORw==", "mime_type": "image/png"}
