"""Loading the terminology seed, once, from the vendored shared/ copy."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from central.country_profile import get_profile

from .service import SystemGate, profile_gate

SEED_PATH = Path(__file__).resolve().parents[1] / "shared" / "terminology" / "terminology-seed.v1.json"


@lru_cache(maxsize=1)
def terminology_seed() -> dict[str, Any]:
    if not SEED_PATH.exists():
        raise FileNotFoundError(
            f"Terminology seed missing at {SEED_PATH}. Run tools/generate_terminology_seed.py "
            "and tools/sync_shared.py."
        )
    seed = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    if seed.get("dataset") != "amrit-terminology":
        raise ValueError(f"{SEED_PATH} is not an AMRIT terminology asset.")
    return seed


def deployment_gate() -> SystemGate:
    """The active country profile's position on each vocabulary."""
    profile = get_profile()
    code_systems = profile.get("code_systems") if isinstance(profile, dict) else getattr(profile, "code_systems", None)
    return profile_gate(code_systems or {})
