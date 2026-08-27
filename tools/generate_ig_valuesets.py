#!/usr/bin/env python3
"""Generate the Implementation Guide's ValueSets from the terminology seed.

Phase 25. The plan's requirement, and the reason for it: *"ValueSets and ConceptMaps published
as part of the IG, generated from the Phase 22 tables so the IG and the runtime cannot drift."*
An IG that lists codes the product does not send, or omits codes it does, is worse than no IG —
it is a published claim that fails on contact.

So nothing here is authored. Every code comes from `shared/terminology/terminology-seed.v1.json`,
which is itself generated and hash-pinned, and this tool has the same `--check` mode: if the seed
changes and the IG is not regenerated, the build fails.

    python3 tools/generate_ig_valuesets.py            # write the ValueSets and ConceptMaps
    python3 tools/generate_ig_valuesets.py --check    # fail if they are stale (CI gate)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SEED = REPOSITORY_ROOT / "shared" / "terminology" / "terminology-seed.v1.json"
CATALOGUE = REPOSITORY_ROOT / "app" / "resources" / "catalog-seed.v2.json"
OUTPUT = REPOSITORY_ROOT / "fhir-ig" / "input" / "resources"

# A placeholder canonical, matching the FSH sources. A deployment publishing this IG replaces it
# with its own base URI, which is the same value its emitted `meta.profile` uses.
CANONICAL = "https://amrit.invalid"
LOINC = "http://loinc.org"
ICD10 = "http://hl7.org/fhir/sid/icd-10"
# Phase 26. ICD-11 MMS, as WHO's own API names it.
ICD11 = "http://id.who.int/icd/release/11/mms"


def machine_name(identifier: str) -> str:
    """A `name` that satisfies the `vsd-0`/`csd-0`/`cmd-0` invariants.

    They require `[A-Z]([A-Za-z0-9_]){1,254}` — usable as an identifier by machine processing,
    which means PascalCase and no hyphens. The validator warns on every resource that gets this
    wrong, and it warned on all six of the first generated set.
    """
    return "".join(part[:1].upper() + part[1:] for part in identifier.split("-") if part)


def value_set(identifier: str, title: str, description: str, system: str, codes: list[dict[str, str]]) -> dict[str, Any]:
    return {
        "resourceType": "ValueSet",
        "id": identifier,
        "url": f"{CANONICAL}/ValueSet/{identifier}",
        "name": machine_name(identifier),
        "title": title,
        "status": "active",
        "experimental": False,
        "description": description,
        "compose": {"include": [{
            "system": system,
            "concept": [{"code": row["code"], "display": row["display"]} for row in codes],
        }]},
    }


def readable_title(identifier: str) -> str:
    """A human title from a map id, with the vocabulary names spelled as their owners spell them.

    The publisher warns on each map that has none — *"Published concept maps SHOULD conform to
    the ShareableConceptMap profile, which says that the element ConceptMap.title is mandatory,
    but it is not present"*. Derived rather than authored so that a map added to the seed gets a
    title without anyone remembering to write one.
    """
    acronyms = {"amrit": "AMRIT", "loinc": "LOINC", "snomed": "SNOMED", "icd10": "ICD-10",
                "icd11": "ICD-11", "whonet": "WHONET", "ucum": "UCUM"}
    words = [acronyms.get(part, part) for part in identifier.split("-") if part]
    return " ".join(words)[:1].upper() + " ".join(words)[1:]


def concept_map(entry: dict[str, Any]) -> dict[str, Any]:
    """One ConceptMap, with every element the seed holds — not a sample of them."""
    elements = []
    for element in entry.get("elements", []):
        targets = [
            {"code": code, "equivalence": "equivalent" if relationship == "equivalent" else "relatedto",
             "comment": relationship}
            for relationship, code in (element.get("targets") or {}).items()
        ]
        elements.append({"code": element.get("source"), "target": targets})
    return {
        "resourceType": "ConceptMap",
        "id": entry.get("id"),
        "url": f"{CANONICAL}/ConceptMap/{entry.get('id')}",
        "name": machine_name(str(entry.get("id", ""))),
        "title": readable_title(str(entry.get("id", ""))),
        "status": "active",
        "experimental": False,
        "description": entry.get("note", ""),
        # No `sourceUri`/`targetUri`. R4 requires those to reference a **ValueSet**, and what
        # these maps translate between is two code systems; the validator said so —
        # "Reference must be to a ValueSet, but found a CodeSystem instead" — on all three maps.
        # `group.source` and `group.target` are where a code system URI belongs.
        "group": [{
            "source": entry.get("sourceSystem"),
            "target": entry.get("targetSystem"),
            "element": elements,
        }],
    }


def code_system(identifier: str, url: str, title: str, description: str,
                concepts: list[dict[str, str]]) -> dict[str, Any]:
    """One of AMRIT's own code spaces, published so a receiver can resolve it.

    The validator's complaint before these existed was exact and fair: *"A definition for
    CodeSystem 'urn:whonet:antibiotic-code' could not be found, so the code cannot be
    validated"*. AMRIT emits those codes on every observation; a receiver that cannot resolve
    them has to take them on trust. `content: complete` is claimed only because it is true —
    the concepts are the whole catalogue table, generated from it.
    """
    return {
        "resourceType": "CodeSystem",
        "id": identifier,
        "url": url,
        "name": machine_name(identifier),
        "title": title,
        "status": "active",
        "experimental": False,
        "caseSensitive": True,
        "content": "complete",
        "count": len(concepts),
        "description": description,
        "concept": concepts,
    }


def build(seed: dict[str, Any]) -> dict[str, dict[str, Any]]:
    resources: dict[str, dict[str, Any]] = {}

    susceptibility = sorted(
        {code for binding in seed["bindings"]["antibiotic"].values()
         for key, code in binding.items() if key in {"mic", "disk", "gradient", "plain"}}
    )
    by_code = {row["code"]: row for row in seed["concepts"][LOINC]}
    resources["ValueSet-amrit-susceptibility-loinc.json"] = value_set(
        "amrit-susceptibility-loinc",
        "AMRIT susceptibility LOINC concepts",
        "Every LOINC concept AMRIT can put on a susceptibility observation, one per agent and "
        "method. Generated from the terminology seed; 135 catalogue agents have no LOINC concept "
        "and are exported with the WHONET coding alone.",
        LOINC,
        [by_code[code] for code in susceptibility if code in by_code],
    )

    observation_codes = [row for row in seed["bindings"]["observation"].values()]
    resources["ValueSet-amrit-observation-loinc.json"] = value_set(
        "amrit-observation-loinc",
        "AMRIT observation and report LOINC concepts",
        "The three LOINC concepts AMRIT uses to say what kind of thing it is reporting: organism "
        "identification, the susceptibility panel, and the microbiology report.",
        LOINC,
        [{"code": row["code"], "display": row["display"]} for row in observation_codes],
    )

    diagnosis = seed.get("concepts", {}).get(ICD10, [])
    if diagnosis:
        resources["ValueSet-amrit-diagnosis-starter.json"] = value_set(
            "amrit-diagnosis-starter",
            "AMRIT diagnosis starter value set",
            "The infection syndromes AMR surveillance reports on, every code verified against the "
            "terminology server. This is the default value set, not the only codes a deployment "
            "may use: a deployment extends it or replaces it with its national set.",
            ICD10,
            diagnosis,
        )

    # Phase 26. The same clinical scope in ICD-11, as its own value set rather than as an
    # extension of the ICD-10 one. They are parallel, not interchangeable: the IG must not
    # let a receiver conclude that a code from either set validates against the other.
    diagnosis_icd11 = seed.get("concepts", {}).get(ICD11, [])
    if diagnosis_icd11:
        resources["ValueSet-amrit-diagnosis-starter-icd11.json"] = value_set(
            "amrit-diagnosis-starter-icd11",
            "AMRIT diagnosis starter value set (ICD-11 MMS)",
            "The same infection syndromes expressed in ICD-11 MMS, plus WHO's MG50-MG54 "
            "antimicrobial-resistance findings. Taken from WHO's own ICD API, every code "
            "confirmed to exist and confirmed to carry the concept it was requested for. "
            "No ConceptMap to the ICD-10 set is published: WHO's API exposes no mapping "
            "between the revisions, and a record states which revision it used.",
            ICD11,
            diagnosis_icd11,
        )

    # AMRIT's own code spaces, from the catalogue that defines them.
    catalogue = json.loads(CATALOGUE.read_text(encoding="utf-8"))["catalogue"]
    resources["CodeSystem-whonet-antibiotic-code.json"] = code_system(
        "whonet-antibiotic-code", "urn:whonet:antibiotic-code",
        "WHONET antimicrobial codes",
        "The antimicrobial code space AMRIT emits alongside LOINC on every susceptibility "
        "observation. It is the reason a WHONET user can read AMRIT's output at all.",
        [{"code": str(row["code"]), "display": str(row.get("name", ""))}
         for row in catalogue["antibiotics"] if str(row.get("code", "")).strip()],
    )
    resources["CodeSystem-whonet-organism-code.json"] = code_system(
        "whonet-organism-code", "urn:whonet:organism-code",
        "WHONET organism codes",
        "The organism code space. SNOMED concepts are carried alongside where the deployment "
        "is licensed for them; this one is always present.",
        [{"code": str(row["code"]), "display": str(row.get("organism_name", ""))}
         for row in catalogue["organisms"] if str(row.get("code", "")).strip()],
    )
    resources["CodeSystem-whonet-specimen-code.json"] = code_system(
        "whonet-specimen-code", "urn:whonet:specimen-code",
        "WHONET specimen groups",
        "The specimen groups AMRIT reports on. Three of the eight carry a SNOMED concept; the "
        "rest are unmapped rather than approximated.",
        [{"code": str(row["code"]), "display": str(row.get("name", ""))}
         for row in catalogue["samples"] if str(row.get("code", "")).strip()],
    )

    # The bundle-level tag space. `buildFhirBundle` stamps every coding it could not produce
    # onto `Bundle.meta.tag` with this system, which is how a receiver tells "this deployment
    # does not license SNOMED" from "this organism is unknown". Until it was published the
    # validator said what it says about any unresolvable system — *"A definition for CodeSystem
    # 'urn:amrit:terminology-note' could not be found, so the code cannot be validated"* — three
    # times on the reference bundle. One concept, because the exporter emits one code and the
    # reason travels in `display`; a code system that lists concepts nothing emits is a worse
    # lie than one that lists too few.
    resources["CodeSystem-amrit-terminology-note.json"] = code_system(
        "amrit-terminology-note", "urn:amrit:terminology-note",
        "AMRIT terminology notes",
        "Why a standard coding is absent from a bundle that would otherwise carry one. The tag "
        "is present so that a missing code is a stated gap rather than a silent one; the "
        "specific reason travels in the tag's display text.",
        # Must stay identical to the tag display in `services.ts`; the official validator
        # compares a Coding's display against the code system's and errors when they differ,
        # which is how the original defect — per-message prose in `Coding.display` — surfaced.
        [{"code": "coding-omitted",
          "display": "A standard coding was not emitted; see the OperationOutcome in this bundle for the reasons"}],
    )

    for entry in seed.get("conceptMaps", []):
        resources[f"ConceptMap-{entry['id']}.json"] = concept_map(entry)
    return resources


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="fail if the generated resources are stale")
    arguments = parser.parse_args()

    if not SEED.exists():
        print(f"missing {SEED.relative_to(REPOSITORY_ROOT)}; run tools/generate_terminology_seed.py", file=sys.stderr)
        return 1
    seed = json.loads(SEED.read_text(encoding="utf-8"))
    resources = build(seed)

    if arguments.check:
        problems = []
        for name, resource in resources.items():
            path = OUTPUT / name
            if not path.exists():
                problems.append(f"{name}: missing")
                continue
            if json.loads(path.read_text(encoding="utf-8")) != resource:
                problems.append(f"{name}: stale — the terminology seed has changed since it was generated")
        if problems:
            print("IG resources are out of date with the terminology seed:", file=sys.stderr)
            for problem in problems:
                print(f"  - {problem}", file=sys.stderr)
            print("Run tools/generate_ig_valuesets.py.", file=sys.stderr)
            return 1
        print(f"IG resources in sync with the terminology seed ({len(resources)} files)")
        return 0

    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name, resource in resources.items():
        (OUTPUT / name).write_text(json.dumps(resource, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    counts = ", ".join(
        f"{name.split('-', 1)[0]} {name}" for name in list(resources)[:0]
    )
    print(f"wrote {len(resources)} IG resources to {OUTPUT.relative_to(REPOSITORY_ROOT)}{counts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
