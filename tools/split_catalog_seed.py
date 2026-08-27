#!/usr/bin/env python3
"""Split the packaged catalogue into a country-neutral core and a per-country geo pack.

The v1 asset mixes two unrelated things: the internationally standard AMR catalogue
(WHONET organisms and antibiotics, breakpoints, panels, code values) and India's LGD
state/district geography. Only the second is country-specific, and while they share one
hash-pinned file no other country can be onboarded without regenerating India's seed.

This reads the existing v1 asset and writes:
  app/resources/catalog-seed.v2.json  - the core, with no geography
  shared/geo-packs/IN.json            - India's administrative units

Both are derived deterministically from the checked-in v1 asset; nothing is fetched, and
the core content is copied verbatim so the AMR catalogue is provably unchanged.

Usage:
    python3 tools/split_catalog_seed.py
    python3 tools/split_catalog_seed.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SOURCE_PATH = REPOSITORY_ROOT / "app" / "resources" / "catalog-seed.v1.json"
CORE_PATH = REPOSITORY_ROOT / "app" / "resources" / "catalog-seed.v2.json"
GEO_PACK_PATH = REPOSITORY_ROOT / "shared" / "geo-packs" / "IN.json"
RUNTIME_MANIFEST_PATH = REPOSITORY_ROOT / "app" / "src" / "main" / "catalog-seed.ts"

CORE_DATASET = "amrit-core-catalogue"
CORE_VERSION = "2026.2"
GEO_DATASET = "amrit-geo-pack"
GEO_VERSION = "2026.2"

# The geography collections that leave the core.
GEO_COLLECTIONS = ("states", "districts")
# Provenance rows that describe geography inputs rather than catalogue inputs.
GEO_SOURCE_MARKERS = ("india_lgd_districts",)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_bytes(value: object) -> bytes:
    """Byte-identical to canonicalJson() in app/src/main/catalog-seed.ts."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def load_source() -> dict:
    if not SOURCE_PATH.is_file():
        raise SystemExit(f"missing source asset: {SOURCE_PATH}")
    return json.loads(SOURCE_PATH.read_text(encoding="utf-8"))


def build_core(source: dict) -> dict:
    catalogue = {key: value for key, value in source["catalogue"].items() if key not in GEO_COLLECTIONS}
    row_counts = {key: len(value) for key, value in catalogue.items()}
    sources = [
        entry
        for entry in source.get("sources", [])
        if not any(marker in str(entry.get("path", "")) for marker in GEO_SOURCE_MARKERS)
    ]
    return {
        "schemaVersion": 2,
        "dataset": CORE_DATASET,
        "version": CORE_VERSION,
        "contentSha256": sha256_bytes(canonical_bytes(catalogue)),
        "piiClassification": source.get("piiClassification", "none"),
        "rowCounts": row_counts,
        "sources": sources,
        "derivedFrom": {
            "dataset": source.get("dataset"),
            "version": source.get("version"),
            "contentSha256": source.get("contentSha256"),
        },
        "catalogue": catalogue,
    }


def build_geo_pack(source: dict) -> dict:
    """Project India's LGD states and districts into the country-neutral unit shape."""
    states = source["catalogue"]["states"]
    districts = source["catalogue"]["districts"]

    units: list[dict] = []
    known_states: set[str] = set()
    for state in states:
        code = str(state.get("lgd_code", "")).strip()
        if not code:
            continue
        known_states.add(code)
        units.append(
            {
                "level": 1,
                "code": code,
                "parent_code": None,
                "name": str(state.get("state_name", code)),
                "name_local": None,
                # is_union_territory was an India-only column; unit_type generalises it.
                "unit_type": "union_territory" if int(state.get("is_union_territory", 0) or 0) == 1 else "state",
                "active": int(state.get("active", 1) or 0),
                "sort_order": int(state.get("sort_order", 0) or 0),
            }
        )

    orphans: list[str] = []
    for district in districts:
        code = str(district.get("lgd_code", "")).strip()
        parent = str(district.get("state_lgd_code", "")).strip()
        if not code:
            continue
        if parent not in known_states:
            orphans.append(code)
            continue
        units.append(
            {
                "level": 2,
                "code": code,
                "parent_code": parent,
                "name": str(district.get("district_name", code)),
                "name_local": None,
                "unit_type": "district",
                "active": int(district.get("active", 1) or 0),
                "sort_order": int(district.get("sort_order", 0) or 0),
            }
        )

    if orphans:
        print(f"warning: {len(orphans)} district(s) skipped with no matching state: {orphans[:5]}", file=sys.stderr)

    levels = [
        {"level": 1, "key": "state", "label": "State / UT", "label_plural": "States & UTs", "code_system": "LGD"},
        {"level": 2, "key": "district", "label": "District", "label_plural": "Districts", "code_system": "LGD"},
    ]
    minimum_counts = {"1": 30, "2": 700}

    pack = {
        "schemaVersion": 1,
        "dataset": GEO_DATASET,
        "version": GEO_VERSION,
        "countryCode": "IND",
        "countryName": "India",
        # Levels are declared inside the pack so the loader does not carry per-country
        # knowledge, and adding a country never means editing application code.
        "levels": levels,
        "minimumCounts": minimum_counts,
        "rowCounts": {"total": len(units), "1": sum(1 for u in units if u["level"] == 1), "2": sum(1 for u in units if u["level"] == 2)},
        "sources": [
            entry
            for entry in source.get("sources", [])
            if any(marker in str(entry.get("path", "")) for marker in GEO_SOURCE_MARKERS)
        ],
        "licence": {
            "name": "Local Government Directory (LGD)",
            "holder": "Ministry of Panchayati Raj, Government of India",
            "notes": "Administrative codes published for public administrative use.",
        },
        "units": units,
    }
    pack["contentSha256"] = sha256_bytes(canonical_bytes(units))
    return pack


def serialize(payload: dict) -> bytes:
    return canonical_bytes(payload) + b"\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify the outputs are current without writing")
    args = parser.parse_args()

    source = load_source()
    core = build_core(source)
    geo = build_geo_pack(source)

    # The AMR catalogue must survive the split untouched; a mismatch here means the core
    # was altered rather than merely separated.
    for collection, rows in core["catalogue"].items():
        if rows != source["catalogue"][collection]:
            raise SystemExit(f"core collection '{collection}' differs from the source asset")

    core_bytes = serialize(core)
    geo_bytes = serialize(geo)

    if args.check:
        problems = []
        for path, payload in ((CORE_PATH, core_bytes), (GEO_PACK_PATH, geo_bytes)):
            if not path.is_file():
                problems.append(f"missing: {path.relative_to(REPOSITORY_ROOT)}")
            elif path.read_bytes() != payload:
                problems.append(f"out of date: {path.relative_to(REPOSITORY_ROOT)}")
        manifest = RUNTIME_MANIFEST_PATH.read_text(encoding="utf-8")
        if core["contentSha256"] not in manifest:
            problems.append(f"{RUNTIME_MANIFEST_PATH.name} does not pin {core['contentSha256']}")
        if problems:
            for problem in problems:
                print(f"  - {problem}", file=sys.stderr)
            print("\nrun: python3 tools/split_catalog_seed.py", file=sys.stderr)
            return 1
        print(f"catalogue split current (core {core['contentSha256'][:12]}, geo {geo['contentSha256'][:12]})")
        return 0

    CORE_PATH.write_bytes(core_bytes)
    GEO_PACK_PATH.parent.mkdir(parents=True, exist_ok=True)
    GEO_PACK_PATH.write_bytes(geo_bytes)

    print(f"wrote {CORE_PATH.relative_to(REPOSITORY_ROOT)} ({len(core_bytes)} bytes)")
    print(f"  dataset {CORE_DATASET} {CORE_VERSION}  contentSha256 {core['contentSha256']}")
    print(f"wrote {GEO_PACK_PATH.relative_to(REPOSITORY_ROOT)} ({len(geo_bytes)} bytes)")
    print(f"  {geo['rowCounts']['total']} units  contentSha256 {geo['contentSha256']}")
    print("\nPin the core hash in app/src/main/catalog-seed.ts:")
    print(f"  PACKAGED_CATALOGUE_CONTENT_SHA256 = '{core['contentSha256']}'")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
