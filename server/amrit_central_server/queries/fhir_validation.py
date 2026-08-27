"""Minimal FHIR R4 validation for de-identified aggregate site responses."""

from __future__ import annotations

from typing import Any


ALLOWED_AGGREGATE_RESOURCE_TYPES = frozenset(
    {"Organization", "Measure", "MeasureReport", "Observation"}
)
FORBIDDEN_PATIENT_LINK_KEYS = frozenset(
    {
        "subject",
        "patient",
        "encounter",
        "specimen",
        "individual",
        "beneficiary",
        "telecom",
        "contact",
        "birthDate",
        "deceasedBoolean",
        "deceasedDateTime",
    }
)


def validate_aggregate_fhir_bundle(bundle: Any) -> list[str]:
    """Return structural/privacy errors for an aggregate-only FHIR R4 Bundle."""
    errors: list[str] = []
    if not isinstance(bundle, dict):
        return ["FHIR payload must be a JSON object"]
    if bundle.get("resourceType") != "Bundle":
        errors.append("resourceType must be Bundle")
    if bundle.get("type") != "collection":
        errors.append("Bundle.type must be collection")
    entries = bundle.get("entry")
    if not isinstance(entries, list):
        errors.append("Bundle.entry must be an array")
        return errors

    for index, entry in enumerate(entries):
        resource = entry.get("resource") if isinstance(entry, dict) else None
        if not isinstance(resource, dict):
            errors.append(f"entry[{index}].resource must be an object")
            continue
        resource_type = resource.get("resourceType")
        if resource_type not in ALLOWED_AGGREGATE_RESOURCE_TYPES:
            errors.append(f"entry[{index}] resourceType {resource_type!r} is not aggregate-safe")
        _scan_patient_links(resource, f"entry[{index}].resource", errors)
    return errors


def _scan_patient_links(node: Any, path: str, errors: list[str]) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            child = f"{path}.{key}"
            if key in FORBIDDEN_PATIENT_LINK_KEYS:
                errors.append(f"{child} is not allowed in aggregate FHIR")
                continue
            if key == "reference" and isinstance(value, str):
                lowered = value.lower()
                if "patient/" in lowered or "patient-" in lowered:
                    errors.append(f"{child} contains a patient reference")
                    continue
            _scan_patient_links(value, child, errors)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            _scan_patient_links(value, f"{path}[{index}]", errors)
