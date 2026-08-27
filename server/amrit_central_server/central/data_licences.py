"""Bundled reference data and its licence terms.

Surfaced in the portal rather than left in a file, because two of these datasets place an
obligation on the deployment: SNOMED CT requires a licence outside a Member country, and
several require attribution when this software is redistributed. A term nobody can find
has not been communicated.

shared/DATA_LICENCES.md is the narrative version; shared/data-licences.json is this one.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

MANIFEST_PATH = Path(__file__).resolve().parent.parent / "shared" / "data-licences.json"


@lru_cache(maxsize=1)
def data_licences() -> list[dict]:
    if not MANIFEST_PATH.is_file():
        # Never fabricate terms: an empty list is honest, an invented one is not.
        return []
    payload = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    return list(payload.get("datasets") or [])


def licence_notices() -> list[dict]:
    """Datasets whose terms require the deployment to do something."""
    return [entry for entry in data_licences() if entry.get("warn")]


def clear_cache() -> None:
    data_licences.cache_clear()
