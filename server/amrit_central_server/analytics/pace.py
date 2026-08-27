"""PACE — Phenotype-Aggregated Cluster Evaluation, mirrored from the desktop.

The twin of ``app/src/main/detection/pace.ts`` and ``phenotype.ts``. What is mirrored here is
every part of PACE that is a *rule* rather than a scan: which mechanism an agent is evidence of,
how an isolate's agents collapse into one result per mechanism, the Šidák correction over the two
models, the alert threshold that spends a stated budget, and the transmission-plausibility score.
``shared/golden-datasets/detector_reference.json`` pins all five, so a change to any of them on
one side fails on the other.

What is **not** mirrored is the two scans PACE composes, and the reason is the same one Phases 27
and 29 recorded: the federation wire carries the count of *resistant* cases and nothing about how
many isolates were tested or which isolate a resistance came from. Phenotype aggregation needs
the isolate — an isolate resistant to meropenem, imipenem and ertapenem is one carbapenem-resistant
case and an aggregate row cannot say that — and the proportion model needs the denominator. So
PACE registers centrally and reports unavailable with a reason that names the wire, and the rules
below are mirrored anyway, because a rule that exists in one runtime and not the other drifts.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence

PACE_ID = "pace"


@dataclass(frozen=True)
class Phenotype:
    """One resistance mechanism, as a stream key fragment."""

    id: str
    label: str


# Subclass before class: the class is too coarse. ``Cephems`` holds first-generation
# cephalosporins and fourth-generation ones, which are different mechanisms and different
# outbreaks. Order matters and is the desktop's order.
SUBCLASS_PHENOTYPES: tuple[tuple[re.Pattern[str], Phenotype], ...] = (
    (re.compile(r"^carbapenems?$", re.I), Phenotype("carbapenem-R", "Carbapenem resistance")),
    (
        re.compile(r"^cephalosporin\s*III$", re.I),
        Phenotype("3GC-R", "Third-generation cephalosporin resistance (ESBL phenotype)"),
    ),
    (
        re.compile(r"^cephalosporin\s*IV$", re.I),
        Phenotype("4GC-R", "Fourth-generation cephalosporin resistance"),
    ),
    (re.compile(r"^cephamycin$", re.I), Phenotype("cephamycin-R", "Cephamycin resistance (AmpC phenotype)")),
    (
        re.compile(r"^penicillin\s*\(stable\)$", re.I),
        Phenotype("oxacillin-R", "Oxacillin resistance (MRSA phenotype)"),
    ),
    (
        re.compile(r"^(lipo)?glycopeptide$", re.I),
        Phenotype("glycopeptide-R", "Glycopeptide resistance (VRE/VRSA phenotype)"),
    ),
    (re.compile(r"^fluoroquinolone$", re.I), Phenotype("fluoroquinolone-R", "Fluoroquinolone resistance")),
)

CLASS_PHENOTYPES: tuple[tuple[re.Pattern[str], Phenotype], ...] = (
    (re.compile(r"^aminoglycosides$", re.I), Phenotype("aminoglycoside-R", "Aminoglycoside resistance")),
    (re.compile(r"^lipopeptides$", re.I), Phenotype("polymyxin-R", "Polymyxin resistance")),
    (re.compile(r"^macrolides$", re.I), Phenotype("macrolide-R", "Macrolide resistance")),
    (re.compile(r"^tetracyclines$", re.I), Phenotype("tetracycline-R", "Tetracycline resistance")),
    (
        re.compile(r"^folate pathway inhibitors$", re.I),
        Phenotype("folate-R", "Folate pathway inhibitor resistance"),
    ),
)

_INTERPRETATIONS = {"R", "I", "S"}


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _upper(value: Any) -> str:
    return _text(value).upper()


def phenotype_for_agent(row: Mapping[str, Any] | None) -> Phenotype | None:
    """The mechanism an agent is evidence of, or ``None`` when the catalogue does not classify it.

    ``None`` is not a failure: the caller falls back to the agent as its own stream, which is what
    the case-only scan does with every agent. An agent with no mechanism-level class is better
    left alone than pooled into a class it does not belong to.
    """
    if not row:
        return None
    subclass = _text(row.get("subclass_name"))
    for pattern, phenotype in SUBCLASS_PHENOTYPES:
        if pattern.match(subclass):
            return phenotype
    class_name = _text(row.get("class_name"))
    for pattern, phenotype in CLASS_PHENOTYPES:
        if pattern.match(class_name):
            return phenotype
    return None


def build_phenotype_index(rows: Iterable[Mapping[str, Any]]) -> dict[str, Phenotype]:
    """Agent code to phenotype, built once from the catalogue."""
    index: dict[str, Phenotype] = {}
    for row in rows:
        phenotype = phenotype_for_agent(row)
        if phenotype is not None:
            index[_upper(row.get("code"))] = phenotype
    return index


def label_for_phenotype(phenotype_id: str, index: Mapping[str, Phenotype]) -> str:
    """What an operator reads, falling back to the id for an agent that was never pooled.

    Matched case-insensitively: both counting paths upper-case the agent code on the way through,
    so what comes back from a scan is ``CARBAPENEM-R`` where the mapping wrote ``carbapenem-R``.
    """
    wanted = _upper(phenotype_id)
    for phenotype in index.values():
        if _upper(phenotype.id) == wanted:
            return phenotype.label
    return phenotype_id


def map_record_to_phenotypes(
    record: Mapping[str, Any], index: Mapping[str, Phenotype]
) -> dict[str, Any]:
    """An isolate whose susceptibility results are collapsed to one entry per mechanism.

    The counting rule, which is the whole point and is easy to get wrong: an isolate resistant to
    meropenem, imipenem *and* ertapenem is **one** carbapenem-resistant case, not three. Each
    isolate therefore carries at most one result per phenotype — ``R`` if any agent in it is ``R``,
    otherwise ``I`` if any is ``I``, otherwise ``S``. Precedence rather than a vote, because a
    carbapenemase is not outvoted by the two carbapenems that still test susceptible.
    """
    results = record.get("antibiotic_results") or {}
    pooled: dict[str, dict[str, str]] = {}
    for raw_code, ast in results.items():
        interpretation = _upper((ast or {}).get("result"))
        if interpretation not in _INTERPRETATIONS:
            continue
        code = _upper(raw_code)
        phenotype = index.get(code)
        key = phenotype.id if phenotype else code
        current = _upper((pooled.get(key) or {}).get("result"))
        if current == "R":
            continue
        if current == "I" and interpretation != "R":
            continue
        pooled[key] = {"result": interpretation}
    mapped = dict(record)
    mapped["antibiotic_results"] = pooled
    return mapped


def map_records_to_phenotypes(
    records: Sequence[Mapping[str, Any]], index: Mapping[str, Phenotype], aggregate: bool = True
) -> list[dict[str, Any]]:
    """Records with their agents pooled, or the records unchanged.

    ``aggregate=False`` returns the input rather than mapping every agent to itself, so the
    ablation arm with pooling off is provably running on the control arm's input.
    """
    if not aggregate:
        return [dict(record) for record in records]
    return [map_record_to_phenotypes(record, index) for record in records]


def count_streams(records: Sequence[Mapping[str, Any]]) -> int:
    """Distinct organism-and-stream pairs. Run over the input and the mapped records, the
    difference is the multiplicity PACE removed."""
    streams: set[str] = set()
    for record in records:
        organism = _upper(record.get("organism_code")) or _upper(record.get("organism"))
        if not organism:
            continue
        for code, ast in (record.get("antibiotic_results") or {}).items():
            if _upper((ast or {}).get("result")) not in _INTERPRETATIONS:
                continue
            streams.add(f"{organism}|{_upper(code)}")
    return len(streams)


def sidak(p_value: float, models: int) -> float:
    """The Šidák correction over the models that were run.

    Two models are two chances to declare a cluster, and reporting the smaller p-value without
    correction would inflate the false-alert rate by close to a factor of two. **With one model
    this is the identity**, which is what makes the single-model ablation literally the control
    arm rather than a near-copy of it.

    The honest limit: the two p-values are not independent — both models read the same isolates —
    so Šidák is conservative here, in the direction that costs PACE sensitivity.
    """
    if models <= 1:
        return p_value
    bounded = max(0.0, min(1.0, float(p_value)))
    return 1 - (1 - bounded) ** models


def alert_threshold_for(
    target_alerts_per_site_year: float, site_years: float, permutations: int
) -> dict[str, Any]:
    """The corrected p-value that spends an alert budget, given how much data was scanned.

    Both scans report a p-value corrected against the maximum over every window, location and
    stream, so under the null the probability that a run produces *any* signal at or below ``p``
    is ``p``. One run covers ``site_years`` site-years, so the threshold meeting a target rate is
    ``target * site_years`` — bounded below by the Monte Carlo floor ``1 / (permutations + 1)``
    and above by the 0.05 at which both kernels stop reporting. Both bounds are returned rather
    than silently applied.
    """
    floor = 1 / (permutations + 1)
    raw = float(target_alerts_per_site_year) * max(float(site_years), 1e-9)
    return {
        "threshold": max(floor, min(0.05, raw)),
        "floored": raw < floor,
        "ceilinged": raw > 0.05,
    }


def transmission_plausibility(
    cases: Sequence[Mapping[str, Any]], window_days: int
) -> dict[str, Any]:
    """How much of a cluster could plausibly be transmission, on a 0-to-1 scale.

    The question is whether the cases overlapped in a place, not whether they arrived close
    together in time. Where ``admission_date`` is present the stay is admission → specimen; where
    it is absent the specimen date alone is used and the window widens to ``window_days``, which
    is a weaker check and is why ``admissions_known`` is reported next to the score.

    Nothing here reaches the statistics: it orders signals the two scans already produced.
    """
    intervals: list[dict[str, Any]] = []
    for record in cases:
        specimen = _day(record.get("specimen_date"))
        if specimen is None:
            continue
        admission = _day(record.get("admission_date"))
        known = admission is not None and admission <= specimen
        intervals.append(
            {
                "location": _stable_location(record),
                "start": admission if known else specimen - window_days,
                "end": specimen if known else specimen + window_days,
                "known": known,
            }
        )
    known_count = sum(1 for interval in intervals if interval["known"])
    if len(intervals) < 2:
        return {"score": 0.0, "cases": len(intervals), "admissions_known": known_count}

    # A sweep per ward, as on the desktop: an interval overlaps another iff some earlier-starting
    # one has not yet ended, or the next one starts before this one ends. Same answer as comparing
    # every pair, without the quadratic cost a busy ward would impose.
    by_location: dict[str, list[tuple[int, int]]] = {}
    for interval in intervals:
        by_location.setdefault(interval["location"], []).append((interval["start"], interval["end"]))
    plausible = 0
    for bucket in by_location.values():
        bucket.sort()
        maximum_end_so_far = float("-inf")
        for index, (start, end) in enumerate(bucket):
            overlaps_earlier = maximum_end_so_far >= start
            overlaps_later = index + 1 < len(bucket) and bucket[index + 1][0] <= end
            if overlaps_earlier or overlaps_later:
                plausible += 1
            maximum_end_so_far = max(maximum_end_so_far, end)
    return {
        "score": round(plausible / len(intervals), 4),
        "cases": len(intervals),
        "admissions_known": known_count,
    }


def _stable_location(record: Mapping[str, Any]) -> str:
    return (
        _text(record.get("location"))
        or _text(record.get("department"))
        or _text(record.get("location_type"))
        or "Unknown location"
    )


def _day(value: Any) -> int | None:
    raw = _text(value)
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        return None
    from datetime import date

    year, month, day = (int(part) for part in raw.split("-"))
    try:
        return date(year, month, day).toordinal()
    except ValueError:
        return None


DEFAULT_SETTINGS: dict[str, Any] = {
    "aggregatePhenotypes": True,
    "models": "dual",
    "calibrateThreshold": True,
    "targetAlertsPerSiteYear": 1,
    "rerankByPlausibility": True,
    "plausibilityWindowDays": 14,
    "analysisType": "prospective",
    "target": "both",
    "baselineDays": 365,
    "maxClusterDays": 60,
    "deduplicationDays": 30,
    "minimumCases": 3,
    "minimumTested": 10,
    "permutations": 999,
    "recurrenceThresholdDays": 365,
}
