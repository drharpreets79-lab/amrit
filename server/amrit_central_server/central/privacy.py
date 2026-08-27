"""Privacy settings that a deployment, not the code, decides.

Two values live here. The disclosure floor, which decides when an aggregate is too small to
publish, and the retention period, which decides when row-level operational data expires.
Both come from the country profile so an administrator can change them from the deployment
settings screen; the existing ``AMRIT_K_ANONYMITY_FLOOR`` environment variable still wins,
because an operator who set it in the environment did so deliberately and a profile edit
must not quietly loosen it.
"""

from __future__ import annotations

import os

from django.conf import settings

from . import country_profile as cp

DEFAULT_K_ANONYMITY_FLOOR = 5


def _privacy(country_code: str | None = None) -> dict:
    try:
        return dict(cp.get_profile(country_code).get("privacy") or {})
    except cp.ProfileError:
        # An unresolvable profile must not remove a disclosure control.
        return {}


def k_anonymity_floor(country_code: str | None = None) -> int:
    """The smallest cell size that may be published.

    Resolution order is environment, then profile, then the built-in floor. Never below the
    built-in floor: a profile edit can make disclosure control stricter, never weaker, so a
    mistake on the settings screen cannot publish a cell of one.
    """
    if os.environ.get("AMRIT_K_ANONYMITY_FLOOR"):
        configured = int(getattr(settings, "AMRIT_K_ANONYMITY_FLOOR", DEFAULT_K_ANONYMITY_FLOOR))
        return max(configured, DEFAULT_K_ANONYMITY_FLOOR)

    value = _privacy(country_code).get("k_anonymity_floor")
    try:
        return max(int(value), DEFAULT_K_ANONYMITY_FLOOR)
    except (TypeError, ValueError):
        return max(
            int(getattr(settings, "AMRIT_K_ANONYMITY_FLOOR", DEFAULT_K_ANONYMITY_FLOOR)),
            DEFAULT_K_ANONYMITY_FLOOR,
        )


def retention_days(country_code: str | None = None) -> int | None:
    """Days of row-level data to keep, or None for indefinitely.

    None is the default and the safe one: an unset or unreadable retention period must mean
    "keep", never "delete everything". The opposite default is unrecoverable.
    """
    value = _privacy(country_code).get("retention_days")
    if value is None:
        return None
    try:
        days = int(value)
    except (TypeError, ValueError):
        return None
    return days if days >= 1 else None


def residency_note(country_code: str | None = None) -> str | None:
    """Where this deployment states its data is held. Surfaced, never enforced by code."""
    note = _privacy(country_code).get("residency_note")
    return str(note) if note else None
