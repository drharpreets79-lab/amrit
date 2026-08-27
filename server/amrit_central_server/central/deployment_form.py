"""Turn the sectioned deployment settings form into an override document.

The screen shows the *effective* profile — what this deployment actually behaves like — but
what gets stored is only what differs from the base. A field left alone therefore keeps
following the base profile and picks up its future corrections, instead of being frozen at
whatever it happened to say the day someone opened this page.

Kept apart from the view so the mapping can be tested without a request, and so the desktop
app's equivalent (``src/shared/deployment.ts``) has an obvious counterpart.
"""

from __future__ import annotations

from typing import Any

from django.core.exceptions import ValidationError

# Field name in the form -> how to read it. Anything not listed is not editable from the
# sectioned form; ``deployment_config.EDITABLE_FIELDS`` remains the authority on what may be
# stored at all, and validates whatever this produces.
TEXT_FIELDS = ("country_name", "locale", "text_direction", "numbering_system", "calendar",
               "date_input_order", "epi_week_system")
INT_FIELDS = ("first_day_of_week", "fiscal_year_start_month")
LIST_FIELDS = ("fallback_locales", "banned_identifier_keys", "reporting_frameworks")


def _list(value: str) -> list[str]:
    return [item.strip() for item in (value or "").replace("\n", ",").split(",") if item.strip()]


def _int(value: str, field: str) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        raise ValidationError(f"{field.replace('_', ' ')} must be a whole number.") from None


def _optional_int(value: str, field: str) -> int | None:
    return None if str(value or "").strip() == "" else _int(value, field)


def _float(value: str, field: str) -> float:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        raise ValidationError(f"{field.replace('_', ' ')} must be a number.") from None


def _admin_levels(data) -> list[dict[str, Any]]:
    """Read the repeated level rows, renumbering so the levels stay 1..N and contiguous."""
    keys = data.getlist("level_key")
    labels = data.getlist("level_label")
    plurals = data.getlist("level_label_plural")
    systems = data.getlist("level_code_system")
    required = set(data.getlist("level_required"))
    removed = set(data.getlist("level_removed"))

    levels: list[dict[str, Any]] = []
    for index, key in enumerate(keys):
        if str(index) in removed or not key.strip():
            continue
        levels.append({
            "level": len(levels) + 1,
            "key": key.strip(),
            "label": (labels[index] if index < len(labels) else "").strip() or key.strip(),
            "label_plural": (plurals[index] if index < len(plurals) else "").strip() or key.strip(),
            "code_system": (systems[index] if index < len(systems) else "").strip() or "ISO3166-2",
            "required": str(index) in required,
        })
    if not levels:
        raise ValidationError("A country needs at least one administrative level.")
    return levels


def overrides_from_form(data, base: dict, stored: dict | None = None) -> dict[str, Any]:
    """Build the override document for `base` from a submitted sectioned form.

    `stored` carries values the form cannot round-trip — today that is the uploaded logo,
    which arrives by its own route and would otherwise be dropped by the next save.
    """
    stored = stored or {}
    submitted: dict[str, Any] = {}

    for field in TEXT_FIELDS:
        if field in data:
            submitted[field] = data.get(field, "").strip()
    for field in INT_FIELDS:
        if field in data:
            submitted[field] = _int(data.get(field), field)
    for field in LIST_FIELDS:
        if field in data:
            submitted[field] = _list(data.get(field))
    if "timezone" in data:
        submitted["timezone"] = data.get("timezone", "").strip() or None
    if "level_key" in data:
        submitted["admin_levels"] = _admin_levels(data)

    if "base_uri" in data:
        submitted["identifier_namespace"] = {
            "base_uri": data.get("base_uri", "").strip(),
            "urn_prefix": data.get("urn_prefix", "").strip(),
        }

    if "product_name" in data:
        branding: dict[str, Any] = {
            "product_name": data.get("product_name", "").strip(),
            "authority_name": data.get("authority_name", "").strip(),
            "colors": {
                token: data.get(f"colour_{token}", "").strip().upper()
                for token in ("navy", "blue", "orange")
                if data.get(f"colour_{token}", "").strip()
            },
        }
        # The marks have their own upload route; a save of the rest must not erase them.
        # Both variants are carried, not only the light one: dropping `logo_reverse` here
        # would silently return the desktop sidebar to a white plate the next time an
        # administrator edited an unrelated colour.
        for field in ("logo", "logo_reverse"):
            existing = (stored.get("branding") or {}).get(field)
            if existing:
                branding[field] = existing
        submitted["branding"] = branding

    if "guideline_default" in data:
        available = _list(data.get("guideline_available")) or [data.get("guideline_default", "").strip()]
        submitted["guidelines"] = {
            "default": data.get("guideline_default", "").strip(),
            "available": available,
            "national_body": data.get("guideline_body", "").strip() or None,
        }

    code_systems = {
        name: dict(entry, enabled=f"code_system_{name}" in data)
        for name, entry in (base.get("code_systems") or {}).items()
    }
    if code_systems and "code_systems_present" in data:
        submitted["code_systems"] = code_systems

    if "k_anonymity_floor" in data:
        submitted["privacy"] = {
            "k_anonymity_floor": _int(data.get("k_anonymity_floor"), "k_anonymity_floor"),
            "retention_days": _optional_int(data.get("retention_days"), "retention_days"),
            "residency_note": data.get("residency_note", "").strip() or None,
        }

    if "map_zoom" in data:
        submitted["map"] = {
            "center": [_float(data.get("map_lat"), "map_lat"), _float(data.get("map_lng"), "map_lng")],
            "zoom": _int(data.get("map_zoom"), "map_zoom"),
            "tile_url": data.get("map_tile_url", "").strip() or None,
        }

    # Only what differs from the base is stored. Values already overridden and not present
    # on the form (a logo, or a field a future section has not reached yet) are carried over.
    overrides = {
        field: value for field, value in stored.items() if field not in submitted
    }
    for field, value in submitted.items():
        if value != base.get(field):
            overrides[field] = value
    return overrides
