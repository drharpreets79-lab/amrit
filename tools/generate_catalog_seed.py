#!/usr/bin/env python3
"""Build the country-neutral AMR catalogue from checked-in Python resources.

Geography is NOT part of this asset. Administrative units ship as per-country geo packs
under shared/geo-packs (see tools/generate_geo_pack.py), so onboarding a country never
means regenerating and re-pinning another country's catalogue.

This is a development-time provenance tool only.  The packaged Electron app reads
the generated JSON and never imports Python or opens a legacy/user database.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path


# This script lives in tools/ and writes into the app/ product.
REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
APP_ROOT = REPOSITORY_ROOT / "app"
# The legacy Python desktop project is an external input, not part of either product.
# Override with AMRIT_DESKTOP_ROOT when it lives outside this checkout.
DESKTOP_ROOT = Path(os.environ.get("AMRIT_DESKTOP_ROOT") or (REPOSITORY_ROOT / "desktop_app"))
OUTPUT_PATH = APP_ROOT / "resources" / "catalog-seed.v2.json"
RUNTIME_MANIFEST_PATH = APP_ROOT / "src" / "main" / "catalog-seed.ts"
DATASET = "amrit-core-catalogue"
VERSION = "2026.2"

if not DESKTOP_ROOT.is_dir():
    raise SystemExit(
        f"generate_catalog_seed.py needs the legacy desktop_app project at {DESKTOP_ROOT}, "
        "which is not present in this checkout. Set AMRIT_DESKTOP_ROOT to its location, or "
        "regenerate the seed on a checkout that has it. This dependency is removed in Phase 3 "
        "of docs/globalization/PLAN.md."
    )

sys.path.insert(0, str(DESKTOP_ROOT))

from simple_ast_catalog import load_simple_ast_catalog  # noqa: E402
from whonet_data import LAB_DATA_FIELD_LIBRARY  # noqa: E402
from whonet_codes_loader import (  # noqa: E402
    CODE_FILES,
    get_code_resource_path,
    load_code_values,
    load_field_definitions,
    load_mic_panels,
)
from whonet_resource_loader import (  # noqa: E402
    get_resource_path,
    load_whonet_antibiotic_master_rows,
    load_whonet_expected_resistance_rows,
    load_whonet_expert_rule_rows,
    load_whonet_organism_master_rows,
    load_whonet_sample_config,
)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def normalized_alias(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").strip().lower()).strip()


def provenance_path(path: Path) -> str:
    """Record a stable, checkout-independent path for the provenance manifest.

    Inputs inside this repository are recorded relative to its root.  Inputs from an
    external desktop_app checkout (AMRIT_DESKTOP_ROOT) are recorded relative to that
    root and prefixed, so the manifest never leaks a machine-specific absolute path.
    """
    for root, prefix in ((REPOSITORY_ROOT, ""), (DESKTOP_ROOT, "desktop_app/")):
        try:
            return prefix + path.relative_to(root).as_posix()
        except ValueError:
            continue
    return path.name


def source_entry(path: Path, rows: int) -> dict[str, object]:
    payload = path.read_bytes()
    return {
        "path": provenance_path(path),
        "sha256": sha256_bytes(payload),
        "bytes": len(payload),
        "rows": rows,
    }


def build_asset() -> dict[str, object]:
    simple = load_simple_ast_catalog()
    sample_config = load_whonet_sample_config()

    # Start with the complete WHONET catalogues, then apply only the explicit
    # safety-reviewed overrides in Simple_AST_List_2026 before serialization.
    antibiotics = load_whonet_antibiotic_master_rows()
    for row in antibiotics:
        row.update(
            active=1,
            source_dataset="whonet_antibiotics",
            source_version=VERSION,
            user_modified=0,
        )

    organisms_by_code = {
        row["code"]: {
            **row,
            "active": 1,
            "is_custom": 0,
            "source_dataset": "whonet_organisms",
            "source_version": VERSION,
            "user_modified": 0,
        }
        for row in load_whonet_organism_master_rows()
    }
    for curated in simple["organisms"]:
        code = curated["code"]
        if curated.get("curated_override"):
            organisms_by_code[code] = {
                **organisms_by_code.get(code, {}),
                **curated,
                "organism_name": curated["name"],
                "source_dataset": "simple_ast_list_2026",
                "source_version": simple["version"],
                "user_modified": 0,
            }
    organisms = sorted(
        organisms_by_code.values(),
        key=lambda item: (int(item.get("sort_order") or 0), str(item["code"])),
    )

    samples = [
        {
            "code": row["code"],
            "name": row["name"],
            "parent_code": row.get("parent_code") or None,
            "system": row.get("system", ""),
            "concept_code": row.get("concept_code", ""),
            "active": 1,
            "is_custom": 0,
            "source_dataset": simple["dataset_key"],
            "source_version": simple["version"],
            "user_modified": 0,
            "sort_order": row["sort_order"],
        }
        for row in simple["samples"]
    ]
    sample_by_code = {row["code"]: row for row in simple["samples"]}
    aliases_by_key: dict[str, dict[str, object]] = {}
    for sample in simple["samples"]:
        for alias in [sample["name"], *sample.get("aliases", ())]:
            key = normalized_alias(alias)
            aliases_by_key.setdefault(
                key,
                {
                    "normalized_alias": key,
                    "alias_text": alias,
                    "sample_code": sample["code"],
                    "source_dataset": simple["dataset_key"],
                    "source_version": simple["version"],
                    "active": 1,
                    "user_modified": 0,
                },
            )
    # Assert every declared alias resolved to a real packaged sample.
    assert all(row["sample_code"] in sample_by_code for row in aliases_by_key.values())

    panels = []
    for source in simple["panels"]:
        panels.append(
            {
                "panel_name": source["name"],
                "description": source["description"],
                "source_row_key": source["source_row_key"],
                "source_dataset": source["source_dataset"],
                "source_version": source["source_version"],
                "source_context": source["source_context"],
                "source_text": source["source_text"],
                "no_routine_ast": 1 if source["no_routine_ast"] else 0,
                "guidance": source["guidance"],
                "group_metadata": source["group_metadata"],
                "priority": source["priority"],
                "active": 1,
                "user_modified": 0,
                "organisms": source["organisms"],
                "specimens": source["specimens"],
                "antibiotics": source["antibiotics"],
            }
        )

    enabled_rules = {
        str(code or "").strip().upper()
        for code in sample_config.get("EnabledExpertInterpretationRules", [])
    }
    expert_rules = [
        {
            **row,
            "enabled_by_default": 1 if row["rule_code"] in enabled_rules else 0,
            "active": 1,
            "is_custom": 0,
        }
        for row in load_whonet_expert_rule_rows()
    ]
    expected_resistance = [
        {**row, "active": 1, "is_custom": 0}
        for row in load_whonet_expected_resistance_rows()
    ]
    resource_config = [
        {
            "config_key": str(key),
            "config_value": (
                json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
                if isinstance(value, (dict, list, bool, int, float))
                else str(value)
            ),
        }
        for key, value in sorted(sample_config.items())
    ]
    lab_data_fields = [
        {
            "field_key": row["key"],
            "field_label": row["label"],
            "category": row["category"],
            "field_group": row["group"],
            "field_length": int(row.get("default_length", 20)),
            "is_enabled": 1 if row.get("enabled_by_default", True) else 0,
            "is_hidden": 0,
            "include_in_listing": 1 if row.get("include_in_listing", False) else 0,
            "applicable_domains": ",".join(row.get("domains", ())),
            "response_codes": "[]",
            "is_custom": 0,
            "sort_order": index,
        }
        for index, row in enumerate(LAB_DATA_FIELD_LIBRARY, start=1)
    ]

    catalogue = {
        "antibiotics": antibiotics,
        "codeValues": [
            {**row, "active": 1, "is_custom": 0}
            for row in load_code_values()
        ],
        "expectedResistance": expected_resistance,
        "expertRules": expert_rules,
        "fieldDefinitions": load_field_definitions(),
        "labDataFields": lab_data_fields,
        "micPanels": load_mic_panels(),
        "organisms": organisms,
        "panels": panels,
        "resourceConfig": resource_config,
        "sampleAliases": sorted(aliases_by_key.values(), key=lambda row: row["normalized_alias"]),
        "samples": samples,
    }

    source_rows = {
        "Antibiotics.txt": len(load_whonet_antibiotic_master_rows()),
        "Organisms.txt": len(load_whonet_organism_master_rows()),
        "Simple_AST_List_2026.csv": int(simple["source_row_count"]),
        "SampleConfig.json": len(sample_config),
        "ExpectedResistancePhenotypes.txt": len(expected_resistance),
        "ExpertInterpretationRules.txt": len(expert_rules),
    }
    source_paths = [
        get_resource_path("antibiotics"),
        get_resource_path("organisms"),
        DESKTOP_ROOT / "resources" / "Simple_AST_List_2026.csv",
        get_resource_path("sample_config"),
        get_resource_path("expected_resistance"),
        get_resource_path("expert_rules"),
    ]
    for code_set in sorted(CODE_FILES):
        path = get_code_resource_path(code_set)
        if path:
            source_paths.append(path)
            if code_set == "field_definitions":
                source_rows[path.name] = len(catalogue["fieldDefinitions"])
            elif code_set == "mic_panels":
                source_rows[path.name] = len(catalogue["micPanels"])
            else:
                source_rows[path.name] = sum(
                    1 for row in catalogue["codeValues"] if row["code_set"] == code_set
                )

    # No record, laboratory, hospital, credential, endpoint, or patient data is
    # accepted by this generator.  This key check guards accidental scope creep.
    prohibited_keys = {
        "patient_id", "first_name", "last_name", "dob", "address", "contact",
        "auth_token", "site_token", "api_key", "laboratory", "isolates", "hospitals",
    }

    def assert_pii_free(value: object) -> None:
        if isinstance(value, dict):
            overlap = prohibited_keys.intersection(value)
            if overlap:
                raise ValueError(f"PII/credential-bearing keys are forbidden in catalogue seed: {sorted(overlap)}")
            for nested in value.values():
                assert_pii_free(nested)
        elif isinstance(value, list):
            for nested in value:
                assert_pii_free(nested)

    assert_pii_free(catalogue)
    source_entries = [
        source_entry(path, source_rows.get(path.name, 0))
        for path in sorted({path.resolve() for path in source_paths})
    ]
    row_counts = {key: len(value) for key, value in catalogue.items()}
    return {
        "schemaVersion": 2,
        "dataset": DATASET,
        "version": VERSION,
        "contentSha256": sha256_bytes(canonical_bytes(catalogue)),
        "piiClassification": "Static terminology and configuration; no patient, laboratory, hospital, credential, or isolate records.",
        "rowCounts": row_counts,
        "sources": source_entries,
        "catalogue": catalogue,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="Fail if the checked-in asset is stale.")
    args = parser.parse_args()
    asset = build_asset()
    payload = canonical_bytes(asset) + b"\n"
    if args.check:
        if not OUTPUT_PATH.exists() or OUTPUT_PATH.read_bytes() != payload:
            print(f"stale catalogue seed: run {Path(__file__).name}", file=sys.stderr)
            return 1
        runtime_manifest = RUNTIME_MANIFEST_PATH.read_text(encoding="utf-8")
        if asset["contentSha256"] not in runtime_manifest or f"'{VERSION}'" not in runtime_manifest:
            print("runtime catalogue manifest does not match the generated asset", file=sys.stderr)
            return 1
        print(f"catalogue seed verified: {OUTPUT_PATH}")
        return 0
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_bytes(payload)
    print(f"wrote {OUTPUT_PATH} ({len(payload)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
