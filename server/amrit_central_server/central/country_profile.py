"""Country profile registry.

The profile is the single source of country-varying behaviour. Nothing in this module
changes behaviour on its own — callers adopt it phase by phase (see
docs/globalization/PLAN.md).

Resolution order, most specific first:

    1. A curated profile checked in at shared/country-profiles/<PROFILE_ID>.json
    2. A profile synthesized from shared/country-profiles/reference/countries.json,
       which covers every ISO 3166-1 country, so no country needs authoring
    3. shared/country-profiles/_default.json

A single-country deployment sets AMRIT_COUNTRY_PROFILE once. A multi-country
deployment calls get_profile(country_code) per country and stores per-country
overrides in the database (Phase 4 introduces geo.CountryConfig).
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

# The vendored copy of shared/ that ships with this product. Never reach outside
# the server folder — app/ and server/ are distributed separately.
SHARED_ROOT = Path(__file__).resolve().parent.parent / "shared"
PROFILE_ROOT = SHARED_ROOT / "country-profiles"
REFERENCE_PATH = PROFILE_ROOT / "reference" / "countries.json"
SCHEMA_PATH = PROFILE_ROOT / "profile.schema.json"
FALLBACK_PROFILE_ID = "DEFAULT"

# Synthesized defaults. Deliberately uniform: guessing a fiscal year or an epi-week
# system per country would encode half-knowledge as fact. Curated profiles and the
# administration GUI set the real values.
# Stated wherever SNOMED codes are surfaced. Member status belongs to the country, not to
# this software, so the notice names the obligation rather than asserting an answer.
SNOMED_LICENCE_NOTICE = (
    "Requires a SNOMED CT licence: free in a SNOMED International Member country, an affiliate licence elsewhere. This software grants no licence; establish your position before relying on these codes."
)

SYNTHESIZED_DEFAULTS = {
    "calendar": "gregory",
    "epi_week_system": "iso",
    "fiscal_year_start_month": 1,
    "k_anonymity_floor": 5,
    "map_zoom": 4,
    "guideline_default": "EUCAST",
    "guidelines_available": ["EUCAST", "CLSI"],
    "reporting_frameworks": ["GLASS"],
}


class ProfileError(RuntimeError):
    """Raised when a profile cannot be resolved or fails validation."""


# --------------------------------------------------------------------------- #
# Reference data                                                              #
# --------------------------------------------------------------------------- #
@lru_cache(maxsize=1)
def _reference() -> dict[str, dict[str, Any]]:
    """ISO 3166-1 entries keyed by alpha-3, with CLDR-derived locale defaults."""
    payload = json.loads(REFERENCE_PATH.read_text(encoding="utf-8"))
    return {entry["alpha3"]: entry for entry in payload["countries"]}


@lru_cache(maxsize=1)
def _alpha2_index() -> dict[str, str]:
    return {entry["alpha2"]: alpha3 for alpha3, entry in _reference().items()}


def available_countries(*, iso_only: bool = False) -> list[dict[str, Any]]:
    """Selectable countries, sorted by name.

    Excludes the organisation entries the underlying WHONET code set carries
    (WHO, FAO). Pass iso_only=True to also exclude user-assigned codes such as XKX.
    """
    entries = [e for e in _reference().values() if e.get("entry_type") == "country"]
    if iso_only:
        entries = [e for e in entries if e.get("iso3166_1")]
    return sorted(entries, key=lambda entry: entry["name"])


def resolve_country_code(value: str) -> str | None:
    """Accept an alpha-2 or alpha-3 code (any case) and return the alpha-3."""
    candidate = (value or "").strip().upper()
    if candidate in _reference():
        return candidate
    return _alpha2_index().get(candidate)


# --------------------------------------------------------------------------- #
# Validation                                                                  #
# --------------------------------------------------------------------------- #
@lru_cache(maxsize=1)
def _validator():
    from jsonschema import Draft202012Validator

    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    return Draft202012Validator(schema)


def validate_profile(profile: dict[str, Any]) -> None:
    """Raise ProfileError listing every problem, not merely the first."""
    errors = sorted(_validator().iter_errors(profile), key=lambda error: list(error.path))
    if not errors:
        return
    detail = "; ".join(
        f"{'/'.join(str(part) for part in error.path) or '<root>'}: {error.message}"
        for error in errors
    )
    raise ProfileError(
        f"country profile {profile.get('profile_id', '<unknown>')!r} is invalid: {detail}"
    )


# --------------------------------------------------------------------------- #
# Synthesis                                                                   #
# --------------------------------------------------------------------------- #
def synthesize_profile(country_code: str) -> dict[str, Any]:
    """Build a valid profile for any ISO 3166-1 country with nothing authored.

    Locale, script direction, numbering system, time zone and date order come from
    the checked-in CLDR-derived reference. The administrative hierarchy is a single
    ISO 3166-2 level with a generic label; Phase 3 refines the label from the
    subdivision category once the ISO 3166-2 pack ships, and a deployment can add
    deeper levels through the importer.
    """
    alpha3 = resolve_country_code(country_code)
    if alpha3 is None:
        raise ProfileError(f"unknown country code {country_code!r}")
    entry = _reference()[alpha3]
    if entry.get("entry_type") != "country":
        raise ProfileError(f"{alpha3} is an organisation, not a country")

    alpha2 = entry["alpha2"]
    profile = {
        "schema_version": 1,
        "profile_id": alpha3,
        "source": "synthesized",
        "country_code": alpha3,
        "country_code_2": alpha2,
        "country_name": entry["name"],
        "who_region": entry.get("who_region"),
        "locale": entry["locale"],
        "fallback_locales": ["en"],
        "text_direction": entry["text_direction"],
        "numbering_system": entry["numbering_system"],
        "timezone": entry["timezone"],
        "timezone_ambiguous": bool(entry["timezone_ambiguous"]),
        "calendar": SYNTHESIZED_DEFAULTS["calendar"],
        "date_input_order": entry["date_input_order"],
        "first_day_of_week": entry["first_day_of_week"],
        "epi_week_system": SYNTHESIZED_DEFAULTS["epi_week_system"],
        "fiscal_year_start_month": SYNTHESIZED_DEFAULTS["fiscal_year_start_month"],
        "admin_levels": _iso_admin_levels(alpha3),
        # .invalid is reserved (RFC 2606) and is the honest value for "not yet set".
        # It makes an unconfigured namespace obvious in exported FHIR instead of
        # silently borrowing another country's identifiers.
        "identifier_namespace": {
            "base_uri": "https://amrit.invalid",
            "urn_prefix": f"urn:amrit:{alpha2.lower()}",
        },
        "branding": {
            "product_name": "AMRIT",
            "authority_name": entry["name"],
            "logo": None,
            "colors": {},
        },
        "guidelines": {
            "default": SYNTHESIZED_DEFAULTS["guideline_default"],
            "available": list(SYNTHESIZED_DEFAULTS["guidelines_available"]),
            "national_body": None,
        },
        # SNOMED CT ships enabled; the licence position is recorded and surfaced to the
        # administrator rather than silently disabling a vocabulary they may be entitled to.
        "code_systems": {"snomed": {"enabled": True, "licence": SNOMED_LICENCE_NOTICE}},
        "banned_identifier_keys": [],
        "privacy": {
            "k_anonymity_floor": SYNTHESIZED_DEFAULTS["k_anonymity_floor"],
            "retention_days": None,
            "residency_note": None,
        },
        "map": {"center": None, "zoom": SYNTHESIZED_DEFAULTS["map_zoom"], "tile_url": None},
        "reporting_frameworks": list(SYNTHESIZED_DEFAULTS["reporting_frameworks"]),
    }
    return profile


# --------------------------------------------------------------------------- #
# Resolution                                                                  #
# --------------------------------------------------------------------------- #
GENERIC_ADMIN_LEVEL = {
    "level": 1,
    "key": "admin1",
    "label": "Administrative area",
    "label_plural": "Administrative areas",
    "code_system": "ISO3166-2",
    "required": False,
}


def _iso_admin_levels(alpha3: str) -> list[dict[str, Any]]:
    """Levels named after the subdivision type ISO records for this country.

    A country whose subdivisions ISO calls Governorates should read "Governorate", not a
    generic placeholder. Countries with no ISO subdivisions — several microstates — keep
    the generic level so the shape of a profile never varies.
    """
    try:
        from geo.loader import iso_fallback_pack

        pack = iso_fallback_pack(alpha3)
    except Exception:  # noqa: BLE001 - a profile must resolve even without the geo app
        pack = None
    if not pack:
        return [dict(GENERIC_ADMIN_LEVEL)]
    return [
        {
            "level": int(level["level"]),
            "key": str(level["key"]),
            "label": str(level["label"]),
            "label_plural": str(level["label_plural"]),
            "code_system": str(level.get("code_system", "ISO3166-2")),
            "required": False,
        }
        for level in pack["levels"]
    ]


def curated_profile_ids() -> list[str]:
    if not PROFILE_ROOT.is_dir():
        return []
    return sorted(
        path.stem
        for path in PROFILE_ROOT.glob("*.json")
        if path.stem != "profile.schema" and not path.stem.startswith("_")
    )


def _load_curated(profile_id: str) -> dict[str, Any] | None:
    path = PROFILE_ROOT / f"{profile_id}.json"
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _load_fallback() -> dict[str, Any]:
    path = PROFILE_ROOT / "_default.json"
    if not path.is_file():
        raise ProfileError(f"fallback profile missing at {path}")
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache(maxsize=32)
def get_profile(country_code: str | None = None) -> dict[str, Any]:
    """Resolve the active profile.

    country_code selects a country explicitly (multi-country deployments). When it is
    None the AMRIT_COUNTRY_PROFILE environment variable is used, then the fallback.
    """
    requested = country_code or os.environ.get("AMRIT_COUNTRY_PROFILE") or ""
    requested = requested.strip()

    if not requested:
        profile = _load_fallback()
        validate_profile(profile)
        return profile

    # A curated profile wins, matched on its id (e.g. "IN", "TESTLAND") or on the
    # alpha-3 of the country it describes.
    curated = _load_curated(requested.upper())
    if curated is None:
        alpha3 = resolve_country_code(requested)
        if alpha3 is not None:
            for profile_id in curated_profile_ids():
                candidate = _load_curated(profile_id)
                if candidate and candidate.get("country_code") == alpha3:
                    curated = candidate
                    break
    if curated is not None:
        validate_profile(curated)
        return curated

    alpha3 = resolve_country_code(requested)
    if alpha3 is None:
        raise ProfileError(
            f"no curated profile named {requested!r} and it is not an ISO 3166-1 country code"
        )
    profile = synthesize_profile(alpha3)
    validate_profile(profile)
    return profile


def admin_level(profile: dict[str, Any], level: int) -> dict[str, Any] | None:
    for definition in profile.get("admin_levels", []):
        if definition["level"] == level:
            return definition
    return None


def admin_level_labels(profile: dict[str, Any]) -> Iterable[str]:
    return (definition["label"] for definition in profile.get("admin_levels", []))


def clear_cache() -> None:
    """Drop cached profiles. Call after any profile or override changes."""
    get_profile.cache_clear()
    _reference.cache_clear()
    _alpha2_index.cache_clear()
    _validator.cache_clear()
