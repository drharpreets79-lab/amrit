"""One contract for every outbreak detector, mirrored from the desktop.

The desktop's ``app/src/main/detection/`` is the twin of this module. They must agree on
detector identifiers, on what each detector requires, and on how a denominator is derived,
because Phases 28 to 34 compare methods across both runtimes and a comparison whose two
sides disagree about the bookkeeping measures the bookkeeping.

``shared/golden-datasets/detector_reference.json`` is the fixture both read. What it pins
is deliberately limited to what is deterministic: descriptors, denominator derivation, and
the observed/expected/log-likelihood of a cluster. It does **not** pin p-values. The two
runtimes seed different generators — the desktop an FNV-1a/xorshift stream, this module a
SHA-256-seeded ``random.Random`` — so Monte Carlo p-values differ by simulation noise on
identical input. Pinning them would be pinning the generators together, which is a
stronger promise than either product needs and one that would break on any refactor.

## The portal cannot run a denominator-requiring detector, and Phase 29 decided not to fix it

Not a limitation of this module: the federation wire carries ``date``, ``signal_type``,
``signal_code``, ``organism_code``, ``organism``, ``antibiotic_code`` and ``count`` — the
number of *resistant* cases, and nothing about how many isolates were tested. Every model
Phase 29 adds needs a denominator, so none of them can run centrally as the contract stands.

Phase 27 flagged the choice; Phase 29 took it. Adding a tested count to the wire was
**deferred**, deliberately and not by omission — the reasoning is set out in
``scan_models.py``, and it turns on the fact that a second number per cell is a privacy
change rather than a schema change: a cell that is safe as "4 resistant" is not necessarily
safe as "4 resistant of 4 tested", which identifies a complete testing panel in a small ward.
So each of these detectors registers here and reports unavailable with a reason that names
the wire rather than the model, and points at the laboratory node where the denominator
already exists.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Iterable

from . import nonscan_models, pace, scan_models
from .outbreak_detection import CaseEvent, ScanSettings, scan

SPACE_TIME_PERMUTATION_ID = "space-time-permutation"


@dataclass(frozen=True)
class DetectorRequirements:
    denominators: bool
    coordinates: bool
    multiple_locations: bool


@dataclass(frozen=True)
class DetectorSupports:
    prospective: bool
    retrospective: bool


@dataclass(frozen=True)
class DetectorDescriptor:
    id: str
    name: str
    method: str
    family: str
    requires: DetectorRequirements
    supports: DetectorSupports
    blind_spot: str
    citation: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


SPACE_TIME_PERMUTATION = DetectorDescriptor(
    id=SPACE_TIME_PERMUTATION_ID,
    name="Space-time permutation scan",
    method="Kulldorff space-time permutation scan statistic",
    family="scan",
    requires=DetectorRequirements(denominators=False, coordinates=False, multiple_locations=True),
    supports=DetectorSupports(prospective=True, retrospective=True),
    blind_spot=(
        "Conditions on the location and time margins, so a rise that is uniform across "
        "every location leaves no interaction to find. The all-location category scan covers "
        "part of that case and not all of it."
    ),
    citation=(
        "Kulldorff M, et al. A Space-Time Permutation Scan Statistic for Disease Outbreak "
        "Detection. PLOS Medicine 2005;2:e59. doi:10.1371/journal.pmed.0020059"
    ),
)


@dataclass
class Detector:
    descriptor: DetectorDescriptor
    default_settings: Callable[[], dict[str, Any]]
    unavailable_reason: Callable[[dict[str, Any]], str | None]
    run: Callable[[dict[str, Any]], dict[str, Any]]


_REGISTRY: dict[str, Detector] = {}


def register_detector(detector: Detector) -> None:
    """Register a detector.

    A detector id is stored on every signal it has produced, so a collision is refused
    rather than resolved: replacing one would make old signals attribute to new behaviour.
    """
    existing = _REGISTRY.get(detector.descriptor.id)
    if existing is not None and existing is not detector:
        raise ValueError(
            f"Detector id {detector.descriptor.id!r} is already registered. "
            "Ids are stored on signals and must be unique."
        )
    _REGISTRY[detector.descriptor.id] = detector


def get_detector(detector_id: str) -> Detector:
    detector = _REGISTRY.get(detector_id)
    if detector is None:
        known = ", ".join(sorted(_REGISTRY)) or "none"
        raise KeyError(f"No detector {detector_id!r}. Registered: {known}")
    return detector


def list_detectors() -> list[Detector]:
    return list(_REGISTRY.values())


def describe_detectors() -> list[dict[str, Any]]:
    return [detector.descriptor.to_dict() for detector in _REGISTRY.values()]


def detector_availability(context: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for detector in _REGISTRY.values():
        reason = detector.unavailable_reason(context)
        rows.append(
            {
                "descriptor": detector.descriptor.to_dict(),
                "available": reason is None,
                "reason": reason or "",
            }
        )
    return rows


# ---------------------------------------------------------------------------------
# Denominators


@dataclass(frozen=True)
class DenominatorRow:
    date: str
    location: str
    organism_code: str
    antibiotic_code: str
    tested: int
    resistant: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _text(value: Any) -> str:
    return str(value if value is not None else "").strip()


def derive_denominators(records: Iterable[dict[str, Any]]) -> list[DenominatorRow]:
    """Tested and resistant counts per date, location, organism and agent.

    Mirrors ``deriveDenominators`` on the desktop, including its two judgements. An agent
    counts as tested when the record carries any of ``R``/``I``/``S`` for it, and ``I`` is
    **not** counted as resistant: the scan already refuses to merge it, so counting it here
    would make numerator and denominator disagree about what resistance means.
    """
    rows: dict[tuple[str, str, str, str], DenominatorRow] = {}

    def bump(date: str, location: str, organism: str, antibiotic: str, tested: int, resistant: int) -> None:
        key = (date, location, organism, antibiotic)
        current = rows.get(key)
        if current is None:
            rows[key] = DenominatorRow(date, location, organism, antibiotic, tested, resistant)
            return
        rows[key] = DenominatorRow(
            date, location, organism, antibiotic, current.tested + tested, current.resistant + resistant
        )

    for record in records:
        date = _text(record.get("specimen_date"))
        if len(date) != 10 or date[4] != "-" or date[7] != "-":
            continue
        organism_code = _text(record.get("organism_code")).upper() or _text(record.get("organism")).upper()
        if not organism_code:
            continue
        location = (
            _text(record.get("location"))
            or _text(record.get("department"))
            or _text(record.get("location_type"))
            or "Unknown location"
        )
        bump(date, location, organism_code, "", 1, 0)
        for raw_code, ast in (record.get("antibiotic_results") or {}).items():
            interpretation = _text((ast or {}).get("result")).upper()
            if interpretation not in {"R", "I", "S"}:
                continue
            bump(date, location, organism_code, _text(raw_code).upper(), 1, 1 if interpretation == "R" else 0)

    return sorted(rows.values(), key=lambda row: (row.date, row.location, row.organism_code, row.antibiotic_code))


def describe_denominator_coverage(rows: Iterable[DenominatorRow]) -> dict[str, Any]:
    rows = list(rows)
    agent_rows = [row for row in rows if row.antibiotic_code]
    return {
        "rows": len(rows),
        "dates": len({row.date for row in rows}),
        "locations": len({row.location for row in rows}),
        "organisms": len({row.organism_code for row in rows}),
        "testedPairs": len({f"{row.organism_code}:{row.antibiotic_code}" for row in agent_rows}),
        "totalTested": sum(row.tested for row in agent_rows),
        "totalResistant": sum(row.resistant for row in agent_rows),
        "unavailable": ["patient-days", "admissions", "occupied beds"],
    }


# ---------------------------------------------------------------------------------
# The detector this repository already had


def _stpss_default_settings() -> dict[str, Any]:
    settings = ScanSettings()
    return {
        "analysisType": settings.analysis_type,
        "target": settings.target,
        "baselineDays": settings.baseline_days,
        "maxClusterDays": settings.max_cluster_days,
        "minimumCases": settings.minimum_cases,
        "permutations": settings.permutations,
        "recurrenceThresholdDays": settings.recurrence_threshold_days,
    }


def _stpss_unavailable_reason(context: dict[str, Any]) -> str | None:
    events = context.get("events") or []
    if not events:
        return "No case events: this detector scans aggregated organism and phenotype counts."
    return None


def _stpss_run(context: dict[str, Any]) -> dict[str, Any]:
    events: list[CaseEvent] = list(context.get("events") or [])
    raw = context.get("settings") or {}
    settings = ScanSettings(
        analysis_type=raw.get("analysisType", ScanSettings.analysis_type),
        target=raw.get("target", ScanSettings.target),
        baseline_days=raw.get("baselineDays", ScanSettings.baseline_days),
        max_cluster_days=raw.get("maxClusterDays", ScanSettings.max_cluster_days),
        minimum_cases=raw.get("minimumCases", ScanSettings.minimum_cases),
        permutations=raw.get("permutations", ScanSettings.permutations),
        recurrence_threshold_days=raw.get("recurrenceThresholdDays", ScanSettings.recurrence_threshold_days),
    ).bounded()
    result = scan(events, settings, invalid_rows=int(context.get("invalid_rows") or 0))
    signals = [dict(signal, detector_id=SPACE_TIME_PERMUTATION_ID) for signal in result.get("signals", [])]
    return {
        "descriptor": SPACE_TIME_PERMUTATION.to_dict(),
        "settings": result.get("settings", {}),
        "signals": signals,
        "warnings": list(result.get("warnings", [])),
        "diagnostics": {
            "method": result.get("method"),
            "analysis_type": settings.analysis_type,
            "study_start": result.get("study_start"),
            "study_end": result.get("study_end"),
            "eligible_events": result.get("eligible_events"),
            "locations": result.get("locations"),
            "signals_tested": result.get("signals_tested"),
            # The p-value floor is 1/(permutations+1), so this is the largest recurrence
            # interval the run can produce. Below the configured alert threshold no alert
            # can fire at any cluster size, which the settings screen does not say.
            "maximum_reachable_recurrence_interval": settings.permutations + 1,
        },
    }


register_detector(
    Detector(
        descriptor=SPACE_TIME_PERMUTATION,
        default_settings=_stpss_default_settings,
        unavailable_reason=_stpss_unavailable_reason,
        run=_stpss_run,
    )
)

DEFAULT_DETECTOR_ID = SPACE_TIME_PERMUTATION_ID


# ---------------------------------------------------------------------------------
# Phase 29: the models SaTScan has that AMRIT did not
#
# Registered here so both runtimes agree on what exists, what each needs and what each cannot
# see. None of them can run on federated data as the wire contract stands — see the module
# comment in ``scan_models.py`` for the denominator decision and why it was deferred — so each
# reports unavailable with a reason that names the wire rather than the model, and points the
# operator at the laboratory node where the denominator already exists.

BERNOULLI_SPACE_TIME_ID = "bernoulli-space-time"
BERNOULLI_PURELY_TEMPORAL_ID = "bernoulli-purely-temporal"
BERNOULLI_PURELY_SPATIAL_ID = "bernoulli-purely-spatial"
POISSON_SPACE_TIME_ID = "poisson-space-time"
POISSON_PURELY_TEMPORAL_ID = "poisson-purely-temporal"
MULTIVARIATE_ID = "multivariate-bernoulli"

_KULLDORFF_1997 = (
    "Kulldorff M. A spatial scan statistic. Communications in Statistics: Theory and "
    "Methods 1997;26:1481-1496. doi:10.1080/03610929708831995"
)

BERNOULLI_SPACE_TIME = DetectorDescriptor(
    id=BERNOULLI_SPACE_TIME_ID,
    name="Bernoulli proportion scan, space-time",
    method="Kulldorff Bernoulli scan statistic on resistant-among-tested",
    family="scan",
    requires=DetectorRequirements(denominators=True, coordinates=False, multiple_locations=True),
    supports=DetectorSupports(prospective=True, retrospective=True),
    blind_spot=(
        "Sees the resistant share and not the count, so an outbreak that doubles the number of "
        "resistant isolates while testing doubles alongside it is invisible here and visible to "
        "the case-only permutation scan. The two are complementary, which is why Phase 31 runs both."
    ),
    citation=_KULLDORFF_1997,
)

BERNOULLI_PURELY_TEMPORAL = DetectorDescriptor(
    id=BERNOULLI_PURELY_TEMPORAL_ID,
    name="Bernoulli proportion scan, purely temporal",
    method="Kulldorff Bernoulli scan statistic on resistant-among-tested",
    family="scan",
    requires=DetectorRequirements(denominators=True, coordinates=False, multiple_locations=False),
    supports=DetectorSupports(prospective=True, retrospective=True),
    blind_spot=(
        "Collapses location, so a rise confined to one ward is diluted by every other ward and "
        "may not reach significance. It is the scan for a deployment that has one location, not "
        "a substitute for the space-time scan in one that has several."
    ),
    citation=_KULLDORFF_1997,
)

BERNOULLI_PURELY_SPATIAL = DetectorDescriptor(
    id=BERNOULLI_PURELY_SPATIAL_ID,
    name="Bernoulli proportion scan, purely spatial",
    method="Kulldorff Bernoulli scan statistic on resistant-among-tested",
    family="scan",
    requires=DetectorRequirements(denominators=True, coordinates=False, multiple_locations=True),
    # Retrospective only. The question is which wards carry excess resistance over the whole
    # period, and a prospective version of that question is the space-time scan.
    supports=DetectorSupports(prospective=False, retrospective=True),
    blind_spot=(
        "Collapses time, so a ward whose resistance rose sharply last month and was ordinary for "
        "the eleven before it is averaged back to ordinary. It ranks standing burden, not change."
    ),
    citation=_KULLDORFF_1997,
)

POISSON_SPACE_TIME = DetectorDescriptor(
    id=POISSON_SPACE_TIME_ID,
    name="Poisson rate scan, space-time",
    method="Kulldorff Poisson scan statistic on cases per population at risk",
    family="scan",
    requires=DetectorRequirements(denominators=True, coordinates=False, multiple_locations=True),
    supports=DetectorSupports(prospective=True, retrospective=True),
    blind_spot=(
        "Trusts the population series it is given. If a ward closes to admissions because of the "
        "outbreak, its patient-days fall, the expected count falls with them, and the excess is "
        "inflated by the response rather than the event. The Bernoulli model does not have this "
        "failure, and has others."
    ),
    citation=_KULLDORFF_1997,
)

POISSON_PURELY_TEMPORAL = DetectorDescriptor(
    id=POISSON_PURELY_TEMPORAL_ID,
    name="Poisson rate scan, purely temporal",
    method="Kulldorff Poisson scan statistic on cases per population at risk",
    family="scan",
    requires=DetectorRequirements(denominators=True, coordinates=False, multiple_locations=False),
    supports=DetectorSupports(prospective=True, retrospective=True),
    blind_spot=(
        "Collapses location, so a rise confined to one ward is diluted by every other. It also "
        "inherits the Poisson failure: a population series that responds to the outbreak moves "
        "the expectation in the same direction as the excess."
    ),
    citation=_KULLDORFF_1997,
)

MULTIVARIATE = DetectorDescriptor(
    id=MULTIVARIATE_ID,
    name="Multivariate proportion scan",
    method="Kulldorff multivariate scan statistic over Bernoulli streams, isolate-permutation null",
    family="scan",
    # Denominators are needed and come from the records themselves, because the null has to
    # move whole isolates and an aggregate row cannot say which isolate a resistance came from.
    requires=DetectorRequirements(denominators=True, coordinates=False, multiple_locations=False),
    supports=DetectorSupports(prospective=True, retrospective=True),
    blind_spot=(
        "Combines the agents of one organism, so an outbreak of a single-agent phenotype gains "
        "nothing here and pays the multiplicity of every other agent in the panel. It also "
        "inherits the Bernoulli blind spot: it sees the resistant share, not the count."
    ),
    citation=(
        "Kulldorff M, Mostashari F, Duczmal L, Yih WK, Kleinman K, Platt R. Multivariate scan "
        "statistics for disease surveillance. Statistics in Medicine 2007;26:1824-1833. "
        "doi:10.1002/sim.2818"
    ),
)

_WIRE_LIMIT = (
    "The federation wire carries the count of resistant cases and nothing about how many "
    "isolates were tested, so no proportion or rate model can run centrally. Run it at the "
    "laboratory node, which already holds the denominator."
)

_POPULATION_LIMIT = (
    "No population at risk. This model reports resistant cases per patient-day (or per "
    "admission, or per occupied bed); no laboratory record carries one and the federation wire "
    "does not carry one either. The deployment has to supply it from whatever system holds "
    "occupancy."
)

_RECORDS_LIMIT = (
    "No patient-level records. This model permutes whole isolates so that co-resistance "
    "survives into the null, which pre-aggregated counts cannot support, and the portal holds "
    "aggregates only by design. Run it at the laboratory node."
)


def _denominator_reason(context: dict[str, Any]) -> str | None:
    rows = context.get("denominators") or []
    if not rows:
        return _WIRE_LIMIT
    agent_rows = [row for row in rows if getattr(row, "antibiotic_code", "") and getattr(row, "tested", 0) > 0]
    if not agent_rows:
        return (
            "No susceptibility results: every isolate would be in the numerator and none in the "
            "denominator, so there is no proportion to scan."
        )
    return None


def _register_bernoulli(descriptor: DetectorDescriptor, shape: str) -> None:
    def default_settings() -> dict[str, Any]:
        settings = scan_models.BernoulliSettings()
        if shape == "purely-spatial":
            settings.analysis_type = "retrospective"
        return settings.to_dict()

    def unavailable_reason(context: dict[str, Any]) -> str | None:
        reason = _denominator_reason(context)
        if reason is not None:
            return reason
        if descriptor.requires.multiple_locations:
            locations = {getattr(row, "location", "") for row in context.get("denominators") or []}
            if len(locations) < 2:
                return (
                    f"Only one location: use {BERNOULLI_PURELY_TEMPORAL_ID}, which is the "
                    "proportion scan for a single-laboratory deployment."
                )
        return None

    def run(context: dict[str, Any]) -> dict[str, Any]:
        raw = dict(context.get("settings") or {})
        if shape == "purely-spatial":
            raw["analysisType"] = "retrospective"
        result = scan_models.scan_bernoulli(
            context.get("denominators") or [],
            settings=scan_models.BernoulliSettings.from_dict(raw),
            shape=shape,  # type: ignore[arg-type]
            organism_names=context.get("organism_names") or {},
            seed=context.get("seed"),
        )
        return {
            "descriptor": descriptor.to_dict(),
            "settings": dict(result["settings"], shape=result["shape"]),
            "signals": [dict(signal, detector_id=descriptor.id) for signal in result["signals"]],
            "warnings": list(result["warnings"]),
            "diagnostics": {
                "method": result["method"],
                "shape": result["shape"],
                "analysis_type": result["settings"]["analysisType"],
                "study_start": result["study_start"],
                "study_end": result["study_end"],
                "streams": result["streams"],
                "locations": result["locations"],
                "total_tested": result["total_tested"],
                "total_resistant": result["total_resistant"],
                "maximum_reachable_recurrence_interval": result["settings"]["permutations"] + 1,
            },
        }

    register_detector(Detector(descriptor, default_settings, unavailable_reason, run))


def _register_poisson(descriptor: DetectorDescriptor, shape: str) -> None:
    def default_settings() -> dict[str, Any]:
        return scan_models.PoissonSettings().to_dict()

    def unavailable_reason(context: dict[str, Any]) -> str | None:
        if not context.get("population"):
            return _POPULATION_LIMIT
        reason = _denominator_reason(context)
        if reason is not None:
            return reason
        if descriptor.requires.multiple_locations:
            locations = {getattr(row, "location", "") for row in context.get("population") or []}
            if len(locations) < 2:
                return f"Only one location in the population series: use {POISSON_PURELY_TEMPORAL_ID}."
        return None

    def run(context: dict[str, Any]) -> dict[str, Any]:
        result = scan_models.scan_poisson(
            context.get("denominators") or [],
            context.get("population") or [],
            settings=scan_models.PoissonSettings.from_dict(context.get("settings")),
            shape=shape,  # type: ignore[arg-type]
            organism_names=context.get("organism_names") or {},
            seed=context.get("seed"),
        )
        return {
            "descriptor": descriptor.to_dict(),
            "settings": dict(result["settings"], shape=result["shape"]),
            "signals": [dict(signal, detector_id=descriptor.id) for signal in result["signals"]],
            "warnings": list(result["warnings"]),
            "diagnostics": {
                "method": result["method"],
                "shape": result["shape"],
                "analysis_type": result["settings"]["analysisType"],
                "study_start": result["study_start"],
                "study_end": result["study_end"],
                "streams": result["streams"],
                "locations": result["locations"],
                "total_cases": result["total_cases"],
                "total_population": result["total_population"],
                "population_unit": result["population_unit"],
                "maximum_reachable_recurrence_interval": result["settings"]["permutations"] + 1,
            },
        }

    register_detector(Detector(descriptor, default_settings, unavailable_reason, run))


def _multivariate_unavailable(context: dict[str, Any]) -> str | None:
    if not context.get("records"):
        return _RECORDS_LIMIT
    return None


def _multivariate_run(context: dict[str, Any]) -> dict[str, Any]:
    # Unreachable while ``_multivariate_unavailable`` holds, and kept honest rather than
    # returning an empty result that would read as "no clusters found".
    raise NotImplementedError(_RECORDS_LIMIT)


# Registration order is the order an operator sees, and matches the desktop's registry.
_register_bernoulli(BERNOULLI_SPACE_TIME, "space-time")
_register_bernoulli(BERNOULLI_PURELY_TEMPORAL, "purely-temporal")
_register_bernoulli(BERNOULLI_PURELY_SPATIAL, "purely-spatial")
_register_poisson(POISSON_SPACE_TIME, "space-time")
_register_poisson(POISSON_PURELY_TEMPORAL, "purely-temporal")
register_detector(
    Detector(
        descriptor=MULTIVARIATE,
        default_settings=lambda: {
            "analysisType": "prospective",
            "baselineDays": 365,
            "maxClusterDays": 60,
            "minimumCases": 3,
            "minimumTested": 10,
            "permutations": 999,
            "recurrenceThresholdDays": 365,
            "grouping": "organism",
            "nullModel": "isolate",
        },
        unavailable_reason=_multivariate_unavailable,
        run=_multivariate_run,
    )
)

# ---------------------------------------------------------------------------------
# Phase 30: the families that are not scan statistics
#
# Unlike Phase 29, these are not uniformly unavailable centrally. EWMA and the Poisson CUSUM
# need a count per period and nothing else, which is exactly what the federation wire already
# carries, so the portal gains two detectors here rather than losing more. The Bernoulli CUSUM
# still needs the tested count the wire does not carry, and Farrington needs five years of
# history no deployment has yet. Each says which of those it is, because they call for
# different actions: one is a contract decision, the other is only time.

EWMA_ID = "ewma"
CUSUM_POISSON_ID = "cusum-poisson"
CUSUM_BERNOULLI_ID = "cusum-bernoulli"
FARRINGTON_ID = "farrington"
BAYESIAN_SCAN_ID = "bayesian-spatial-scan"

EWMA = DetectorDescriptor(
    id=EWMA_ID,
    name="EWMA control chart",
    method="Exponentially weighted moving average on period counts",
    family="process-control",
    requires=DetectorRequirements(denominators=False, coordinates=False, multiple_locations=False),
    supports=DetectorSupports(prospective=True, retrospective=True),
    blind_spot=(
        "Has no spatial dimension: a cluster spread over two wards is two half-strength "
        "series and may cross no limit, where a scan statistic pools them. The smoothing that makes "
        "it stable also damps a single very large period, and it corrects for no multiplicity at all."
    ),
    citation=(
        "Roberts SW. Control chart tests based on geometric moving averages. Technometrics "
        "1959;1:239-250. doi:10.1080/00401706.1959.10489860"
    ),
)

CUSUM_POISSON = DetectorDescriptor(
    id=CUSUM_POISSON_ID,
    name="Poisson CUSUM",
    method="Page cumulative sum on period counts, Lucas Poisson reference value",
    family="process-control",
    requires=DetectorRequirements(denominators=False, coordinates=False, multiple_locations=False),
    supports=DetectorSupports(prospective=True, retrospective=True),
    blind_spot=(
        "Says the process has shifted, not when: the accumulated sum carries no information "
        "about where in the run the change began, so the reported window is the run above the limit "
        "and not the outbreak. Counts only, so a rise in testing volume reads as a rise in resistance."
    ),
    citation=(
        "Page ES. Continuous inspection schemes. Biometrika 1954;41:100-115. doi:10.2307/2333009; "
        "Lucas JM. Counted data CUSUMs. Technometrics 1985;27:129-144. doi:10.1080/00401706.1985.10488030"
    ),
)

CUSUM_BERNOULLI = DetectorDescriptor(
    id=CUSUM_BERNOULLI_ID,
    name="Bernoulli CUSUM on the resistant proportion",
    method="Reynolds-Stoumbos Bernoulli cumulative sum on resistant-among-tested",
    family="process-control",
    requires=DetectorRequirements(denominators=True, coordinates=False, multiple_locations=False),
    supports=DetectorSupports(prospective=True, retrospective=True),
    blind_spot=(
        "Inherits every CUSUM limitation \u2014 no spatial pooling, no multiplicity correction, no "
        "statement of when the shift began \u2014 and adds a dependence on the baseline proportion being "
        "stable. A laboratory that changed its testing panel mid-series has changed p0 underneath the "
        "chart, and the chart cannot tell that from a change in resistance."
    ),
    citation=(
        "Reynolds MR, Stoumbos ZG. A general approach to modeling CUSUM charts for a proportion. "
        "IIE Transactions 2000;32:515-535. doi:10.1080/07408170008963928"
    ),
)

FARRINGTON = DetectorDescriptor(
    id=FARRINGTON_ID,
    name="Farrington aberration detection",
    method="Farrington 1996 quasi-Poisson regression on seasonal reference periods",
    family="regression",
    requires=DetectorRequirements(denominators=False, coordinates=False, multiple_locations=False),
    supports=DetectorSupports(prospective=True, retrospective=True),
    blind_spot=(
        "Needs years of history: with five reference years no period inside the first five years "
        "can be tested at all, and no corpus this repository generates is that long. Purely temporal, so a "
        "cluster split across two wards is two half-strength series. And its reweighting suppresses a "
        "sustained rise as readily as a past outbreak, so creeping resistance is absorbed into the "
        "baseline rather than detected."
    ),
    citation=(
        "Farrington CP, Andrews NJ, Beale AD, Catchpole MA. A statistical algorithm for the early "
        "detection of outbreaks of infectious disease. Journal of the Royal Statistical Society A "
        "1996;159:547-563. doi:10.2307/2983331"
    ),
)

BAYESIAN_SCAN = DetectorDescriptor(
    id=BAYESIAN_SCAN_ID,
    name="Bayesian spatial scan",
    method="Neill Gamma-Poisson Bayesian spatial scan statistic",
    family="bayesian",
    requires=DetectorRequirements(denominators=False, coordinates=False, multiple_locations=False),
    supports=DetectorSupports(prospective=True, retrospective=False),
    blind_spot=(
        "Its answer moves with a prior the data does not set, and unlike a p-value there is no "
        "convention to fall back on. It uses the same margin-conditioned baseline as the permutation "
        "scan and so inherits that blind spot: a rise uniform across every location is absorbed into "
        "the time margin. And the posterior is conditional on the outbreak being one of the regions "
        "enumerated, so it ranks the best of a bad set with the same confidence as a good one."
    ),
    citation=(
        "Neill DB, Moore AW, Cooper GF. A Bayesian spatial scan statistic. Advances in Neural "
        "Information Processing Systems 2005;18:1003-1010."
    ),
)

_NO_SERIES = (
    "No case events: these methods watch a series of counts through time and there is nothing here "
    "to watch."
)


def _series_reason(context: dict[str, Any]) -> str | None:
    if not (context.get("events") or context.get("denominators") or context.get("records")):
        return _NO_SERIES
    return None


def _chart_settings() -> dict[str, Any]:
    return {
        "periodDays": 7,
        "baselinePeriods": 26,
        "historyDays": 730,
        "lambda": 0.2,
        "limitSigma": 3,
        "cusumShift": 0.5,
        "cusumLimit": 4,
        "proportionShift": 1.5,
        "minimumTotalCases": 10,
        "minimumBaselineMean": 1,
    }


def _not_runnable_here(descriptor: DetectorDescriptor, reason: str):
    """Register a detector the portal knows about and cannot run.

    Registered rather than omitted so both runtimes agree on what exists: an operator comparing
    the two products must not conclude a method is missing when it is only unavailable, and the
    reason has to name what would have to change.
    """

    def run(context: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError(reason)

    register_detector(Detector(descriptor, _chart_settings, lambda _context: reason, run))


register_detector(
    Detector(
        descriptor=EWMA,
        default_settings=_chart_settings,
        unavailable_reason=_series_reason,
        run=lambda context: _run_chart(EWMA, "ewma", context),
    )
)
register_detector(
    Detector(
        descriptor=CUSUM_POISSON,
        default_settings=_chart_settings,
        unavailable_reason=_series_reason,
        run=lambda context: _run_chart(CUSUM_POISSON, "cusum-poisson", context),
    )
)
_not_runnable_here(
    CUSUM_BERNOULLI,
    "The federation wire carries the count of resistant cases and nothing about how many isolates "
    "were tested, so the proportion chart cannot run centrally. Run it at the laboratory node, which "
    "already holds the denominator.",
)
_not_runnable_here(
    FARRINGTON,
    "Farrington compares each period against the same period in previous years and needs five of "
    "them. No AMRIT deployment is five years old. This is a matter of time rather than of contract: "
    "nothing has to change for it to become available.",
)
_not_runnable_here(
    BAYESIAN_SCAN,
    "Not yet wired to the portal's site-level aggregate. The wire carries what this needs \u2014 a "
    "count, a date and a reporting site \u2014 so this is unfinished work rather than a limitation.",
)


def _run_chart(descriptor: DetectorDescriptor, chart: str, context: dict[str, Any]) -> dict[str, Any]:
    """Chart one aggregated national series.

    The portal has no wards, so there is one series per signal code rather than one per ward:
    the counts that cross the wire are already summed over the sites reporting them.
    """
    raw = dict(context.get("settings") or {})
    period_days = int(raw.get("periodDays", 7))
    baseline_periods = int(raw.get("baselinePeriods", 26))
    events = list(context.get("events") or [])
    by_day: dict[str, float] = {}
    for event in events:
        date = getattr(event, "date", None) or (event.get("date") if isinstance(event, dict) else None)
        count = getattr(event, "count", None) if not isinstance(event, dict) else event.get("count")
        if date is None:
            continue
        by_day[str(date)] = by_day.get(str(date), 0.0) + float(count or 0)
    ordered = [by_day[key] for key in sorted(by_day)]
    periods = nonscan_models.aggregate_periods(ordered, period_days)
    signals: list[dict[str, Any]] = []
    warnings: list[str] = [
        "A control chart corrects for no multiplicity. Compare against a scan statistic at a matched "
        "empirical false-alert rate, never at matched nominal limits.",
    ]
    if len(periods) > baseline_periods:
        baseline = sum(periods[:baseline_periods]) / baseline_periods
        if baseline > 0:
            if chart == "ewma":
                statistic, limits = nonscan_models.ewma_chart(
                    periods, baseline, math.sqrt(baseline), float(raw.get("lambda", 0.2)),
                    float(raw.get("limitSigma", 3)))
            else:
                reference = nonscan_models.poisson_reference(baseline, float(raw.get("cusumShift", 0.5)))
                statistic = nonscan_models.cusum_chart(periods, reference)
                limits = [float(raw.get("cusumLimit", 4)) * math.sqrt(baseline)] * len(statistic)
            for index in range(baseline_periods, len(statistic)):
                if statistic[index] > limits[index]:
                    signals.append({
                        "period": index,
                        "observed": periods[index],
                        "baseline": round(baseline, 3),
                        "statistic": round(statistic[index], 3),
                        "limit": round(limits[index], 3),
                        "detector_id": descriptor.id,
                    })
    else:
        warnings.append(
            f"Only {len(periods)} complete periods and {baseline_periods} are needed for the baseline."
        )
    return {
        "descriptor": descriptor.to_dict(),
        "settings": {**_chart_settings(), **raw},
        "signals": signals,
        "warnings": warnings,
        "diagnostics": {
            "method": descriptor.method,
            "chart": chart,
            "periods": len(periods),
            "baseline_periods": baseline_periods,
            "maximum_reachable_recurrence_interval": 0,
        },
    }


# ---------------------------------------------------------------------------------
# Phase 31: PACE, the detector this repository proposes
#
# It is registered here and it cannot run here, and the two facts are worth separating. The
# rules PACE is made of — the mechanism an agent belongs to, the counting rule that makes an
# isolate resistant to three carbapenems one carbapenem-resistant case, the Šidák correction,
# the alert threshold that spends a stated budget, the plausibility score — are all mirrored in
# ``pace.py`` and pinned by the shared fixture, because a rule that lives in one runtime drifts.
#
# What cannot cross the wire is the isolate. Pooling agents into a mechanism needs to know which
# resistances came from the same specimen, and an aggregate row of "4 resistant on 3 March" cannot
# say. That is the Phase 27 blocker again, and it bites harder here than it did on the Bernoulli
# model: adding a tested count to the contract would make the proportion arm possible and would
# still leave phenotype aggregation impossible.

PACE_ID = pace.PACE_ID

PACE = DetectorDescriptor(
    id=PACE_ID,
    name="PACE (phenotype-aggregated cluster evaluation)",
    method=(
        "Phenotype-aggregated dual-model scan: Kulldorff space-time permutation and Bernoulli "
        "proportion scans over mechanism-level streams, combined by Šidák correction"
    ),
    family="scan",
    requires=DetectorRequirements(denominators=True, coordinates=False, multiple_locations=False),
    supports=DetectorSupports(prospective=True, retrospective=True),
    blind_spot=(
        "Pools agents by the catalogue's mechanism class, so it mis-pools wherever that class "
        "does not match the mechanism for an organism — carbapenem resistance in Pseudomonas "
        "aeruginosa is often porin loss rather than a transmissible carbapenemase. It also "
        "inherits both parents' limits: a rise uniform across every ward leaves the case-only arm "
        "nothing to find, and the proportion arm cannot see an outbreak whose testing volume rose "
        "with it."
    ),
    citation="",
)

_PACE_REASON = (
    "PACE pools each isolate's agents into the mechanism they are evidence of, and the federation "
    "wire carries aggregate counts rather than isolates — a row of resistant cases cannot say "
    "which of them came from the same specimen, so the pooling cannot be done after the fact. The "
    "wire also carries no tested count, which the proportion arm needs. Run PACE at the laboratory "
    "node, which holds both."
)


def _pace_unavailable(_context: dict[str, Any]) -> str | None:
    return _PACE_REASON


def _pace_run(_context: dict[str, Any]) -> dict[str, Any]:
    raise NotImplementedError(_PACE_REASON)


register_detector(
    Detector(
        descriptor=PACE,
        default_settings=lambda: dict(pace.DEFAULT_SETTINGS),
        unavailable_reason=_pace_unavailable,
        run=_pace_run,
    )
)
