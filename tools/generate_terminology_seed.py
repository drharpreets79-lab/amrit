#!/usr/bin/env python3
"""Build the terminology seed both products read, from an authoritative source.

Phase 22. Follows `generate_catalog_seed.py`: a hash-pinned asset with provenance, a
`--check` mode that fails the build on drift, and no network access at run time — only
here, and only with `--refresh`.

## Where the codes come from, and why not from the catalogue

The WHONET catalogue carries two LOINC columns, `loinc_mlc` and `loinc_sbt`, populated for
121 of 399 antibiotics. They are **valid LOINC codes for the wrong methods**: MLC is
minimum *lethal* concentration and SBT is serum bactericidal titer, and AMRIT records
minimum *inhibitory* concentration and disk diffusion. Binding an MIC observation to the
MLC code would be a wrong code on every susceptibility result AMRIT has ever exported,
which is worse than the missing code it replaces.

So the codes are taken from the LOINC `ABXBACT` class as published by the HL7 public
terminology server (`tx.fhir.org`), matched to catalogue antibiotics **by name**, and the
method variant is read from the LOINC display rather than assumed from a column name. An
agent whose name does not match is left uncoded and listed in `unmatched` with the reason,
because an absent code is a gap and a wrong one is a defect.

## Usage

    python3 tools/generate_terminology_seed.py --refresh   # re-fetch the expansion (network)
    python3 tools/generate_terminology_seed.py             # rebuild the seed from the cache
    python3 tools/generate_terminology_seed.py --check     # verify the seed matches; CI gate
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
CATALOGUE = REPOSITORY_ROOT / "app" / "resources" / "catalog-seed.v2.json"
DIAGNOSIS = REPOSITORY_ROOT / "app" / "resources" / "diagnosis-codes.v1.json"
EXPANSION = REPOSITORY_ROOT / "shared" / "terminology" / "loinc-abxbact.expansion.json"
ICD10_CACHE = REPOSITORY_ROOT / "shared" / "terminology" / "icd10-starter.verified.json"
ICD11_CACHE = REPOSITORY_ROOT / "shared" / "terminology" / "icd11-mms.verified.json"
SNOMED_CACHE = REPOSITORY_ROOT / "shared" / "terminology" / "snomed-catalogue.verified.json"
ICD10_FULL_CACHE = REPOSITORY_ROOT / "shared" / "terminology" / "icd10-who.verified.json"
SEED = REPOSITORY_ROOT / "shared" / "terminology" / "terminology-seed.v1.json"

TERMINOLOGY_SERVER = "https://tx.fhir.org/r4"
LOINC = "http://loinc.org"
UCUM = "http://unitsofmeasure.org"
SNOMED = "http://snomed.info/sct"
WHONET_ANTIBIOTIC = "urn:whonet:antibiotic-code"
WHONET_ORGANISM = "urn:whonet:organism-code"
WHONET_SPECIMEN = "urn:whonet:specimen-code"
SEED_VERSION = "2026.1"

# The three method variants AMRIT can actually produce, and the LOINC display suffix that
# identifies each. `plain` is the method-less code, which is what an import with no recorded
# method gets: it says which drug was tested and declines to say how.
METHOD_SUFFIXES = {
    "": "plain",
    "by Minimum inhibitory concentration (MIC)": "mic",
    "by Disk diffusion (KB)": "disk",
    "by Gradient strip": "gradient",
}

# Name differences between the WHONET catalogue and LOINC that are the *same substance*
# spelled differently, not a judgement about which drug is meant. Each one is a fact about
# nomenclature ("clavulanic acid" is the acid of "clavulanate"), and each is applied only as
# an exact substitution — never as fuzzy matching.
SYNONYMS = {
    "clavulanic acid": "clavulanate",
    "clavulanic": "clavulanate",
    "sulbactam sodium": "sulbactam",
    "trimethoprim+sulfamethoxazole": "trimethoprim+sulfamethoxazole",
    "co trimoxazole": "trimethoprim+sulfamethoxazole",
    "penicillin g": "penicillin",
    "benzylpenicillin": "penicillin",
    "colistin sulphate": "colistin",
    "polymyxin b sulphate": "polymyxin b",
}

# Salt and formulation words that name how a drug was supplied rather than which drug it is.
# Stripped only when the stripped name matches LOINC exactly; the count is reported so the
# rule can be audited rather than trusted.
SALT_WORDS = {
    "sodium", "potassium", "zinc", "calcium", "hydrochloride", "sulphate", "sulfate",
    "mesylate", "tartrate", "phosphate", "succinate", "lactobionate", "besylate",
    "citrate", "acetate", "nitrate", "maleate", "trihydrate", "dihydrate", "monohydrate",
}


def normalise(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode()
    text = text.lower().replace("/", "+").replace("-", " ").replace("_", " ")
    text = re.sub(r"\(.*?\)", " ", text)
    text = re.sub(r"[^a-z0-9+]", " ", text)
    return " ".join(text.split())


# Ester prodrug moieties. `Cefpodoxime proxetil` is cefpodoxime esterified for oral
# absorption; the laboratory tests the active drug and LOINC codes the active drug. Stripped
# only when the stripped name matches LOINC exactly, and counted separately from salts so the
# two rules can be audited apart — a reviewer may accept one and reject the other.
ESTER_WORDS = {"proxetil", "pivoxil", "axetil", "hexetil", "alapivoxil", "medoxomil", "cilexetil"}


def strip_salts(name: str) -> str:
    words = [word for word in name.split() if word not in SALT_WORDS]
    return " ".join(words)


def strip_esters(name: str) -> str:
    words = [word for word in name.split() if word not in ESTER_WORDS]
    return " ".join(words)


def apply_synonyms(name: str) -> str:
    if name in SYNONYMS:
        return SYNONYMS[name]
    parts = [SYNONYMS.get(part.strip(), part.strip()) for part in name.split("+")]
    return "+".join(parts)


# Phase 22, revisited in Phase 26 once a licensed LOINC release was available locally.
#
# The columns that decide which code a susceptibility result gets. Reading them is strictly
# better than parsing the display string, which is what this tool did when its only source
# was a terminology server's expansion:
#
#   * METHOD_TYP says the method outright, so `mic` and `disk` stop depending on a regex over
#     "... [Susceptibility] by Minimum inhibitory concentration (MIC)".
#   * SYSTEM says which *breakpoint context* the code is for, and this is the one that matters.
#     LOINC has separate codes for `Isolate`, `Isolate.meningitis` and `Isolate.UTI`, because
#     CSF and urine breakpoints differ from the generic ones. Meropenem MIC is 6652-2 for an
#     isolate and 85426-5 for a meningitis isolate. Binding the meningitis code to a blood
#     culture would tell a receiver that CSF breakpoints were applied when they were not.
#     Display parsing could not see this distinction at all.
#   * STATUS excludes codes LOINC has retired.
#
# MLC and SBT are deliberately absent from the method map: minimum *lethal* concentration and
# serum bactericidal titer are not what AMRIT measures, which is the finding this whole module
# exists because of.
LOINC_METHODS = {"": "plain", "MIC": "mic", "Agar diffusion": "disk", "Gradient strip": "gradient"}
LOINC_SYSTEM_WANTED = "Isolate"
LOINC_PROPERTY_WANTED = "Susc"


def find_loinc_release() -> Path | None:
    """The licensed LOINC release, if this checkout has one.

    Not committed and never will be: the full table is redistribution-restricted and this
    repository is public, so `Loinc/` is gitignored and only the bound subset ships inside the
    seed. A checkout without it falls back to the cached terminology-server expansion, which
    is why the cache is still committed.
    """
    for candidate in sorted((REPOSITORY_ROOT / "Loinc").glob("Loinc_*.zip"), reverse=True):
        return candidate
    return None


def read_loinc_release(archive: Path) -> dict[str, Any]:
    """Read ABXBACT out of a LOINC release zip, without extracting it."""
    import csv
    import io
    import zipfile

    rows: list[dict[str, str]] = []
    total = 0
    with zipfile.ZipFile(archive) as bundle:
        name = next((entry for entry in bundle.namelist()
                     if entry.endswith("LoincTable/Loinc.csv")), "")
        if not name:
            raise SystemExit(f"{archive} does not contain LoincTable/Loinc.csv")
        with bundle.open(name) as handle:
            reader = csv.DictReader(io.TextIOWrapper(handle, encoding="utf-8-sig", newline=""))
            for row in reader:
                if row.get("CLASS") != "ABXBACT":
                    continue
                total += 1
                if row.get("STATUS") != "ACTIVE":
                    continue
                if row.get("SYSTEM") != LOINC_SYSTEM_WANTED:
                    continue
                if row.get("PROPERTY") != LOINC_PROPERTY_WANTED:
                    continue
                if row.get("METHOD_TYP", "") not in LOINC_METHODS:
                    continue
                rows.append({
                    "code": row["LOINC_NUM"],
                    "display": row.get("LONG_COMMON_NAME") or row.get("SHORTNAME", ""),
                    "component": row.get("COMPONENT", ""),
                    "method": row.get("METHOD_TYP", ""),
                    "system": row.get("SYSTEM", ""),
                    # LOINC's own synonym list. Used for matching, never invented here.
                    "relatedNames": row.get("RELATEDNAMES2", ""),
                })
    version = archive.stem.replace("Loinc_", "")
    return {
        "source": f"LOINC {version} release (local, licensed copy)",
        "expansion": "LOINC CLASS=ABXBACT, STATUS=ACTIVE, SYSTEM=Isolate, PROPERTY=Susc",
        "retrieved": date.today().isoformat(),
        "total": total,
        "rows": rows,
    }


def fetch_expansion() -> dict[str, Any]:
    """Page the LOINC ABXBACT class out of the public terminology server."""
    rows: list[dict[str, str]] = []
    offset = 0
    total: int | None = None
    body = json.dumps({
        "resourceType": "ValueSet",
        "compose": {"include": [{
            "system": LOINC,
            "filter": [{"property": "CLASS", "op": "=", "value": "ABXBACT"}],
        }]},
    }).encode()
    while True:
        request = urllib.request.Request(
            f"{TERMINOLOGY_SERVER}/ValueSet/$expand?offset={offset}&count=500",
            data=body,
            headers={"Content-Type": "application/fhir+json", "Accept": "application/fhir+json"},
        )
        with urllib.request.urlopen(request, timeout=180) as response:
            payload = json.loads(response.read())
        expansion = payload.get("expansion", {})
        total = expansion.get("total", total)
        contains = expansion.get("contains", [])
        if not contains:
            break
        rows.extend({"code": row["code"], "display": row.get("display", "")} for row in contains)
        offset += len(contains)
        print(f"  {offset}/{total}", flush=True)
        if total is not None and offset >= total:
            break
        time.sleep(0.4)
    return {
        "source": TERMINOLOGY_SERVER,
        "expansion": "LOINC CLASS=ABXBACT",
        "retrieved": date.today().isoformat(),
        "total": total,
        "rows": rows,
    }


ICD10 = "http://hl7.org/fhir/sid/icd-10"
# Phase 26. The canonical ICD-11 MMS system URI, and the one HL7 uses. Written by
# `tools/fetch_icd11.py` from WHO's own ICD API; this file only reads what that cached.
ICD11 = "http://id.who.int/icd/release/11/mms"


def verify_icd10(codes: list[dict[str, Any]]) -> dict[str, Any]:
    """Check each starter diagnosis code against the terminology server, and keep WHO's display.

    Phase 24. The starter set was authored by hand, which means a typo in it is a code that
    exists nowhere and a display that disagrees with WHO is a display AMRIT invented. Both are
    silent: nothing in the product would notice. `$validate-code` notices, once, here.

    A code the server rejects is **kept out of the seed and reported**, not silently corrected.
    """
    verified: list[dict[str, str]] = []
    rejected: list[dict[str, str]] = []
    for row in codes:
        code = str(row.get("code", "")).strip()
        if not code:
            continue
        url = (f"{TERMINOLOGY_SERVER}/CodeSystem/$lookup?system={ICD10}&code="
               f"{urllib.parse.quote(code)}")
        request = urllib.request.Request(url, headers={"Accept": "application/fhir+json"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = json.loads(response.read())
        except Exception as error:  # noqa: BLE001 - the reason is what gets recorded
            rejected.append({"code": code, "reason": f"lookup failed: {error}"})
            continue
        if payload.get("resourceType") != "Parameters":
            diagnostics = (payload.get("issue") or [{}])[0].get("diagnostics", "not found")
            rejected.append({"code": code, "reason": str(diagnostics)[:200]})
            continue
        display = next(
            (item.get("valueString", "") for item in payload.get("parameter", [])
             if item.get("name") == "display"),
            "",
        )
        verified.append({
            "code": code,
            "display": display,
            "localDescription": str(row.get("description", "")),
        })
        time.sleep(0.2)
    return {
        "source": TERMINOLOGY_SERVER,
        "system": ICD10,
        "retrieved": date.today().isoformat(),
        "verified": verified,
        "rejected": rejected,
    }


def loinc_index(expansion: dict[str, Any]) -> dict[str, dict[str, str]]:
    """Drug name -> {method: code}.

    Two sources, one shape. A local release carries `component` and `method` as columns and is
    read structurally; a terminology-server expansion carries only a display and is parsed.
    The structural path was checked against the parsed one before it was adopted: it
    reproduces all 264 existing bindings exactly, which is the evidence that switching source
    changed no code on any export.
    """
    index: dict[str, dict[str, str]] = {}
    for row in expansion["rows"]:
        if row.get("component"):
            method = LOINC_METHODS.get(row.get("method", ""))
            if method is None:
                continue
            index.setdefault(normalise(row["component"]), {})[method] = row["code"]
            continue
        match = re.match(r"^(.*?) \[Susceptibility\]\s*(.*)$", row["display"])
        if not match:
            continue
        method = METHOD_SUFFIXES.get(match.group(2).strip())
        if method is None:
            continue
        index.setdefault(normalise(match.group(1)), {})[method] = row["code"]
    return index


def loinc_synonyms(expansion: dict[str, Any]) -> dict[str, str]:
    """LOINC's own alternative name -> the component it belongs to.

    From `RELATEDNAMES2`, which is LOINC's synonym list for the term. This is the difference
    between "nalidixic acid" and LOINC's component "nalidixate", or "flucloxacillin" and
    "floxacillin" — nomenclature variants of the same substance that no salt- or ester-strip
    rule could reach, and that this repository must not invent a mapping for.

    A synonym pointing at **more than one** component is dropped rather than resolved. An
    ambiguous synonym would silently pick a drug, and picking the wrong drug puts a wrong
    susceptibility code on every result for that agent.
    """
    candidates: dict[str, set[str]] = {}
    for row in expansion["rows"]:
        component = normalise(row.get("component", ""))
        if not component:
            continue
        for name in str(row.get("relatedNames", "")).split(";"):
            key = normalise(name)
            if key and key != component:
                candidates.setdefault(key, set()).add(component)
    return {name: next(iter(components)) for name, components in candidates.items()
            if len(components) == 1}


def match_antibiotics(
    catalogue: list[dict[str, Any]], index: dict[str, dict[str, str]],
    synonyms: dict[str, str] | None = None,
) -> tuple[dict[str, dict[str, str]], list[dict[str, str]], dict[str, int]]:
    bindings: dict[str, dict[str, str]] = {}
    unmatched: list[dict[str, str]] = []
    counts = {"exact": 0, "synonym": 0, "salt-stripped": 0, "ester-stripped": 0,
              "reversed-combination": 0, "loinc-synonym": 0}
    loinc_names = synonyms or {}
    for row in catalogue:
        name = normalise(row.get("name"))
        candidates: list[tuple[str, str]] = [(name, "exact"), (apply_synonyms(name), "synonym")]
        stripped = strip_salts(name)
        if stripped and stripped != name:
            candidates.append((stripped, "salt-stripped"))
            candidates.append((apply_synonyms(stripped), "salt-stripped"))
        without_ester = strip_esters(name)
        if without_ester and without_ester != name:
            candidates.append((without_ester, "ester-stripped"))
            candidates.append((apply_synonyms(without_ester), "ester-stripped"))
        if "+" in name:
            candidates.append(("+".join(reversed(name.split("+"))), "reversed-combination"))
            candidates.append((apply_synonyms("+".join(reversed(name.split("+")))), "reversed-combination"))
        # Tried last, so an exact or rule-based match always wins over LOINC's synonym list.
        # These are LOINC's own alternative names for the term, not a judgement made here.
        for probe in (name, stripped, without_ester):
            component = loinc_names.get(probe or "")
            if component:
                candidates.append((component, "loinc-synonym"))
        found = next(((key, how) for key, how in candidates if key in index), None)
        if not found:
            unmatched.append({
                "code": str(row.get("code")),
                "name": str(row.get("name")),
                "reason": "No LOINC ABXBACT concept whose substance name matches. Left uncoded: a "
                          "wrong susceptibility code is a defect, a missing one is a gap.",
            })
            continue
        key, how = found
        counts[how] += 1
        bindings[str(row.get("code")).upper()] = {**index[key], "match": how, "loincName": key}
    return bindings, unmatched, counts


def _icd10_concepts(starter: dict[str, Any], full: dict[str, Any] | None) -> list[dict[str, str]]:
    """Every ICD-10 concept the seed carries, WHO's title winning over the local paraphrase."""
    concepts: dict[str, str] = {}
    for row in (full or {}).get("codes", []):
        concepts[str(row["code"])] = str(row.get("display", ""))
    for row in starter.get("verified", []):
        # WHO's display wins where both exist: the starter set's descriptions were this
        # repository's paraphrase, and five of them had drifted from the classification.
        concepts.setdefault(str(row["code"]), str(row.get("display") or row.get("localDescription", "")))
    return sorted(({"code": code, "display": display} for code, display in concepts.items()),
                  key=lambda row: row["code"])


def build_seed(
    expansion: dict[str, Any], catalogue: dict[str, Any], icd10: dict[str, Any],
    icd11: dict[str, Any], snomed: dict[str, Any] | None = None,
    icd10_full: dict[str, Any] | None = None,
) -> dict[str, Any]:
    index = loinc_index(expansion)
    bindings, unmatched, counts = match_antibiotics(
        catalogue["antibiotics"], index, loinc_synonyms(expansion))

    used_codes: set[str] = set()
    for binding in bindings.values():
        used_codes.update(value for key, value in binding.items() if key in METHOD_SUFFIXES.values())

    # Verified individually against tx.fhir.org rather than remembered; the display is stored
    # so a reviewer can check the code means what the binding claims.
    observation_codes = {
        "organism": {"code": "11475-1", "display": "Microorganism identified in Specimen by Culture"},
        "susceptibilityPanel": {"code": "18769-0", "display": "Microbial susceptibility tests Set"},
        "report": {"code": "18725-2", "display": "Microbiology studies (set)"},
    }
    used_codes.update(entry["code"] for entry in observation_codes.values())

    concepts = sorted(
        (
            {"code": row["code"], "display": row["display"]}
            for row in expansion["rows"] if row["code"] in used_codes
        ),
        key=lambda row: row["code"],
    )
    for entry in observation_codes.values():
        if entry["code"] not in {row["code"] for row in concepts}:
            concepts.append({"code": entry["code"], "display": entry["display"]})
    concepts.sort(key=lambda row: row["code"])

    # UCUM: the two units AMRIT measures in, and nothing else. A unit table nobody reads is a
    # licence obligation with no benefit.
    ucum = [
        {"code": "mg/L", "display": "milligram per litre"},
        {"code": "mm", "display": "millimetre"},
        {"code": "ug/mL", "display": "microgram per millilitre"},
    ]

    # ConceptMaps, built from data the catalogue already holds rather than authored here. The
    # antibiotic map is the matching above; the organism and specimen maps are the SNOMED codes
    # WHONET already carries, lifted into a form `$translate` can answer from. Nothing is
    # invented: a row with no SNOMED code produces no mapping, and `$translate` says so.
    organism_map = sorted(
        (
            {"source": str(row["code"]).upper(), "target": str(row["snomed_code"]).strip(),
             "display": str(row.get("organism_name") or "")}
            for row in catalogue["organisms"]
            if str(row.get("snomed_code") or "").strip() and str(row.get("code") or "").strip()
        ),
        key=lambda row: row["source"],
    )
    specimen_map = sorted(
        (
            {"source": str(row["code"]).upper(), "target": str(row["concept_code"]).strip(),
             "display": str(row.get("name") or "")}
            for row in catalogue["samples"]
            if str(row.get("concept_code") or "").strip() and str(row.get("system") or "") == SNOMED
        ),
        key=lambda row: row["source"],
    )

    seed = {
        "schemaVersion": 1,
        "dataset": "amrit-terminology",
        "version": SEED_VERSION,
        "generatedBy": "tools/generate_terminology_seed.py",
        "provenance": {
            "server": expansion["source"],
            "expansion": expansion["expansion"],
            "retrieved": expansion["retrieved"],
            "conceptsInClass": expansion["total"],
            "catalogueVersion": catalogue.get("version", ""),
        },
        "codeSystems": [
            {
                "url": LOINC,
                "name": "LOINC",
                "licenceId": "loinc",
                "concepts": len(concepts),
                "note": "A subset: only the codes AMRIT binds to. The full release is not bundled.",
            },
            {"url": UCUM, "name": "UCUM", "licenceId": "ucum", "concepts": len(ucum), "note": "Units AMRIT measures in."},
            {"url": WHONET_ANTIBIOTIC, "name": "WHONET antimicrobial codes", "licenceId": "whonet",
             "concepts": len(catalogue["antibiotics"]),
             "note": "AMRIT's own code space, emitted alongside LOINC on every susceptibility result."},
            {"url": WHONET_ORGANISM, "name": "WHONET organism codes", "licenceId": "whonet",
             "concepts": len(catalogue["organisms"]),
             "note": "AMRIT's own code space, emitted alongside SNOMED where licensed."},
            {"url": WHONET_SPECIMEN, "name": "WHONET specimen groups", "licenceId": "whonet",
             "concepts": len(catalogue["samples"]), "note": "AMRIT's own specimen groups."},
            *([{
                "url": SNOMED,
                "name": "SNOMED CT",
                "licenceId": "snomed",
                "concepts": len({row["snomed"] for row in (snomed or {}).get("verified", []) if row.get("display")}),
                "note": "Only the concepts the WHONET catalogue references, with the descriptions "
                        "the terminology server returned. Licensed content: free in a SNOMED "
                        "International Member country, an affiliate licence elsewhere. Gated by "
                        "code_systems.snomed.enabled, and omitted from output with a stated reason "
                        "rather than substituted when it is off.",
            }] if (snomed or {}).get("displaysIncluded") else []),
            {
                "url": ICD10,
                "name": "ICD-10",
                "licenceId": "icd10",
                "concepts": len(icd10.get("verified", [])),
                "note": "The starter value set only, verified against the terminology server. The "
                        "full WHO release is not bundled; see docs/standards/TERMINOLOGY.md for the "
                        "position and the reason.",
            },
            {
                "url": ICD11,
                "name": "ICD-11 for Mortality and Morbidity Statistics",
                "licenceId": "icd11",
                "concepts": len(icd11.get("verified", [])),
                "note": "A starter value set taken from WHO's own ICD API "
                        f"(release {icd11.get('release', 'unknown')}), every code checked to exist "
                        "*and* to carry the concept it was asked for. CC BY-ND 3.0 IGO: this is an "
                        "unmodified subset of WHO's codes and titles, not a derivative. No ICD-10 "
                        "to ICD-11 ConceptMap is generated — the API publishes no mapping between "
                        "the revisions and inventing one would attach a guess to a diagnosis.",
            },
        ],
        "concepts": {
            LOINC: concepts,
            UCUM: ucum,
            # AMRIT's own code spaces, with the catalogue's display for each code.
            #
            # These are here because the official FHIR validator found the exporter putting a
            # record's free text where a code system's display belongs: `display: "MEM"` for
            # an antibiotic whose display is "Meropenem", "Klebsiella pneumoniae" for a code
            # whose display is "Klebsiella pneumoniae complex", "Blood" for
            # "Blood / normally sterile fluid". A display that disagrees with its code system
            # is a defect a receiver is entitled to reject, and the exporter had no way to know
            # the right one until it was carried here.
            WHONET_ANTIBIOTIC: sorted(
                ({"code": str(row["code"]).upper(), "display": str(row.get("name", ""))}
                 for row in catalogue["antibiotics"] if str(row.get("code", "")).strip()),
                key=lambda row: row["code"]),
            WHONET_ORGANISM: sorted(
                ({"code": str(row["code"]).upper(), "display": str(row.get("organism_name", ""))}
                 for row in catalogue["organisms"] if str(row.get("code", "")).strip()),
                key=lambda row: row["code"]),
            WHONET_SPECIMEN: sorted(
                ({"code": str(row["code"]).upper(), "display": str(row.get("name", ""))}
                 for row in catalogue["samples"] if str(row.get("code", "")).strip()),
                key=lambda row: row["code"]),
            # Phase 24. The starter diagnosis value set, every code checked against the
            # terminology server and carrying WHO's own display rather than the one this
            # repository typed. Codes the server rejected are in `rejectedDiagnosisCodes`.
            # WHO's own categories for the chapters AMR surveillance codes into, where they have
            # been fetched, and the hand-verified starter set otherwise. The starter set stays the
            # *default value set* either way — the picker offers it first — but it stopped being
            # the only codes available the moment the classification itself was bundled.
            ICD10: _icd10_concepts(icd10, icd10_full),
            # SNOMED concepts the catalogue references, each checked to exist and carrying the
            # server's own fully specified name. Present only when `verify_snomed_codes.py` was
            # run with `--include-displays`: SNOMED descriptions are licensed content, free in a
            # Member country and requiring an affiliate licence elsewhere, and the runtime gate
            # (`code_systems.snomed.enabled`) decides whether a deployment may emit them at all.
            **({SNOMED: sorted(
                ({"code": row["snomed"], "display": row.get("display", "")}
                 for row in (snomed or {}).get("verified", []) if row.get("display")),
                key=lambda row: row["code"])} if (snomed or {}).get("displaysIncluded") else {}),
            # Phase 26. WHO's own titles, from WHO's own API. The display is never a string
            # this repository typed: `fetch_icd11.py` rejects a candidate whose WHO title does
            # not carry the concept asked for, so a code that reached here is one WHO confirmed
            # twice — that it exists, and that it means this.
            ICD11: [{"code": row["code"], "display": row["display"]}
                    for row in icd11.get("verified", [])],
        },
        "bindings": {
            "antibiotic": dict(sorted(bindings.items())),
            "observation": observation_codes,
            "units": {"MIC": "mg/L", "ETEST": "mg/L", "DISK": "mm"},
        },
        "conceptMaps": [
            {
                "id": "amrit-antibiotic-to-loinc",
                "sourceSystem": "urn:whonet:antibiotic-code",
                "targetSystem": LOINC,
                "note": "Built by matching catalogue substance names to the LOINC ABXBACT class. "
                        "The method variant is part of the target: an MIC and a disk result are "
                        "different LOINC codes for the same drug.",
                "elements": [
                    {"source": code, "targets": {key: value for key, value in binding.items()
                                                 if key in METHOD_SUFFIXES.values()}}
                    for code, binding in sorted(bindings.items())
                ],
            },
            {
                "id": "amrit-organism-to-snomed",
                "sourceSystem": "urn:whonet:organism-code",
                "targetSystem": SNOMED,
                "note": "The SNOMED codes the WHONET catalogue already carries. Gated by the "
                        "deployment's SNOMED licence position, like every other SNOMED use here.",
                "elements": [{"source": row["source"], "targets": {"equivalent": row["target"]}}
                             for row in organism_map],
            },
            {
                "id": "amrit-specimen-to-snomed",
                "sourceSystem": "urn:whonet:specimen-code",
                "targetSystem": SNOMED,
                "note": "Only the specimen groups the catalogue codes. Five of eight carry no "
                        "concept and are left unmapped rather than approximated.",
                "elements": [{"source": row["source"], "targets": {"equivalent": row["target"]}}
                             for row in specimen_map],
            },
        ],
        "valueSets": [
            {
                "id": "amrit-diagnosis-starter",
                "system": ICD10,
                "note": "What the diagnosis picker offers first. It is the default value set, not "
                        "the only codes a deployment may use.",
                "codes": [row["code"] for row in icd10.get("verified", [])],
            },
            {
                "id": "amrit-diagnosis-starter-icd11",
                "system": ICD11,
                "note": "The same clinical scope expressed in ICD-11 MMS, for a deployment whose "
                        "records are on ICD-11. It is a parallel value set, not a translation: a "
                        "record states which system its code came from and the two are never "
                        "silently interchanged.",
                "codes": [row["code"] for row in icd11.get("verified", [])],
            },
        ],
        "rejectedDiagnosisCodes": icd10.get("rejected", []),
        "rejectedIcd11Codes": icd11.get("rejected", []),
        # Catalogue SNOMED references the server could not resolve. The same check found `U88`
        # in the ICD-10 starter set, which ships and does not exist.
        "rejectedSnomedCodes": (snomed or {}).get("rejected", []),
        "matchCounts": counts,
        "unmatched": sorted(unmatched, key=lambda row: row["code"]),
    }
    payload = json.dumps(seed, indent=1, sort_keys=True, ensure_ascii=False)
    seed["contentSha256"] = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return seed


def write(seed: dict[str, Any]) -> None:
    SEED.parent.mkdir(parents=True, exist_ok=True)
    SEED.write_text(json.dumps(seed, indent=1, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--refresh", action="store_true", help="re-fetch the LOINC expansion (network)")
    parser.add_argument("--check", action="store_true", help="fail if the committed seed differs")
    arguments = parser.parse_args()

    release = find_loinc_release()
    if arguments.refresh or (release and not EXPANSION.exists()):
        # A licensed local release beats the terminology server: it carries METHOD_TYP and
        # SYSTEM as columns, so the breakpoint context (Isolate vs Isolate.meningitis vs
        # Isolate.UTI) is read rather than invisible, and it needs no network.
        expansion = read_loinc_release(release) if release else fetch_expansion()
        EXPANSION.parent.mkdir(parents=True, exist_ok=True)
        EXPANSION.write_text(json.dumps(expansion, indent=1) + "\n", encoding="utf-8")
        print(f"cached {len(expansion['rows'])} concepts from {expansion['source']} "
              f"-> {EXPANSION.relative_to(REPOSITORY_ROOT)}")
    if arguments.refresh:
        diagnosis = json.loads(DIAGNOSIS.read_text(encoding="utf-8"))
        icd10 = verify_icd10(list(diagnosis.get("codes") or []))
        ICD10_CACHE.write_text(json.dumps(icd10, indent=1) + "\n", encoding="utf-8")
        print(f"verified {len(icd10['verified'])} ICD-10 codes, {len(icd10['rejected'])} rejected "
              f"-> {ICD10_CACHE.relative_to(REPOSITORY_ROOT)}")
    if not EXPANSION.exists():
        print(f"missing {EXPANSION.relative_to(REPOSITORY_ROOT)}; run with --refresh once", file=sys.stderr)
        return 1

    expansion = json.loads(EXPANSION.read_text(encoding="utf-8"))
    catalogue = json.loads(CATALOGUE.read_text(encoding="utf-8"))["catalogue"]
    catalogue["version"] = json.loads(CATALOGUE.read_text(encoding="utf-8")).get("version", "")
    icd10 = json.loads(ICD10_CACHE.read_text(encoding="utf-8")) if ICD10_CACHE.exists() else {"verified": [], "rejected": []}
    # ICD-11 needs WHO API credentials, so a checkout without the cache builds a seed without
    # ICD-11 rather than failing. The seed's own `codeSystems` entry then reports zero
    # concepts, which is a visible absence rather than a silent one, and `tools/fetch_icd11.py`
    # says exactly what to run.
    icd11 = json.loads(ICD11_CACHE.read_text(encoding="utf-8")) if ICD11_CACHE.exists() else {"verified": [], "rejected": []}
    snomed = json.loads(SNOMED_CACHE.read_text(encoding="utf-8")) if SNOMED_CACHE.exists() else None
    icd10_full = json.loads(ICD10_FULL_CACHE.read_text(encoding="utf-8")) if ICD10_FULL_CACHE.exists() else None
    seed = build_seed(expansion, catalogue, icd10, icd11, snomed, icd10_full)

    if arguments.check:
        if not SEED.exists():
            print("terminology seed is missing; run tools/generate_terminology_seed.py", file=sys.stderr)
            return 1
        current = json.loads(SEED.read_text(encoding="utf-8"))
        if current.get("contentSha256") != seed["contentSha256"]:
            print(
                "terminology seed is stale: regenerating from the cached expansion and the catalogue "
                f"produces {seed['contentSha256'][:12]}, the committed seed carries "
                f"{str(current.get('contentSha256'))[:12]}. Run tools/generate_terminology_seed.py.",
                file=sys.stderr,
            )
            return 1
        print(
            f"terminology seed in sync: {len(seed['bindings']['antibiotic'])} antibiotics bound, "
            f"{len(seed['unmatched'])} uncoded, {len(seed['concepts'][LOINC])} LOINC concepts, "
            f"{len(seed['concepts'][ICD10])} ICD-10, {len(seed['concepts'][ICD11])} ICD-11"
        )
        return 0

    write(seed)
    counts = seed["matchCounts"]
    print(
        f"wrote {SEED.relative_to(REPOSITORY_ROOT)}: "
        f"{len(seed['bindings']['antibiotic'])} antibiotics bound "
        f"({counts['exact']} exact, {counts['synonym']} synonym, {counts['salt-stripped']} salt-stripped, "
        f"{counts['ester-stripped']} ester-stripped, {counts['reversed-combination']} reversed combination, "
        f"{counts['loinc-synonym']} LOINC synonym), "
        f"{len(seed['unmatched'])} left uncoded, {len(seed['concepts'][LOINC])} LOINC concepts bundled"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
