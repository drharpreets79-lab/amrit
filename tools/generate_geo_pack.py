#!/usr/bin/env python3
"""Build a country's geo pack from a CSV of administrative units.

This is how a country onboards its own geography without touching application code. The
loader reads the level definitions out of the pack, so any depth from one to six works.

CSV columns (header required; order does not matter):
    level        1-6, outermost first
    code         unique within its level, ASCII preferred - scope filters match on it
    parent_code  the parent's code; empty for the top level
    name         display name
    name_local   optional, in the local script
    unit_type    optional, e.g. province, district, union_territory
    active       optional, 1 or 0 (default 1)
    sort_order   optional integer (default 0)

Level metadata comes from --level, repeated once per level:
    --level 1:governorate:Governorate:Governorates:ISO3166-2

Usage:
    python3 tools/generate_geo_pack.py --country NGA --name Nigeria \\
        --level 1:state:State:States:ISO3166-2 \\
        --level 2:lga:LGA:LGAs:GeoNames \\
        --source units.csv

    python3 tools/generate_geo_pack.py --country IN --check
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
GEO_PACK_ROOT = REPOSITORY_ROOT / "shared" / "geo-packs"
DATASET = "amrit-geo-pack"
MAX_LEVEL = 6


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_bytes(value: object) -> bytes:
    """Byte-identical to canonicalJson() in app/src/main/geo-pack.ts."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def parse_level(specification: str) -> dict:
    parts = specification.split(":")
    if len(parts) != 5:
        raise SystemExit(
            f"--level must be 'number:key:label:label_plural:code_system', got {specification!r}"
        )
    number, key, label, label_plural, code_system = parts
    if not number.isdigit() or not 1 <= int(number) <= MAX_LEVEL:
        raise SystemExit(f"--level number must be 1..{MAX_LEVEL}, got {number!r}")
    return {
        "level": int(number),
        "key": key,
        "label": label,
        "label_plural": label_plural,
        "code_system": code_system,
    }


def read_units(path: Path, declared_levels: set[int]) -> list[dict]:
    if not path.is_file():
        raise SystemExit(f"source not found: {path}")
    units: list[dict] = []
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        missing = {"level", "code", "name"} - set(reader.fieldnames or [])
        if missing:
            raise SystemExit(f"source is missing required column(s): {', '.join(sorted(missing))}")
        for line, row in enumerate(reader, start=2):
            level_text = str(row.get("level", "")).strip()
            if not level_text:
                continue
            if not level_text.isdigit():
                raise SystemExit(f"line {line}: level must be a number, got {level_text!r}")
            level = int(level_text)
            if level not in declared_levels:
                raise SystemExit(f"line {line}: level {level} has no matching --level definition")
            code = str(row.get("code", "")).strip()
            name = str(row.get("name", "")).strip()
            if not code:
                raise SystemExit(f"line {line}: code is required")
            if not name:
                raise SystemExit(f"line {line}: name is required")
            parent = str(row.get("parent_code", "") or "").strip()
            active_text = str(row.get("active", "") or "1").strip()
            sort_text = str(row.get("sort_order", "") or "0").strip()
            units.append(
                {
                    "level": level,
                    "code": code,
                    "parent_code": parent or None,
                    "name": name,
                    "name_local": (str(row.get("name_local", "") or "").strip() or None),
                    "unit_type": (str(row.get("unit_type", "") or "").strip() or None),
                    "active": 1 if active_text not in {"0", "false", "False"} else 0,
                    "sort_order": int(sort_text) if sort_text.lstrip("-").isdigit() else 0,
                }
            )
    return units


def validate(units: list[dict], levels: list[dict]) -> None:
    """The same rules the runtime loader enforces, applied before anything is written."""
    declared = {level["level"] for level in levels}
    top = min(declared)
    seen: set[tuple[int, str]] = set()
    codes_by_level: dict[int, set[str]] = {}
    for unit in units:
        key = (unit["level"], unit["code"])
        if key in seen:
            raise SystemExit(f"duplicate unit at level {unit['level']}: {unit['code']}")
        seen.add(key)
        codes_by_level.setdefault(unit["level"], set()).add(unit["code"])

    for unit in units:
        if unit["level"] == top:
            if unit["parent_code"]:
                raise SystemExit(f"top-level unit {unit['code']} must not declare a parent")
            continue
        if not unit["parent_code"]:
            raise SystemExit(f"unit {unit['code']} at level {unit['level']} has no parent")
        if unit["parent_code"] not in codes_by_level.get(unit["level"] - 1, set()):
            raise SystemExit(
                f"unit {unit['code']} references a parent not present at level {unit['level'] - 1}: "
                f"{unit['parent_code']}"
            )
    for level in sorted(declared):
        if not codes_by_level.get(level):
            print(f"warning: level {level} is declared but has no units", file=sys.stderr)


def build_pack(country_code: str, country_name: str, levels: list[dict], units: list[dict],
               version: str, licence: dict | None) -> dict:
    counts = {str(level["level"]): sum(1 for unit in units if unit["level"] == level["level"]) for level in levels}
    pack = {
        "schemaVersion": 1,
        "dataset": DATASET,
        "version": version,
        "countryCode": country_code,
        "countryName": country_name,
        "levels": sorted(levels, key=lambda level: level["level"]),
        # A pack asserts its own expected size, so the loader carries no per-country
        # knowledge and a truncated file is caught rather than silently accepted.
        "minimumCounts": {level: max(1, int(count * 0.9)) for level, count in counts.items() if count},
        "rowCounts": {"total": len(units), **counts},
        "sources": [],
        "licence": licence or {},
        "units": units,
    }
    pack["contentSha256"] = sha256_bytes(canonical_bytes(units))
    return pack


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--country", required=True, help="ISO 3166-1 alpha-3 (or alpha-2 for the output filename)")
    parser.add_argument("--name", help="country display name")
    parser.add_argument("--level", action="append", default=[], help="number:key:label:label_plural:code_system")
    parser.add_argument("--source", help="CSV of administrative units")
    parser.add_argument("--version", default="1.0", help="pack version (default 1.0)")
    parser.add_argument("--licence", help="licence name for the source data")
    parser.add_argument("--out", help="output path (default shared/geo-packs/<COUNTRY>.json)")
    parser.add_argument("--check", action="store_true", help="validate an existing pack without writing")
    args = parser.parse_args()

    country = args.country.strip().upper()
    output = Path(args.out) if args.out else GEO_PACK_ROOT / f"{country}.json"

    if args.check:
        if not output.is_file():
            print(f"missing: {output}", file=sys.stderr)
            return 1
        pack = json.loads(output.read_text(encoding="utf-8"))
        validate(pack["units"], pack["levels"])
        actual = sha256_bytes(canonical_bytes(pack["units"]))
        if actual != pack.get("contentSha256"):
            print(f"content hash mismatch: {actual} != {pack.get('contentSha256')}", file=sys.stderr)
            return 1
        print(f"{output.name}: {pack['rowCounts']['total']} units, hash {actual[:12]} ok")
        return 0

    if not args.source or not args.level:
        raise SystemExit("--source and at least one --level are required unless --check is given")

    levels = [parse_level(specification) for specification in args.level]
    units = read_units(Path(args.source), {level["level"] for level in levels})
    validate(units, levels)

    licence = {"name": args.licence} if args.licence else None
    pack = build_pack(country, args.name or country, levels, units, args.version, licence)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(canonical_bytes(pack) + b"\n")
    print(f"wrote {output} ({pack['rowCounts']['total']} units across {len(levels)} level(s))")
    print(f"  contentSha256 {pack['contentSha256']}")
    print("\nRe-vendor with: python3 tools/sync_shared.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
