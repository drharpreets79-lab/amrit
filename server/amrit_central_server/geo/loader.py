"""Load a geo pack into AdminUnit rows.

The pack format is shared with the desktop application (app/src/main/geo-pack.ts); this
module enforces the same rules, so a pack that one product accepts the other accepts too.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from django.db import transaction

from .models import AdminUnit

GEO_PACK_DATASET = "amrit-geo-pack"
SHARED_ROOT = Path(__file__).resolve().parent.parent / "shared"
GEO_PACK_ROOT = SHARED_ROOT / "geo-packs"
# Every ISO 3166-1 country's subdivisions, used when a country has no pack of its own.
ISO_FALLBACK_PACK = GEO_PACK_ROOT / "_iso3166-2.json"


class GeoPackError(ValueError):
    """Raised when a pack is malformed, truncated or tampered with."""


def canonical_bytes(value: object) -> bytes:
    """Byte-identical to canonicalJson() in app/src/main/geo-pack.ts."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def available_packs() -> list[str]:
    if not GEO_PACK_ROOT.is_dir():
        return []
    return sorted(path.stem for path in GEO_PACK_ROOT.glob("*.json") if not path.stem.startswith("_"))


def read_pack(source: str | Path) -> dict:
    """Read a pack by profile id ('IN'), by alpha-3, or from an explicit path.

    Falls back to the country's ISO 3166-2 subdivisions when it has no curated pack, so a
    deployment is never left with an empty administrative tree.
    """
    candidate = Path(source)
    if not candidate.is_file():
        candidate = GEO_PACK_ROOT / f"{str(source).upper()}.json"
    if candidate.is_file():
        return validate_pack(json.loads(candidate.read_text(encoding="utf-8")))
    fallback = iso_fallback_pack(str(source))
    if fallback is not None:
        return fallback
    raise GeoPackError(f"geo pack not found: {source}")


def iso_fallback_pack(country_code: str) -> dict | None:
    """Build a pack for one country from the bundled ISO 3166-2 set.

    The level label is the subdivision type ISO itself records — Province, Governorate,
    Region, Emirate — rather than a generic placeholder.
    """
    if not ISO_FALLBACK_PACK.is_file():
        return None
    payload = json.loads(ISO_FALLBACK_PACK.read_text(encoding="utf-8"))
    entry = (payload.get("countries") or {}).get(str(country_code).upper())
    if not entry:
        return None
    units = entry["units"]
    pack = {
        "schemaVersion": 1,
        "dataset": GEO_PACK_DATASET,
        "version": payload.get("version", "iso3166-2"),
        "countryCode": str(country_code).upper(),
        "countryName": str(country_code).upper(),
        "levels": entry["levels"],
        "minimumCounts": {},
        "rowCounts": {"total": len(units)},
        "licence": payload.get("licence", {}),
        "units": units,
    }
    pack["contentSha256"] = hashlib.sha256(canonical_bytes(units)).hexdigest()
    return validate_pack(pack)


def validate_pack(pack: dict) -> dict:
    if pack.get("schemaVersion") != 1:
        raise GeoPackError(f"unsupported geo pack schema: {pack.get('schemaVersion')}")
    if pack.get("dataset") != GEO_PACK_DATASET:
        raise GeoPackError(f"unexpected geo pack dataset: {pack.get('dataset')}")
    country = str(pack.get("countryCode", ""))
    if len(country) != 3 or not country.isalpha() or not country.isupper():
        raise GeoPackError(f"geo pack country code must be ISO 3166-1 alpha-3: {country!r}")

    levels = pack.get("levels") or []
    units = pack.get("units")
    if not levels:
        raise GeoPackError("geo pack declares no administrative levels")
    if not isinstance(units, list):
        raise GeoPackError("geo pack has no units")

    actual = hashlib.sha256(canonical_bytes(units)).hexdigest()
    if actual != pack.get("contentSha256"):
        raise GeoPackError(f"geo pack content hash mismatch for {country}")

    declared = {int(level["level"]) for level in levels}
    codes_by_level: dict[int, set[str]] = {}
    seen: set[tuple[int, str]] = set()
    for unit in units:
        level = int(unit["level"])
        code = str(unit.get("code", "")).strip()
        if level not in declared:
            raise GeoPackError(f"geo pack unit uses an undeclared level {level}")
        if not code:
            raise GeoPackError(f"geo pack unit at level {level} is missing a code")
        if not str(unit.get("name", "")).strip():
            raise GeoPackError(f"geo pack unit {code} is missing a name")
        key = (level, code)
        if key in seen:
            raise GeoPackError(f"geo pack has a duplicate unit at level {level}: {code}")
        seen.add(key)
        codes_by_level.setdefault(level, set()).add(code)

    top = min(declared)
    for unit in units:
        level = int(unit["level"])
        parent = str(unit.get("parent_code") or "")
        if level == top:
            if parent:
                raise GeoPackError(f"geo pack top-level unit {unit['code']} must not declare a parent")
            continue
        if not parent:
            raise GeoPackError(f"geo pack unit {unit['code']} at level {level} has no parent")
        if parent not in codes_by_level.get(level - 1, set()):
            raise GeoPackError(
                f"geo pack unit {unit['code']} references a parent that is not in the pack: {parent}"
            )

    for level, minimum in (pack.get("minimumCounts") or {}).items():
        actual_count = len(codes_by_level.get(int(level), set()))
        if actual_count < int(minimum):
            raise GeoPackError(f"geo pack level {level} is unexpectedly small: {actual_count} < {minimum}")
    return pack


@transaction.atomic
def load_pack(pack: dict) -> dict:
    """Insert or update the pack's units. Nothing is deleted."""
    country = str(pack["countryCode"])
    code_system = {int(level["level"]): str(level.get("code_system", "ISO3166-2")) for level in pack["levels"]}
    paths: dict[tuple[int, str], str] = {}
    created = updated = 0

    # Shallowest level first so a parent always exists before its children.
    for unit in sorted(pack["units"], key=lambda row: int(row["level"])):
        level = int(unit["level"])
        code = str(unit["code"])
        parent_code = str(unit.get("parent_code") or "")
        parent_path = paths.get((level - 1, parent_code)) if parent_code else None
        admin_path = f"{parent_path}/{code}" if parent_path else f"{country}/{code}"
        paths[(level, code)] = admin_path

        _, was_created = AdminUnit.objects.update_or_create(
            id=AdminUnit.make_id(country, level, code),
            defaults={
                "country_code": country,
                "level": level,
                "parent_id": AdminUnit.make_id(country, level - 1, parent_code) if parent_code else None,
                "code": code,
                "code_system": code_system.get(level, "ISO3166-2"),
                "name": str(unit["name"]),
                "name_local": str(unit.get("name_local") or ""),
                "unit_type": str(unit.get("unit_type") or ""),
                "admin_path": admin_path,
                "active": bool(int(unit.get("active", 1) or 0)),
                "sort_order": int(unit.get("sort_order", 0) or 0),
                "source_dataset": str(pack.get("dataset", "")),
                "source_version": str(pack.get("version", "")),
            },
        )
        created += int(was_created)
        updated += int(not was_created)

    return {"country_code": country, "created": created, "updated": updated, "total": len(pack["units"])}
