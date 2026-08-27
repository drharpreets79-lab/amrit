"""The scan models Phase 29 adds, mirrored from the desktop.

``app/src/main/detection/bernoulli.ts`` and ``poisson.ts`` are the twins of this module.
They must agree on the statistic, on which window each shape selects, and on what counts as
tested, because Phase 33 compares detectors across both runtimes and a comparison whose two
sides disagree about the arithmetic measures the arithmetic.

``shared/golden-datasets/detector_reference.json`` pins what is deterministic: the
log-likelihood ratios on worked cases, and the cluster each shape selects with its observed,
tested and ratio. It does **not** pin p-values, for the reason recorded in ``detectors.py``:
the two runtimes seed different generators, so Monte Carlo p-values differ by simulation
noise on identical input.

## The federation wire, and why these cannot run centrally today

Phase 27 recorded a blocker for this phase and it is resolved here by decision rather than by
code. The wire carries ``date``, ``signal_type``, ``signal_code``, ``organism_code``,
``organism``, ``antibiotic_code`` and ``count`` — the number of *resistant* cases. Every model
in this module needs a denominator the wire does not carry, so none of them can run on
federated data as the contract stands.

Adding a tested count to the wire was considered and **deferred out of Phase 29**, for three
reasons worth stating rather than leaving as silence:

* It is a privacy change, not a schema change. A second number per cell means k-anonymity
  suppression has to be recomputed over pairs rather than counts, and a cell that is safe as
  "4 resistant" may not be safe as "4 resistant of 4 tested" — the latter identifies a
  complete testing panel in a small ward.
* It is a contract version bump across two products, with a migration for every enrolled site,
  and Phase 21 has not yet shipped a release path that can carry one.
* Nothing in Phase 29's exit criteria needs it. The models are verified against SaTScan and a
  shared fixture at the laboratory node, where the denominator already exists.

So the portal registers these detectors and reports them unavailable, with the reason naming
the wire rather than the model. An operator reading the portal is told what is missing and
where the scan can be run instead. The scans themselves are implemented and tested here so
that the two runtimes are provably computing the same statistic when a caller does have
denominators — the benchmark harness of Phase 33 being the first such caller.
"""

from __future__ import annotations

import math
import random
from dataclasses import asdict, dataclass, field
from datetime import date as date_type
from typing import TYPE_CHECKING, Any, Iterable, Literal, Sequence

if TYPE_CHECKING:  # ``detectors`` imports this module, so the type is not imported at runtime.
    from .detectors import DenominatorRow

BernoulliShape = Literal["space-time", "purely-temporal", "purely-spatial"]
PoissonShape = Literal["space-time", "purely-temporal", "purely-spatial"]


@dataclass(frozen=True)
class PopulationRow:
    """Population at risk for one date and location.

    The denominator the Poisson model needs and no laboratory record carries. An isolate says
    a specimen was taken; it says nothing about how many patients were there to take it from.
    """

    date: str
    location: str
    population: float
    unit: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _parse_day(value: str) -> int | None:
    try:
        return date_type.fromisoformat(value).toordinal()
    except (TypeError, ValueError):
        return None


def _day_key(ordinal: int) -> str:
    return date_type.fromordinal(ordinal).isoformat()


def _clamp(value: Any, low: int, high: int, fallback: int) -> int:
    try:
        candidate = int(value)
    except (TypeError, ValueError):
        candidate = fallback
    return max(low, min(high, candidate))


def _round(value: float, digits: int = 4) -> float:
    return float(f"{value:.{digits}f}")


def _signal_id(parts: Sequence[Any]) -> str:
    """FNV-1a over the joined parts, as the desktop does, so ids match on identical input."""
    text = "|".join(str(part) for part in parts)
    digest = 0x811C9DC5
    for character in text:
        digest ^= ord(character) & 0xFFFFFFFF
        digest = (digest * 0x01000193) & 0xFFFFFFFF
    return f"{digest:08x}"


# ---------------------------------------------------------------------------------
# Bernoulli


def _xlogxy(x: float, y: float) -> float:
    return 0.0 if x <= 0 else x * math.log(x / y)


def bernoulli_log_likelihood_ratio(cases: float, tested: float, total_cases: float, total_tested: float) -> float:
    """Kulldorff's Bernoulli statistic on resistant-among-tested.

    Evaluated only where the inside proportion exceeds the outside one: AMRIT scans for high
    rates, and a ward with unusually *low* resistance is not an outbreak.
    """
    outside_tested = total_tested - tested
    outside_cases = total_cases - cases
    if tested <= 0 or outside_tested <= 0 or total_cases <= 0 or total_cases >= total_tested:
        return 0.0
    if cases / tested <= outside_cases / outside_tested:
        return 0.0
    inside = _xlogxy(cases, tested) + _xlogxy(tested - cases, tested)
    outside = _xlogxy(outside_cases, outside_tested) + _xlogxy(outside_tested - outside_cases, outside_tested)
    overall = _xlogxy(total_cases, total_tested) + _xlogxy(total_tested - total_cases, total_tested)
    llr = inside + outside - overall
    return llr if math.isfinite(llr) and llr > 0 else 0.0


@dataclass
class BernoulliSettings:
    analysis_type: str = "prospective"
    baseline_days: int = 365
    max_cluster_days: int = 60
    minimum_cases: int = 3
    # Three resistant out of three tested is 100% and means nothing. The permutation scan has
    # no equivalent guard because it never looks at a denominator.
    minimum_tested: int = 10
    permutations: int = 999
    recurrence_threshold_days: int = 365

    def bounded(self) -> "BernoulliSettings":
        return BernoulliSettings(
            analysis_type="retrospective" if self.analysis_type == "retrospective" else "prospective",
            baseline_days=_clamp(self.baseline_days, 30, 3650, 365),
            max_cluster_days=_clamp(self.max_cluster_days, 1, 365, 60),
            minimum_cases=_clamp(self.minimum_cases, 2, 100, 3),
            minimum_tested=_clamp(self.minimum_tested, 2, 10_000, 10),
            permutations=_clamp(self.permutations, 19, 9999, 999),
            recurrence_threshold_days=_clamp(self.recurrence_threshold_days, 20, 100_000, 365),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "analysisType": self.analysis_type,
            "baselineDays": self.baseline_days,
            "maxClusterDays": self.max_cluster_days,
            "minimumCases": self.minimum_cases,
            "minimumTested": self.minimum_tested,
            "permutations": self.permutations,
            "recurrenceThresholdDays": self.recurrence_threshold_days,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> "BernoulliSettings":
        raw = raw or {}
        return cls(
            analysis_type=raw.get("analysisType", "prospective"),
            baseline_days=raw.get("baselineDays", 365),
            max_cluster_days=raw.get("maxClusterDays", 60),
            minimum_cases=raw.get("minimumCases", 3),
            minimum_tested=raw.get("minimumTested", 10),
            permutations=raw.get("permutations", 999),
            recurrence_threshold_days=raw.get("recurrenceThresholdDays", 365),
        ).bounded()


@dataclass
class _Cell:
    day: int
    location: str
    tested: int
    cases: int


@dataclass
class _Stream:
    organism_code: str
    antibiotic_code: str
    cells: list[_Cell] = field(default_factory=list)


@dataclass
class _Candidate:
    stream: _Stream
    location: str
    start: int
    end: int
    cases: int
    tested: int
    llr: float


def _permute_cases(cells: Sequence[_Cell], total_cases: int, total_tested: int, rng: random.Random) -> list[int]:
    """Sequential hypergeometric: each cell keeps its tested count, only labels move."""
    drawn = [0] * len(cells)
    cases_left = total_cases
    tested_left = total_tested
    for index, cell in enumerate(cells):
        taken = 0
        for _ in range(cell.tested):
            if tested_left <= 0:
                break
            if rng.random() < cases_left / tested_left:
                taken += 1
                cases_left -= 1
            tested_left -= 1
        drawn[index] = taken
    return drawn


def _scan_stream_bernoulli(
    stream: _Stream, counts: Sequence[int], study_days: int,
    settings: BernoulliSettings, shape: BernoulliShape, collect: bool,
) -> tuple[float, list[_Candidate]]:
    total_cases = sum(counts)
    total_tested = sum(cell.tested for cell in stream.cells)
    if total_cases < settings.minimum_cases or total_tested < settings.minimum_tested:
        return 0.0, []

    # Purely spatial collapses time; purely temporal collapses location. Both are the same
    # scan with one dimension held whole, which is why they share this function.
    groups: dict[str, tuple[list[int], list[int]]] = {}
    for index, cell in enumerate(stream.cells):
        key = "All locations" if shape == "purely-temporal" else cell.location
        bucket = groups.setdefault(key, ([0] * study_days, [0] * study_days))
        if 0 <= cell.day < study_days:
            bucket[0][cell.day] += counts[index] if index < len(counts) else 0
            bucket[1][cell.day] += cell.tested

    if shape == "purely-spatial":
        maximum_days = study_days
        ends = [study_days - 1]
    else:
        maximum_days = max(1, min(settings.max_cluster_days, max(1, study_days // 2)))
        ends = [study_days - 1] if settings.analysis_type == "prospective" else list(range(study_days))

    maximum = 0.0
    candidates: list[_Candidate] = []
    for location, (case_series, tested_series) in groups.items():
        for end in ends:
            cases = 0
            tested = 0
            limit = study_days if shape == "purely-spatial" else maximum_days
            for length in range(1, min(limit, end + 1) + 1):
                start = end - length + 1
                cases += case_series[start]
                tested += tested_series[start]
                if shape == "purely-spatial" and length < limit and start > 0:
                    continue
                if cases < settings.minimum_cases or tested < settings.minimum_tested:
                    continue
                llr = bernoulli_log_likelihood_ratio(cases, tested, total_cases, total_tested)
                if llr <= 0:
                    continue
                maximum = max(maximum, llr)
                if collect:
                    candidates.append(_Candidate(stream, location, start, end, cases, tested, llr))
    return maximum, candidates


def scan_bernoulli(
    denominators: Iterable["DenominatorRow"],
    settings: BernoulliSettings | None = None,
    shape: BernoulliShape = "space-time",
    organism_names: dict[str, str] | None = None,
    seed: int | None = None,
) -> dict[str, Any]:
    settings = (settings or BernoulliSettings()).bounded()
    names = organism_names or {}

    # Only agent-level rows carry a denominator; the organism-level rows exist for detectors
    # that need an isolate count and are not a numerator for anything.
    rows = [row for row in denominators if row.antibiotic_code and row.tested > 0]
    days = [day for day in (_parse_day(row.date) for row in rows) if day is not None]
    if not days:
        return {
            "method": "Kulldorff Bernoulli scan statistic", "shape": shape,
            "settings": settings.to_dict(), "study_start": None, "study_end": None,
            "streams": 0, "locations": 0, "total_tested": 0, "total_resistant": 0, "signals": [],
            "warnings": ["No denominators: nothing was tested, so there is no proportion to scan."],
        }

    study_end = max(days)
    study_start = max(min(days), study_end - (settings.baseline_days - 1))
    study_days = study_end - study_start + 1
    bounded = [row for row in rows if (_parse_day(row.date) or 0) >= study_start]

    streams: dict[str, _Stream] = {}
    for row in bounded:
        key = f"{row.organism_code}:{row.antibiotic_code}"
        stream = streams.setdefault(key, _Stream(row.organism_code, row.antibiotic_code))
        stream.cells.append(_Cell((_parse_day(row.date) or 0) - study_start, row.location, row.tested, row.resistant))

    stream_list = list(streams.values())
    rng = random.Random(seed if seed is not None else _stable_seed(settings.to_dict(), shape, bounded))

    observed: list[_Candidate] = []
    for stream in stream_list:
        counts = [cell.cases for cell in stream.cells]
        observed.extend(_scan_stream_bernoulli(stream, counts, study_days, settings, shape, True)[1])
    observed.sort(key=lambda candidate: (-candidate.llr, -candidate.cases))

    simulated: list[float] = []
    for _ in range(settings.permutations):
        maximum = 0.0
        for stream in stream_list:
            total_cases = sum(cell.cases for cell in stream.cells)
            total_tested = sum(cell.tested for cell in stream.cells)
            if total_cases < settings.minimum_cases or total_tested < settings.minimum_tested:
                continue
            counts = _permute_cases(stream.cells, total_cases, total_tested, rng)
            maximum = max(maximum, _scan_stream_bernoulli(stream, counts, study_days, settings, shape, False)[0])
        simulated.append(maximum)

    selected: list[_Candidate] = []
    for candidate in observed:
        if any(
            current.stream is candidate.stream and current.location == candidate.location
            and candidate.start <= current.end and candidate.end >= current.start
            for current in selected
        ):
            continue
        selected.append(candidate)

    signals = []
    for candidate in selected:
        exceedances = sum(1 for value in simulated if value >= candidate.llr - 1e-12)
        p_value = (exceedances + 1) / (settings.permutations + 1)
        if p_value > 0.05:
            continue
        recurrence = 1 / p_value
        total_cases = sum(cell.cases for cell in candidate.stream.cells)
        total_tested = sum(cell.tested for cell in candidate.stream.cells)
        outside_tested = total_tested - candidate.tested
        baseline = (total_cases - candidate.cases) / outside_tested if outside_tested > 0 else 0.0
        proportion = candidate.cases / candidate.tested if candidate.tested > 0 else 0.0
        signals.append({
            "signal_id": _signal_id([
                candidate.stream.organism_code, candidate.stream.antibiotic_code,
                candidate.location, candidate.start, candidate.end,
            ]),
            "status": "alert" if recurrence >= settings.recurrence_threshold_days else "monitor",
            "organism": names.get(candidate.stream.organism_code, candidate.stream.organism_code),
            "antibiotic": candidate.stream.antibiotic_code,
            "scope": {
                "space-time": "Location proportion cluster",
                "purely-temporal": "All-location proportion cluster",
                "purely-spatial": "Location proportion excess",
            }[shape],
            "location": candidate.location,
            "start_date": _day_key(study_start + candidate.start),
            "end_date": _day_key(study_start + candidate.end),
            "days": candidate.end - candidate.start + 1,
            "observed": candidate.cases,
            "tested": candidate.tested,
            "proportion": _round(proportion),
            "baseline_proportion": _round(baseline),
            "proportion_ratio": _round(proportion / baseline, 2) if baseline > 0 else 0,
            "log_likelihood_ratio": _round(candidate.llr, 3),
            "p_value": _round(p_value),
            "recurrence_interval_days": _round(recurrence, 1),
        })
        if len(signals) >= 50:
            break

    warnings: list[str] = []
    if study_days < 60:
        warnings.append("Fewer than 60 study days: the baseline proportion may be unstable.")
    if settings.permutations < 999:
        warnings.append(
            "Fewer than 999 Monte Carlo replications: the highest reachable recurrence interval is "
            f"{settings.permutations + 1} days, so no alert can fire above that threshold."
        )
    if shape == "space-time" and len({row.location for row in bounded}) < 2:
        warnings.append(
            "Only one location: use the purely temporal shape, which is what a single-laboratory "
            "deployment needs and which the space-time scan cannot provide."
        )

    return {
        "method": "Kulldorff Bernoulli scan statistic",
        "shape": shape,
        "settings": settings.to_dict(),
        "study_start": _day_key(study_start),
        "study_end": _day_key(study_end),
        "streams": len(stream_list),
        "locations": len({row.location for row in bounded}),
        "total_tested": sum(row.tested for row in bounded),
        "total_resistant": sum(row.resistant for row in bounded),
        "signals": signals,
        "warnings": warnings,
    }


def _stable_seed(settings: dict[str, Any], shape: str, rows: Sequence["DenominatorRow"]) -> int:
    """A seed derived from the input and never from the clock.

    A benchmark that cannot be repeated is not evidence. This is not the desktop's generator
    and is not expected to produce the desktop's p-values; it is expected to produce the same
    p-values on the same input twice.
    """
    material = repr((sorted(settings.items()), shape, [
        (row.date, row.location, row.organism_code, row.antibiotic_code, row.tested, row.resistant)
        for row in rows
    ]))
    digest = 0x811C9DC5
    for character in material:
        digest ^= ord(character) & 0xFFFFFFFF
        digest = (digest * 0x01000193) & 0xFFFFFFFF
    return digest


# ---------------------------------------------------------------------------------
# Poisson


def poisson_log_likelihood_ratio(cases: float, expected: float, total_cases: float) -> float:
    """Kulldorff's Poisson statistic on cases per population at risk.

    High rates only: a ward with unusually few resistant infections per patient-day is good
    news, and reporting it beside an outbreak would bury the outbreak.
    """
    outside_cases = total_cases - cases
    outside_expected = total_cases - expected
    if expected <= 0 or outside_expected <= 0 or total_cases <= 0 or cases <= expected:
        return 0.0
    inside = cases * math.log(cases / expected)
    outside = outside_cases * math.log(outside_cases / outside_expected) if outside_cases > 0 else 0.0
    llr = inside + outside
    return llr if math.isfinite(llr) and llr > 0 else 0.0


@dataclass
class PoissonSettings:
    analysis_type: str = "prospective"
    baseline_days: int = 365
    max_cluster_days: int = 60
    minimum_cases: int = 3
    minimum_expected: float = 0.5
    permutations: int = 999
    recurrence_threshold_days: int = 365

    def bounded(self) -> "PoissonSettings":
        return PoissonSettings(
            analysis_type="retrospective" if self.analysis_type == "retrospective" else "prospective",
            baseline_days=_clamp(self.baseline_days, 30, 3650, 365),
            max_cluster_days=_clamp(self.max_cluster_days, 1, 365, 60),
            minimum_cases=_clamp(self.minimum_cases, 2, 100, 3),
            minimum_expected=max(0.01, min(100.0, float(self.minimum_expected))),
            permutations=_clamp(self.permutations, 19, 9999, 999),
            recurrence_threshold_days=_clamp(self.recurrence_threshold_days, 20, 100_000, 365),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "analysisType": self.analysis_type,
            "baselineDays": self.baseline_days,
            "maxClusterDays": self.max_cluster_days,
            "minimumCases": self.minimum_cases,
            "minimumExpected": self.minimum_expected,
            "permutations": self.permutations,
            "recurrenceThresholdDays": self.recurrence_threshold_days,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> "PoissonSettings":
        raw = raw or {}
        return cls(
            analysis_type=raw.get("analysisType", "prospective"),
            baseline_days=raw.get("baselineDays", 365),
            max_cluster_days=raw.get("maxClusterDays", 60),
            minimum_cases=raw.get("minimumCases", 3),
            minimum_expected=raw.get("minimumExpected", 0.5),
            permutations=raw.get("permutations", 999),
            recurrence_threshold_days=raw.get("recurrenceThresholdDays", 365),
        ).bounded()


def scan_poisson(
    denominators: Iterable["DenominatorRow"],
    population: Iterable[PopulationRow],
    settings: PoissonSettings | None = None,
    shape: PoissonShape = "space-time",
    organism_names: dict[str, str] | None = None,
    seed: int | None = None,
) -> dict[str, Any]:
    settings = (settings or PoissonSettings()).bounded()
    names = organism_names or {}

    def empty(warning: str) -> dict[str, Any]:
        return {
            "method": "Kulldorff Poisson scan statistic", "shape": shape,
            "settings": settings.to_dict(), "study_start": None, "study_end": None,
            "streams": 0, "locations": 0, "total_cases": 0, "total_population": 0,
            "population_unit": "", "signals": [], "warnings": [warning],
        }

    population_rows = [row for row in population if row.population > 0]
    if not population_rows:
        return empty(
            "No population at risk was supplied. This model reports cases per patient-day (or per "
            "admission, or per occupied bed) and a laboratory record does not carry one."
        )
    case_rows = [row for row in denominators if row.antibiotic_code and row.resistant > 0]
    if not case_rows:
        return empty("No resistant isolates: there is nothing for a rate to be a rate of.")

    all_days = [
        day for day in
        ([_parse_day(row.date) for row in population_rows] + [_parse_day(row.date) for row in case_rows])
        if day is not None
    ]
    if not all_days:
        return empty("No valid dates in the population or case rows.")
    study_end = max(all_days)
    study_start = max(min(all_days), study_end - (settings.baseline_days - 1))
    study_days = study_end - study_start + 1

    grid: dict[str, list[float]] = {}
    units: set[str] = set()
    total_population = 0.0
    for row in population_rows:
        day = _parse_day(row.date)
        if day is None:
            continue
        offset = day - study_start
        if not 0 <= offset < study_days:
            continue
        series = grid.setdefault(row.location, [0.0] * study_days)
        series[offset] += row.population
        total_population += row.population
        units.add(row.unit or "population")
    if total_population <= 0:
        return empty(
            "The population rows fall outside the study window, so no window has an expected count."
        )

    streams: dict[str, _Stream] = {}
    orphan_cases = 0
    for row in case_rows:
        day = _parse_day(row.date)
        if day is None:
            continue
        offset = day - study_start
        if not 0 <= offset < study_days:
            continue
        if row.location not in grid:
            orphan_cases += row.resistant
            continue
        key = f"{row.organism_code}:{row.antibiotic_code}"
        stream = streams.setdefault(key, _Stream(row.organism_code, row.antibiotic_code))
        stream.cells.append(_Cell(offset, row.location, 0, row.resistant))

    stream_list = list(streams.values())
    rng = random.Random(seed if seed is not None else _stable_seed(settings.to_dict(), shape, case_rows))

    def scan_stream(stream: _Stream, counts: Sequence[int], collect: bool) -> tuple[float, list[tuple[Any, ...]]]:
        total_cases = sum(counts)
        if total_cases < settings.minimum_cases:
            return 0.0, []
        groups: dict[str, tuple[list[float], list[float]]] = {}
        for location, series in grid.items():
            key = "All locations" if shape == "purely-temporal" else location
            bucket = groups.setdefault(key, ([0.0] * study_days, [0.0] * study_days))
            for day in range(study_days):
                bucket[1][day] += series[day]
        for index, cell in enumerate(stream.cells):
            key = "All locations" if shape == "purely-temporal" else cell.location
            bucket = groups.get(key)
            if bucket is None or not 0 <= cell.day < study_days:
                continue
            bucket[0][cell.day] += counts[index] if index < len(counts) else 0

        if shape == "purely-spatial":
            maximum_days = study_days
            ends = [study_days - 1]
        else:
            maximum_days = max(1, min(settings.max_cluster_days, max(1, study_days // 2)))
            ends = [study_days - 1] if settings.analysis_type == "prospective" else list(range(study_days))

        maximum = 0.0
        found: list[tuple[Any, ...]] = []
        for location, (case_series, population_series) in groups.items():
            for end in ends:
                cases = 0.0
                pop = 0.0
                limit = study_days if shape == "purely-spatial" else maximum_days
                for length in range(1, min(limit, end + 1) + 1):
                    start = end - length + 1
                    cases += case_series[start]
                    pop += population_series[start]
                    if shape == "purely-spatial" and length < limit and start > 0:
                        continue
                    if cases < settings.minimum_cases:
                        continue
                    expected = total_cases * (pop / total_population)
                    if expected < settings.minimum_expected:
                        continue
                    llr = poisson_log_likelihood_ratio(cases, expected, total_cases)
                    if llr <= 0:
                        continue
                    maximum = max(maximum, llr)
                    if collect:
                        found.append((stream, location, start, end, int(cases), expected, pop, llr))
        return maximum, found

    observed: list[tuple[Any, ...]] = []
    weights_by_stream: dict[int, list[float]] = {}
    for stream in stream_list:
        observed.extend(scan_stream(stream, [cell.cases for cell in stream.cells], True)[1])
        weights_by_stream[id(stream)] = [
            grid.get(cell.location, [0.0] * study_days)[cell.day] if 0 <= cell.day < study_days else 0.0
            for cell in stream.cells
        ]
    observed.sort(key=lambda item: (-item[7], -item[4]))

    simulated: list[float] = []
    for _ in range(settings.permutations):
        maximum = 0.0
        for stream in stream_list:
            total_cases = sum(cell.cases for cell in stream.cells)
            if total_cases < settings.minimum_cases:
                continue
            weights = weights_by_stream[id(stream)]
            weight_total = sum(weights)
            if weight_total <= 0:
                continue
            counts = _allocate_cases(weights, total_cases, weight_total, rng)
            maximum = max(maximum, scan_stream(stream, counts, False)[0])
        simulated.append(maximum)

    selected: list[tuple[Any, ...]] = []
    for candidate in observed:
        if any(
            current[0] is candidate[0] and current[1] == candidate[1]
            and candidate[2] <= current[3] and candidate[3] >= current[2]
            for current in selected
        ):
            continue
        selected.append(candidate)

    population_unit = next(iter(units)) if len(units) == 1 else "mixed population units"
    signals = []
    for stream, location, start, end, cases, expected, pop, llr in selected:
        exceedances = sum(1 for value in simulated if value >= llr - 1e-12)
        p_value = (exceedances + 1) / (settings.permutations + 1)
        if p_value > 0.05:
            continue
        recurrence = 1 / p_value
        total_cases = sum(cell.cases for cell in stream.cells)
        outside_population = total_population - pop
        signals.append({
            "signal_id": _signal_id([stream.organism_code, stream.antibiotic_code, location, start, end]),
            "status": "alert" if recurrence >= settings.recurrence_threshold_days else "monitor",
            "organism": names.get(stream.organism_code, stream.organism_code),
            "antibiotic": stream.antibiotic_code,
            "scope": {
                "space-time": "Location rate cluster",
                "purely-temporal": "All-location rate cluster",
                "purely-spatial": "Location rate excess",
            }[shape],
            "location": location,
            "start_date": _day_key(study_start + start),
            "end_date": _day_key(study_start + end),
            "days": end - start + 1,
            "observed": cases,
            "expected": _round(expected, 2),
            "excess": _round(cases - expected, 2),
            "observed_expected_ratio": _round(cases / expected, 2) if expected > 0 else 0,
            "population": _round(pop, 2),
            "population_unit": population_unit,
            "rate": _round(cases / pop, 6) if pop > 0 else 0,
            "baseline_rate": _round((total_cases - cases) / outside_population, 6) if outside_population > 0 else 0,
            "log_likelihood_ratio": _round(llr, 3),
            "p_value": _round(p_value),
            "recurrence_interval_days": _round(recurrence, 1),
        })
        if len(signals) >= 50:
            break

    warnings: list[str] = []
    if study_days < 60:
        warnings.append("Fewer than 60 study days: the baseline rate may be unstable.")
    if settings.permutations < 999:
        warnings.append(
            "Fewer than 999 Monte Carlo replications: the highest reachable recurrence interval is "
            f"{settings.permutations + 1} days, so no alert can fire above that threshold."
        )
    if orphan_cases > 0:
        warnings.append(
            f"{orphan_cases} resistant isolates are in locations with no population series and were "
            "excluded. A case with no denominator cannot be given an expected count, and assigning it "
            "to another location would invent one."
        )
    if len(units) > 1:
        warnings.append(
            f"The population rows mix {len(units)} units ({', '.join(sorted(units))}). The scan compares "
            "population shares, so mixing units silently reweights locations against each other."
        )
    if shape == "space-time" and len(grid) < 2:
        warnings.append("Only one location: use the purely temporal shape.")

    return {
        "method": "Kulldorff Poisson scan statistic",
        "shape": shape,
        "settings": settings.to_dict(),
        "study_start": _day_key(study_start),
        "study_end": _day_key(study_end),
        "streams": len(stream_list),
        "locations": len(grid),
        "total_cases": sum(sum(cell.cases for cell in stream.cells) for stream in stream_list),
        "total_population": _round(total_population, 2),
        "population_unit": population_unit,
        "signals": signals,
        "warnings": warnings,
    }


def _allocate_cases(weights: Sequence[float], total_cases: int, total_weight: float, rng: random.Random) -> list[int]:
    """Multinomial allocation proportional to population, total held fixed."""
    drawn = [0] * len(weights)
    cases_left = total_cases
    weight_left = total_weight
    for index, weight in enumerate(weights):
        if cases_left <= 0:
            break
        if weight <= 0 or weight_left <= 0:
            continue
        probability = min(1.0, weight / weight_left)
        taken = sum(1 for _ in range(cases_left) if rng.random() < probability)
        drawn[index] = taken
        cases_left -= taken
        weight_left -= weight
    return drawn


# ---------------------------------------------------------------------------------
# Multivariate


def multivariate_combined_llr(stream_ratios: Iterable[float]) -> tuple[float, int]:
    """The combining rule, and the only part of the multivariate scan that lives here.

    The full scan is desktop-side because its null shuffles whole isolates so that
    co-resistance survives into the simulated maxima, and this runtime never holds an isolate.
    What both runtimes must agree on is what the combined statistic *is*: the sum of the
    positive per-stream log-likelihood ratios, and nothing else. A stream showing nothing
    contributes nothing rather than averaging a signal away against silence.
    """
    positive = [value for value in stream_ratios if value > 0]
    return sum(positive), len(positive)
