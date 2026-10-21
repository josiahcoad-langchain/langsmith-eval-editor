"""The run's fingerprint (Python) and the editor's (TypeScript) must agree, or every result would look out of date."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from content_hash import content_hash

TS_HASH = Path(__file__).resolve().parents[2] / "app" / "src" / "lib" / "contentHash.ts"

CASES = [
    ({"prompt": "hi", "mock_tools": {}}, {"assertions": []}),
    # Whole-number floats: Python writes 1.0, JavaScript writes 1.
    ({"prompt": "refund", "mock_tools": {"get_order": {"total": 42.0, "tax": 3.5, "qty": 2}}}, {"assertions": [{"name": "a", "assertion": "x"}]}),
    # Non-ASCII, nested keys in different orders, booleans and null.
    ({"z": 1, "prompt": "Crea 5 post · 🌷", "context": {"b": True, "a": None}}, {"checks": [{"type": "must_call", "name": "c", "tools": [["x", "y"]]}]}),
]


def test_metadata_is_not_part_of_the_fingerprint_but_a_real_change_is():
    inputs, outputs = CASES[1]
    assert content_hash(inputs, outputs) == content_hash(json.loads(json.dumps(inputs)), outputs)
    changed = {**inputs, "prompt": "refund please"}
    assert content_hash(changed, outputs) != content_hash(inputs, outputs)


def test_key_order_does_not_matter():
    assert content_hash({"a": 1, "b": 2}, {}) == content_hash({"b": 2, "a": 1}, {})


@pytest.mark.skipif(shutil.which("node") is None, reason="needs Node to run the editor's TypeScript")
@pytest.mark.parametrize(("inputs", "outputs"), CASES)
def test_python_and_the_editor_agree(inputs, outputs):
    script = (
        f"import {{ contentHash }} from {json.dumps(str(TS_HASH))};"
        f"console.log(await contentHash({json.dumps(inputs)}, {json.dumps(outputs)}));"
    )
    result = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
                            capture_output=True, text=True, check=True)
    assert result.stdout.strip() == content_hash(inputs, outputs)
