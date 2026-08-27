#!/usr/bin/env python3
"""Build the ISO 3166-2 geo pack that covers every country.

Until this existed, a country with no curated pack started with an empty administrative
tree and had to import its own units before it could scope anything. This gives every
ISO 3166-1 country its first-level subdivisions out of the box.

Two things come out of the data beyond the units themselves:

* the subdivision **type** ISO records for each entry — Province, Governorate, Region,
  Emirate, Oblast — which is the real label Phase 0 had to leave as the generic
  "Administrative area";
* the parent relationships ISO defines, so a country whose second level is part of the
  standard gets two levels rather than one.

Source: the ISO 3166-2 tables bundled with pycountry (derived from Debian iso-codes).
pycountry is a build-time dependency only: the generated pack is checked in, so nothing
new ships at runtime. Licence terms are recorded in shared/data-licences.json.

    python3 tools/generate_iso3166_2_pack.py
    python3 tools/generate_iso3166_2_pack.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
REFERENCE_PATH = REPOSITORY_ROOT / "shared" / "country-profiles" / "reference" / "countries.json"
OUTPUT_PATH = REPOSITORY_ROOT / "shared" / "geo-packs" / "_iso3166-2.json"

DATASET = "amrit-geo-pack"
VERSION = "iso3166-2"


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_bytes(value: object) -> bytes:
    """Byte-identical to canonicalJson() in app/src/main/geo-pack.ts."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def alpha2_to_alpha3() -> dict[str, str]:
    payload = json.loads(REFERENCE_PATH.read_text(encoding="utf-8"))
    return {
        entry["alpha2"]: entry["alpha3"]
        for entry in payload["countries"]
        if entry.get("entry_type") == "country" and entry.get("alpha2")
    }


def plural(label: str) -> str:
    """A readable plural for a subdivision type, good enough for a UI label."""
    lowered = label.lower()
    if lowered.endswith(("s", "x", "ch", "sh")):
        return f"{label}es"
    if lowered.endswith("y") and not lowered.endswith(("ay", "ey", "iy", "oy", "uy")):
        return f"{label[:-1]}ies"
    return f"{label}s"


def build() -> dict:
    import pycountry

    mapping = alpha2_to_alpha3()
    countries: dict[str, dict] = {}

    for subdivision in pycountry.subdivisions:
        alpha3 = mapping.get(subdivision.country_code)
        if not alpha3:
            # A subdivision for something the reference does not treat as a selectable
            # country. Skipped rather than invented into existence.
            continue
        entry = countries.setdefault(alpha3, {"units": [], "types_by_level": {}})
        parent = subdivision.parent_code  # e.g. "IN-MH", or None for a top-level entry
        level = 1 if not parent else 2
        entry["units"].append({
            "level": level,
            "code": subdivision.code,
            "parent_code": parent,
            "name": subdivision.name,
            "name_local": None,
            "unit_type": (subdivision.type or "").strip() or None,
            "active": 1,
            "sort_order": 0,
        })
        # The most common type at a level becomes that level's label.
        entry["types_by_level"].setdefault(level, Counter())[(subdivision.type or "").strip()] += 1

    packs: dict[str, dict] = {}
    for alpha3, entry in sorted(countries.items()):
        units = entry["units"]
        present_levels = sorted({unit["level"] for unit in units})

        # A level-2 entry whose parent is absent would break the tree, so drop it and say
        # so rather than shipping a pack the loader will reject.
        level1_codes = {unit["code"] for unit in units if unit["level"] == 1}
        kept, orphaned = [], []
        for unit in units:
            if unit["level"] == 2 and unit["parent_code"] not in level1_codes:
                orphaned.append(unit["code"])
                continue
            kept.append(unit)
        if orphaned:
            print(f"  {alpha3}: dropped {len(orphaned)} subdivision(s) with no parent in the standard",
                  file=sys.stderr)
        units = kept
        present_levels = sorted({unit["level"] for unit in units})
        if not units:
            continue

        levels = []
        for level in present_levels:
            common = entry["types_by_level"].get(level, Counter()).most_common(1)
            label = (common[0][0] if common and common[0][0] else "Administrative area")
            levels.append({
                "level": level,
                "key": f"admin{level}",
                "label": label,
                "label_plural": plural(label),
                "code_system": "ISO3166-2",
            })

        packs[alpha3] = {
            "levels": levels,
            "units": sorted(units, key=lambda unit: (unit["level"], unit["code"])),
        }

    payload = {
        "schemaVersion": 1,
        "dataset": DATASET,
        "version": VERSION,
        "description": (
            "First- and second-level administrative subdivisions for every ISO 3166-1 "
            "country, from the ISO 3166-2 standard. Used when a country has no curated "
            "geo pack of its own."
        ),
        "source": "ISO 3166-2, via the tables bundled with pycountry (Debian iso-codes)",
        "licence": {
            "name": "ISO 3166-2",
            "holder": "ISO",
            "notes": (
                "Used under the deploying organisation's ISO licence. Subdivision codes and "
                "names are reproduced from the standard; see shared/DATA_LICENCES.md."
            ),
        },
        "countryCount": len(packs),
        "unitCount": sum(len(pack["units"]) for pack in packs.values()),
        "countries": packs,
    }
    payload["contentSha256"] = sha256_bytes(canonical_bytes(payload["countries"]))
    return payload


def serialize(payload: dict) -> bytes:
    return canonical_bytes(payload) + b"\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify the checked-in pack is current")
    args = parser.parse_args()

    try:
        payload = build()
    except ImportError:
        print("pycountry is required to regenerate this pack: pip install pycountry", file=sys.stderr)
        return 1

    encoded = serialize(payload)

    if args.check:
        if not OUTPUT_PATH.is_file():
            print(f"missing: {OUTPUT_PATH}\nrun: python3 tools/generate_iso3166_2_pack.py", file=sys.stderr)
            return 1
        if OUTPUT_PATH.read_bytes() != encoded:
            print(f"out of date: {OUTPUT_PATH}\nrun: python3 tools/generate_iso3166_2_pack.py", file=sys.stderr)
            return 1
        print(f"ISO 3166-2 pack current: {payload['countryCount']} countries, {payload['unitCount']} units")
        return 0

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_bytes(encoded)
    two_level = sum(1 for pack in payload["countries"].values() if len(pack["levels"]) > 1)
    print(f"wrote {OUTPUT_PATH.relative_to(REPOSITORY_ROOT)} ({len(encoded)} bytes)")
    print(f"  {payload['countryCount']} countries, {payload['unitCount']} units, {two_level} with two levels")
    print(f"  contentSha256 {payload['contentSha256']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
