"""FHIR R4 aggregate output.

The central server publishes only de-identified aggregate measures. The
canonical resource is ``MeasureReport`` with embedded ``Measure`` and
``Organization`` references inside a ``Bundle`` of ``type = collection``.
This is the format AMRIT sites already emit for ``measure_bundle``
queries (see ``aggregate_measures.py`` in the desktop project).
"""

from __future__ import annotations

from central import identifiers
from geo.address import to_fhir_address
import math
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional


def _utcnow() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def wilson_ci(numerator: int, denominator: int, level: float = 0.95) -> Dict[str, float]:
    """Two-sided Wilson score interval for a binomial proportion."""
    if denominator <= 0:
        return {"low": 0.0, "high": 0.0, "level": level}
    z = 1.959963984540054 if abs(level - 0.95) < 1e-6 else _z_for(level)
    p = numerator / denominator
    n = denominator
    denom = 1 + (z**2) / n
    centre = p + (z**2) / (2 * n)
    margin = z * math.sqrt((p * (1 - p) + (z**2) / (4 * n)) / n)
    return {
        "low": max(0.0, (centre - margin) / denom),
        "high": min(1.0, (centre + margin) / denom),
        "level": level,
    }


def _z_for(level: float) -> float:
    table = {0.80: 1.281552, 0.90: 1.644854, 0.95: 1.959964, 0.975: 2.241403, 0.99: 2.575829}
    closest = min(table.keys(), key=lambda k: abs(k - level))
    return table[closest]


def organization_resource(site: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "resourceType": "Organization",
        "id": _new_id("org"),
        "identifier": [
            {"system": identifiers.lab_code_system(), "value": site.get("lab_code", "")}
        ],
        "name": site.get("name") or site.get("lab_code", ""),
        # The stored structured address mapped straight onto FHIR Address; the field set
        # was chosen so that mapping is one-to-one. Assembling an address out of a site's
        # level-1 and level-2 unit names, as this did, files a commune as a district and a
        # region as a state everywhere the levels are not called that.
        **({"address": [address]} if (address := to_fhir_address(site.get("address") or {})) else {}),
    }


def measure_resource(*, antibiotic_code: str, organism: str = "", specimen: str = "") -> Dict[str, Any]:
    return {
        "resourceType": "Measure",
        "id": _new_id("measure"),
        "url": identifiers.measure_url(antibiotic_code),
        "status": "active",
        "name": f"AMRResistanceRate_{antibiotic_code}",
        "title": f"Antimicrobial resistance rate — {antibiotic_code}",
        "scoring": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/measure-scoring", "code": "proportion"}]},
        "group": [
            {
                "population": [
                    {
                        "code": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/measure-population", "code": "initial-population"}]},
                        "description": (
                            f"Isolates of {organism or 'any organism'} from {specimen or 'any specimen'} "
                            f"with valid {antibiotic_code} susceptibility result"
                        ),
                    },
                    {
                        "code": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/measure-population", "code": "denominator"}]},
                        "description": "Isolates with valid AST interpretation (R, I, or S).",
                    },
                    {
                        "code": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/measure-population", "code": "numerator"}]},
                        "description": "Isolates resistant to the antibiotic.",
                    },
                ]
            }
        ],
    }


def measure_report_resource(
    *,
    measure_url: str,
    organization_ref: str,
    period_start: str,
    period_end: str,
    numerator: int,
    denominator: int,
    extra_strata: Optional[List[Dict[str, Any]]] = None,
    ci: Optional[Dict[str, float]] = None,
) -> Dict[str, Any]:
    rate = (numerator / denominator) if denominator else 0.0
    body: Dict[str, Any] = {
        "resourceType": "MeasureReport",
        "id": _new_id("mr"),
        "status": "complete",
        "type": "summary",
        "measure": measure_url,
        "date": _utcnow(),
        "reporter": {"reference": organization_ref},
        "period": {"start": period_start or "1970-01-01", "end": period_end or _utcnow()[:10]},
        "group": [
            {
                "population": [
                    {
                        "code": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/measure-population", "code": "initial-population"}]},
                        "count": denominator,
                    },
                    {
                        "code": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/measure-population", "code": "denominator"}]},
                        "count": denominator,
                    },
                    {
                        "code": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/measure-population", "code": "numerator"}]},
                        "count": numerator,
                    },
                ],
                "measureScore": {"value": round(rate, 4)},
                "stratifier": extra_strata or [],
            }
        ],
    }
    if ci is not None:
        body["extension"] = [
            {
                "url": identifiers.proportion_ci_extension(),
                "extension": [
                    {"url": "method", "valueString": "wilson"},
                    {"url": "level", "valueDecimal": ci["level"]},
                    {"url": "low", "valueDecimal": round(ci["low"], 4)},
                    {"url": "high", "valueDecimal": round(ci["high"], 4)},
                ],
            }
        ]
    return body


def stratifier_from_buckets(name: str, buckets: Dict[str, int]) -> Dict[str, Any]:
    return {
        "code": [{"text": name}],
        "stratum": [
            {"value": {"text": label}, "measureScore": {"value": count}}
            for label, count in sorted(buckets.items(), key=lambda kv: (-kv[1], kv[0]))
        ],
    }


def bundle(entries: Iterable[Dict[str, Any]], *, identifier: str = "") -> Dict[str, Any]:
    bundle_entries = []
    for resource in entries:
        bundle_entries.append({"fullUrl": f"urn:uuid:{resource['id']}", "resource": resource})
    return {
        "resourceType": "Bundle",
        "id": _new_id("bundle"),
        "identifier": {"system": identifiers.bundle_identifier_system(), "value": identifier or _new_id("ident")},
        "type": "collection",
        "timestamp": _utcnow(),
        "entry": bundle_entries,
    }


def observation_count(*, code: str, display: str, count: int, organization_ref: str) -> Dict[str, Any]:
    return {
        "resourceType": "Observation",
        "id": _new_id("obs"),
        "status": "final",
        "category": [
            {
                "coding": [
                    {
                        "system": "http://terminology.hl7.org/CodeSystem/observation-category",
                        "code": "laboratory",
                    }
                ]
            }
        ],
        "code": {"coding": [{"system": identifiers.aggregate_code_system(), "code": code, "display": display}]},
        "valueQuantity": {"value": count, "unit": "isolates"},
        "performer": [{"reference": organization_ref}],
        "effectiveDateTime": _utcnow(),
    }
