#!/usr/bin/env python3
"""Fail the build if a bundled dataset has no recorded licence.

An unlicensed dataset discovered after distribution is far more expensive to deal with
than one caught here, so adding reference data without recording its terms is a build
failure rather than a review note.

    python3 tools/check_data_licences.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
MANIFEST = REPOSITORY_ROOT / "shared" / "data-licences.json"
NARRATIVE = REPOSITORY_ROOT / "shared" / "DATA_LICENCES.md"

# Reference-data assets that ship with a product. A new one must appear in the manifest.
TRACKED_ASSETS = (
    "app/resources/catalog-seed.v2.json",
    "app/resources/genomic-markers.v1.json",
    "shared/country-profiles/reference/countries.json",
    "shared/address-formats/address-formats.v1.json",
    # Phase 22. Terminology arrives from outside this repository and carries someone else's
    # terms, so it is tracked the same way the catalogue and the geo packs are.
    "shared/terminology/terminology-seed.v1.json",
    "shared/terminology/loinc-abxbact.expansion.json",
    "shared/terminology/icd10-who.verified.json",
    "shared/terminology/snomed-catalogue.verified.json",
)
# Every geo pack is tracked; they are per-country and added over time.
GEO_PACK_GLOB = "shared/geo-packs/*.json"

REQUIRED_FIELDS = ("id", "name", "source", "licence", "bundled")


def main() -> int:
    problems: list[str] = []

    if not MANIFEST.is_file():
        print(f"missing licence manifest: {MANIFEST}", file=sys.stderr)
        return 1
    if not NARRATIVE.is_file():
        print(f"missing licence narrative: {NARRATIVE}", file=sys.stderr)
        return 1

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    datasets = manifest.get("datasets") or []
    if not datasets:
        problems.append("the licence manifest lists no datasets")

    seen_ids: set[str] = set()
    for entry in datasets:
        label = entry.get("id") or "<unnamed>"
        for field in REQUIRED_FIELDS:
            if field not in entry or entry[field] in ("", None):
                problems.append(f"{label}: missing {field}")
        if label in seen_ids:
            problems.append(f"{label}: duplicate id")
        seen_ids.add(label)
        # A licence that requires action must say so in words a reader can act on.
        if entry.get("warn") and "licence" not in str(entry.get("licence", "")).lower():
            problems.append(f"{label}: flagged as needing a warning but its licence text does not mention one")

    covered = {str(entry.get("asset")) for entry in datasets if entry.get("asset")}
    expected = list(TRACKED_ASSETS) + [
        path.relative_to(REPOSITORY_ROOT).as_posix()
        for path in sorted(REPOSITORY_ROOT.glob(GEO_PACK_GLOB))
        if not path.name.startswith("_")
    ]
    for asset in expected:
        if not (REPOSITORY_ROOT / asset).is_file():
            continue
        if asset not in covered:
            problems.append(f"{asset}: bundled but no licence entry names it")

    # A geo pack also carries its own licence block, so the pack is self-describing when
    # it travels on its own.
    for path in sorted(REPOSITORY_ROOT.glob(GEO_PACK_GLOB)):
        if path.name.startswith("_"):
            continue
        pack = json.loads(path.read_text(encoding="utf-8"))
        licence = pack.get("licence") or {}
        if not licence.get("name"):
            problems.append(f"{path.relative_to(REPOSITORY_ROOT)}: pack carries no licence.name")

    narrative = NARRATIVE.read_text(encoding="utf-8")
    for entry in datasets:
        if entry.get("bundled") and str(entry.get("name", "")) not in narrative:
            problems.append(f"{entry.get('id')}: bundled but not described in DATA_LICENCES.md")

    if problems:
        print(f"{len(problems)} licence problem(s):", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1

    bundled = sum(1 for entry in datasets if entry.get("bundled"))
    warned = sum(1 for entry in datasets if entry.get("warn"))
    print(f"licences recorded for {len(datasets)} dataset(s); {bundled} bundled, {warned} needing a licence notice")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
