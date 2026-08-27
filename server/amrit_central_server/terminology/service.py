"""The four terminology operations, mirrored from the desktop.

Phase 22. The twin of ``app/src/main/terminology/service.ts``, reading the same seed from
``shared/terminology/terminology-seed.v1.json``. Both runtimes must agree about what a code
means, because the portal validates what the desktop exports: a `$validate-code` here that
disagreed with the binding there would reject the product's own output.

Pure, like its twin — the seed is loaded once by ``loader.py`` and handed in. No network at
run time: the seed is built offline by ``tools/generate_terminology_seed.py``.

## Disabling a code system

The country profile's ``code_systems.<id>.enabled`` gate that Phase 10 built for SNOMED
applies here unchanged. "Disabled" produces a reason, never an empty result and never a
substitute code from another system: a caller told "no such code" concludes the code is
wrong, while a caller told "this deployment has SNOMED disabled" knows what to do.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Iterable

LOINC_SYSTEM = "http://loinc.org"
UCUM_SYSTEM = "http://unitsofmeasure.org"
SNOMED_SYSTEM = "http://snomed.info/sct"
ICD10_SYSTEM = "http://hl7.org/fhir/sid/icd-10"
#: Phase 26. ICD-11 MMS, as WHO's own API names it.
ICD11_SYSTEM = "http://id.who.int/icd/release/11/mms"
WHONET_ANTIBIOTIC_SYSTEM = "urn:whonet:antibiotic-code"
WHONET_ORGANISM_SYSTEM = "urn:whonet:organism-code"
WHONET_SPECIMEN_SYSTEM = "urn:whonet:specimen-code"

#: The revisions of ICD a record's ``diagnosis_system`` may name. Both are bundled as
#: starter value sets and neither is converted into the other: WHO's API publishes no
#: mapping between the revisions, so a deployment's records stay in the revision they
#: were captured in.
ICD_SYSTEMS = frozenset({ICD10_SYSTEM, ICD11_SYSTEM})

LOCAL_SYSTEMS = frozenset({WHONET_ANTIBIOTIC_SYSTEM, WHONET_ORGANISM_SYSTEM, WHONET_SPECIMEN_SYSTEM})
LICENCE_IDS = {
    LOINC_SYSTEM: "loinc",
    UCUM_SYSTEM: "ucum",
    SNOMED_SYSTEM: "snomed",
    ICD10_SYSTEM: "icd10",
    # CC BY-ND 3.0 IGO. Free to use with attribution, so it ships enabled; gated anyway so a
    # deployment whose counsel objects to the no-derivatives terms can switch it off and get
    # a reason rather than an empty result.
    ICD11_SYSTEM: "icd11",
}

#: A gate answers, for one system URL, whether this deployment may use it and why not.
SystemGate = Callable[[str], "Gate"]


@dataclass(frozen=True)
class Gate:
    enabled: bool
    reason: str = ""


def all_systems_enabled(_system: str) -> Gate:
    return Gate(True, "")


def profile_gate(code_systems: dict[str, Any] | None) -> SystemGate:
    """The gate for a country profile's ``code_systems`` block.

    A system with no entry is enabled: the profile lists what needs a decision, and a
    vocabulary that needs none should not have to be enumerated by every deployment.
    """
    configured = code_systems or {}

    def gate(system: str) -> Gate:
        if system in LOCAL_SYSTEMS:
            return Gate(True, "")
        licence_id = LICENCE_IDS.get(system)
        if not licence_id:
            return Gate(True, "")
        entry = configured.get(licence_id) or {}
        if entry.get("enabled") is not False:
            return Gate(True, "")
        licence = entry.get("licence")
        return Gate(
            False,
            f"{licence_id.upper()} is disabled in this deployment's country profile"
            + (f": {licence}" if licence else ".")
            + f" Codes from {system} are omitted from output rather than substituted, and the "
            "export records that they were omitted.",
        )

    return gate


@dataclass(frozen=True)
class Outcome:
    """An answer, or a reason there is not one. Never a plausible substitute."""

    ok: bool
    value: Any = None
    reason: str = ""


def _concepts(seed: dict[str, Any], system: str) -> list[dict[str, str]]:
    return list((seed.get("concepts") or {}).get(system) or [])


def lookup(seed: dict[str, Any], system: str, code: str, gate: SystemGate = all_systems_enabled) -> Outcome:
    """``$lookup`` — what does this code mean?"""
    gated = gate(system)
    if not gated.enabled:
        return Outcome(False, None, gated.reason)
    wanted = str(code or "").strip()
    if not wanted:
        return Outcome(False, None, "No code given.")
    for concept in _concepts(seed, system):
        if concept.get("code") == wanted:
            return Outcome(True, concept, "")
    if system not in (seed.get("concepts") or {}):
        bundled = ", ".join(sorted((seed.get("concepts") or {}).keys())) or "none"
        return Outcome(False, None, f"This deployment bundles no concepts for {system}. Bundled: {bundled}.")
    return Outcome(
        False,
        None,
        f"{code} is not in the bundled subset of {system}. AMRIT bundles only the concepts it binds "
        "to, so this says the code is unused here, not that it is invalid.",
    )


def validate_code(seed: dict[str, Any], system: str, code: str, gate: SystemGate = all_systems_enabled) -> Outcome:
    """``$validate-code`` — is this code usable in this deployment?"""
    found = lookup(seed, system, code, gate)
    if not found.ok:
        return Outcome(False, None, found.reason)
    return Outcome(True, {"code": found.value.get("code"), "display": found.value.get("display", "")}, "")


def translate(
    seed: dict[str, Any],
    source_system: str,
    code: str,
    concept_map: str | None = None,
    relationship: str | None = None,
    gate: SystemGate = all_systems_enabled,
) -> Outcome:
    """``$translate`` — what is this code in another system?

    With no relationship named, every target the map holds is returned. For an antibiotic
    that is deliberate: an MIC and a disk diffusion of one drug are different LOINC concepts,
    so a caller that has not said which method it measured has not asked an answerable
    question, and picking one for it would be wrong half the time.
    """
    maps = [
        entry for entry in seed.get("conceptMaps", [])
        if (concept_map is None or entry.get("id") == concept_map) and entry.get("sourceSystem") == source_system
    ]
    if not maps:
        if concept_map:
            return Outcome(False, None, f"No ConceptMap '{concept_map}' from {source_system}.")
        available = ", ".join(entry.get("id", "") for entry in seed.get("conceptMaps", []))
        return Outcome(False, None, f"No ConceptMap translates {source_system}. Available: {available}.")

    translations: list[dict[str, str]] = []
    blocked: list[str] = []
    for entry in maps:
        gated = gate(entry.get("targetSystem", ""))
        if not gated.enabled:
            blocked.append(gated.reason)
            continue
        element = next(
            (row for row in entry.get("elements", []) if str(row.get("source", "")).upper() == str(code).upper()),
            None,
        )
        if not element:
            continue
        for key, target in (element.get("targets") or {}).items():
            if relationship and key != relationship:
                continue
            display = lookup(seed, entry.get("targetSystem", ""), target)
            translations.append({
                "conceptMap": entry.get("id", ""),
                "targetSystem": entry.get("targetSystem", ""),
                "relationship": key,
                "code": target,
                "display": (display.value or {}).get("display", "") if display.ok else "",
            })
    if translations:
        return Outcome(True, translations, "")
    if blocked:
        return Outcome(False, None, " ".join(blocked))
    named = ", ".join(entry.get("id", "") for entry in maps)
    suffix = f" ({relationship})" if relationship else ""
    return Outcome(
        False, None,
        f"No mapping for {code}{suffix} in {named}. Unmapped is recorded as unmapped; nothing is guessed.",
    )


def expand(
    seed: dict[str, Any],
    system: str,
    text_filter: str = "",
    count: int = 100,
    offset: int = 0,
    gate: SystemGate = all_systems_enabled,
) -> Outcome:
    """``ValueSet/$expand`` — which codes may go in this field?

    ``total`` is the number of matches, not the number returned, so a caller paging a picker
    knows whether it is looking at everything.
    """
    gated = gate(system)
    if not gated.enabled:
        return Outcome(False, None, gated.reason)
    concepts = _concepts(seed, system)
    if not concepts and system not in (seed.get("concepts") or {}):
        return Outcome(False, None, f"This deployment bundles no concepts for {system}.")
    needle = str(text_filter or "").strip().lower()
    matched: Iterable[dict[str, str]] = concepts
    if needle:
        matched = [
            concept for concept in concepts
            if needle in concept.get("code", "").lower() or needle in concept.get("display", "").lower()
        ]
    matched = list(matched)
    offset = max(0, int(offset))
    count = max(1, min(1000, int(count)))
    return Outcome(True, {
        "system": system,
        "total": len(matched),
        "offset": offset,
        "concepts": matched[offset:offset + count],
    }, "")


def antibiotic_binding(
    seed: dict[str, Any], antibiotic_code: str, method: str, gate: SystemGate = all_systems_enabled
) -> Outcome:
    """The LOINC code for a susceptibility result, chosen by the method that produced it."""
    gated = gate(LOINC_SYSTEM)
    if not gated.enabled:
        return Outcome(False, None, gated.reason)
    binding = (seed.get("bindings", {}).get("antibiotic") or {}).get(str(antibiotic_code).upper())
    if not binding:
        unmatched = next(
            (row for row in seed.get("unmatched", [])
             if str(row.get("code", "")).upper() == str(antibiotic_code).upper()),
            None,
        )
        if unmatched:
            return Outcome(
                False, None,
                f"{antibiotic_code} ({unmatched.get('name')}) has no LOINC susceptibility concept: "
                f"{unmatched.get('reason')}",
            )
        return Outcome(False, None, f"{antibiotic_code} is not in the catalogue this seed was built from.")
    wanted = str(method or "").upper()
    if wanted == "MIC":
        preference = ["mic", "plain"]
    elif wanted in {"DISK", "KB"}:
        preference = ["disk", "plain"]
    elif wanted in {"ETEST", "GRADIENT"}:
        preference = ["gradient", "mic", "plain"]
    else:
        preference = ["plain", "mic", "disk"]
    chosen = next((key for key in preference if binding.get(key)), None)
    if not chosen:
        return Outcome(False, None, f"{antibiotic_code} has no LOINC concept for method '{method}'.")
    code = binding[chosen]
    display = lookup(seed, LOINC_SYSTEM, code)
    return Outcome(True, {
        "code": code,
        "method": chosen,
        "display": (display.value or {}).get("display", "") if display.ok else "",
    }, "")


def unit_for(seed: dict[str, Any], method: str) -> str:
    """The UCUM unit a measurement of this method is in, or empty when the method is unknown."""
    return (seed.get("bindings", {}).get("units") or {}).get(str(method or "").upper(), "")


def describe_terminology(seed: dict[str, Any], gate: SystemGate = all_systems_enabled) -> list[dict[str, Any]]:
    """What this deployment can say about its terminology, for the licences view and the IG."""
    described = []
    for system in seed.get("codeSystems", []):
        gated = gate(system.get("url", ""))
        described.append({
            "url": system.get("url"),
            "name": system.get("name"),
            "concepts": system.get("concepts"),
            "enabled": gated.enabled,
            "reason": gated.reason,
            "note": system.get("note"),
        })
    return described
