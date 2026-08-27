"""Offline Google Open Location Code support for facility addresses."""

from __future__ import annotations

from typing import Any

from openlocationcode import openlocationcode as olc

MINIMUM_SIGNIFICANT_LENGTH = 8
SOURCE = "open-location-code"


def normalize_plus_code(value: Any) -> str:
    """Canonical upper-case spelling without presentation whitespace."""
    return "".join(str(value or "").upper().split())


def point_from_plus_code(value: Any, *, at: str | None = None) -> dict[str, Any] | None:
    """Decode a full code locally; refuse short codes that need a nearby reference."""
    code = normalize_plus_code(value)
    if not code or not olc.isValid(code) or not olc.isFull(code):
        return None
    area = olc.decode(code)
    if area.codeLength < MINIMUM_SIGNIFICANT_LENGTH:
        return None
    point: dict[str, Any] = {
        "latitude": area.latitudeCenter,
        "longitude": area.longitudeCenter,
        "precision": "plus_code",
        "source": SOURCE,
    }
    if at:
        point["resolved_at"] = at
    return point


def plus_code_problem(value: Any) -> str | None:
    code = normalize_plus_code(value)
    if not code:
        return None
    if not olc.isValid(code):
        return "Plus Code is not a valid Open Location Code."
    if not olc.isFull(code):
        return "Use a full Plus Code; a short code can only be resolved with a trusted nearby place."
    if olc.decode(code).codeLength < MINIMUM_SIGNIFICANT_LENGTH:
        return "Plus Code is too broad to place a facility; use at least eight location characters."
    return None
