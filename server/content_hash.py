"""A fingerprint of what a test asks: its inputs (Given + prompt) and outputs (assertions, checks), not metadata.

Each run records it (experiment metadata `test_hash`), and the editor computes the same one for the test as it is
now. A different fingerprint means the test changed since that run, so its results are out of date. Comparing
modification times instead flagged results out of date when only metadata moved (tags, markers, a description),
which changes nothing a run is graded on.

The editor computes it in the browser (app/src/lib/contentHash.ts), so both sides must produce the same bytes:
JSON with keys sorted at every level, no whitespace, non-ASCII kept as is, and floats that are whole numbers
written as integers (Python writes 1.0, JavaScript writes 1). tests/test_content_hash.py pins the two together.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any


def content_hash(inputs: dict[str, Any], outputs: dict[str, Any]) -> str:
    canonical = json.dumps(_normalize({"inputs": inputs, "outputs": outputs}), sort_keys=True,
                           separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _normalize(value: Any) -> Any:
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {key: _normalize(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_normalize(item) for item in value]
    return value
