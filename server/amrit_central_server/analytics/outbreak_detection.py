"""WHONET-compatible outbreak detection over aggregate case counts.

Implements Kulldorff's case-only space-time permutation scan statistic.  No patient rows
are accepted here: portal input is daily organism/resistance-phenotype counts by site.
"""

from __future__ import annotations

import hashlib
import json
import math
import random
from collections import defaultdict
from dataclasses import dataclass, replace
from datetime import date, timedelta
from typing import Iterable


@dataclass(frozen=True)
class ScanSettings:
    analysis_type: str = "prospective"
    target: str = "both"
    baseline_days: int = 365
    max_cluster_days: int = 60
    minimum_cases: int = 3
    permutations: int = 999
    recurrence_threshold_days: int = 365

    def bounded(self) -> "ScanSettings":
        return ScanSettings(
            analysis_type=self.analysis_type if self.analysis_type in {"prospective", "retrospective"} else "prospective",
            target=self.target if self.target in {"organism", "resistance", "both"} else "both",
            baseline_days=max(30, min(3650, int(self.baseline_days))),
            max_cluster_days=max(1, min(365, int(self.max_cluster_days))),
            minimum_cases=max(2, min(100, int(self.minimum_cases))),
            permutations=max(19, min(9999, int(self.permutations))),
            recurrence_threshold_days=max(20, min(100_000, int(self.recurrence_threshold_days))),
        )


@dataclass(frozen=True)
class CaseEvent:
    date: date
    location: str
    signal_type: str
    signal_code: str
    organism: str
    antibiotic: str = ""
    count: int = 1


@dataclass
class Series:
    family: str
    signal_type: str
    signal_code: str
    organism: str
    antibiotic: str
    events: list[tuple[int, str, int]]
    location_meta: dict[str, tuple[str, str, str]] | None = None


@dataclass
class Candidate:
    series: Series
    location: str
    start: int
    end: int
    observed: int
    expected: float
    llr: float


def parse_aggregate_rows(rows: Iterable[dict]) -> tuple[list[CaseEvent], int]:
    events: list[CaseEvent] = []
    invalid = 0
    for row in rows:
        try:
            specimen_date = date.fromisoformat(str(row.get("date", "")))
            count = int(row.get("count", 0))
        except (TypeError, ValueError):
            invalid += 1
            continue
        signal_type = str(row.get("signal_type", "")).strip().lower()
        signal_code = str(row.get("signal_code", "")).strip()
        location = str(row.get("location", "")).strip()
        organism = str(row.get("organism", "")).strip()
        if signal_type not in {"organism", "resistance"} or not signal_code or not location or not organism or count <= 0:
            invalid += 1
            continue
        events.append(CaseEvent(
            date=specimen_date, location=location, signal_type=signal_type,
            signal_code=signal_code, organism=organism,
            antibiotic=str(row.get("antibiotic_code", row.get("antibiotic", ""))).strip().upper(),
            count=count,
        ))
    return events, invalid


def _llr(observed: int, expected: float, total: int) -> float:
    if observed <= expected or expected <= 0 or total <= observed or total <= expected:
        return 0.0
    outside_observed = total - observed
    outside_expected = total - expected
    return observed * math.log(observed / expected) + outside_observed * math.log(outside_observed / outside_expected)


def _make_series(events: list[CaseEvent], study_start: date) -> list[Series]:
    by_signal: dict[str, list[CaseEvent]] = defaultdict(list)
    for event in events:
        by_signal[event.signal_code].append(event)
    output: list[Series] = []
    for signal_code, values in by_signal.items():
        first = values[0]
        if len({event.location for event in values}) >= 2:
            output.append(Series(
                family="space-time", signal_type=first.signal_type, signal_code=signal_code,
                organism=first.organism, antibiotic=first.antibiotic,
                events=[((event.date - study_start).days, event.location, event.count) for event in values],
            ))
    for signal_type in ("organism", "resistance"):
        values = [event for event in events if event.signal_type == signal_type]
        if len({event.signal_code for event in values}) < 2:
            continue
        meta = {event.signal_code: (event.signal_code, event.organism, event.antibiotic) for event in values}
        output.append(Series(
            family="category-time", signal_type=signal_type, signal_code=f"{signal_type.upper()}:ALL",
            organism="", antibiotic="", location_meta=meta,
            events=[((event.date - study_start).days, event.signal_code, event.count) for event in values],
        ))
    return output


def _scan_series(series: Series, study_days: int, settings: ScanSettings, collect: bool) -> tuple[float, list[Candidate]]:
    total = sum(count for _day, _location, count in series.events)
    locations = sorted({location for _day, location, _count in series.events})
    if total < settings.minimum_cases or study_days < 2 or len(locations) < 2:
        return 0.0, []
    maximum_days = max(1, min(settings.max_cluster_days, study_days // 2))
    date_totals = [0] * study_days
    by_location = {location: [0] * study_days for location in locations}
    for day, location, count in series.events:
        if 0 <= day < study_days:
            date_totals[day] += count
            by_location[location][day] += count
    stratum_totals = [0] * 7
    for day, count in enumerate(date_totals):
        stratum_totals[day % 7] += count
    ends = [study_days - 1] if settings.analysis_type == "prospective" else range(study_days)
    maximum = 0.0
    candidates: list[Candidate] = []
    for location, counts in by_location.items():
        location_strata = [0] * 7
        for day, count in enumerate(counts):
            location_strata[day % 7] += count
        for end in ends:
            observed = 0
            window_strata = [0] * 7
            for length in range(1, min(maximum_days, end + 1) + 1):
                start = end - length + 1
                observed += counts[start]
                window_strata[start % 7] += date_totals[start]
                if observed < settings.minimum_cases:
                    continue
                expected = sum(
                    location_strata[index] * window_strata[index] / stratum_totals[index]
                    for index in range(7) if stratum_totals[index]
                )
                llr = _llr(observed, expected, total)
                if llr <= 0:
                    continue
                maximum = max(maximum, llr)
                if collect:
                    candidates.append(Candidate(series, location, start, end, observed, expected, llr))
    return maximum, candidates


def _permute(series: Series, rng: random.Random) -> Series:
    expanded = [(day, location) for day, location, count in series.events for _ in range(count)]
    pools: list[list[int]] = [[] for _ in range(7)]
    for day, _location in expanded:
        pools[day % 7].append(day)
    for pool in pools:
        rng.shuffle(pool)
    offsets = [0] * 7
    counts: dict[tuple[int, str], int] = defaultdict(int)
    for original_day, location in expanded:
        stratum = original_day % 7
        day = pools[stratum][offsets[stratum]]
        offsets[stratum] += 1
        counts[(day, location)] += 1
    return replace(series, events=[(day, location, count) for (day, location), count in counts.items()])


def _non_overlapping(candidates: list[Candidate]) -> list[Candidate]:
    selected: list[Candidate] = []
    for candidate in candidates:
        if any(
            current.series.signal_type == candidate.series.signal_type
            and current.series.signal_code == candidate.series.signal_code
            and current.location == candidate.location
            and candidate.start <= current.end and candidate.end >= current.start
            for current in selected
        ):
            continue
        selected.append(candidate)
    return selected


def scan(events: list[CaseEvent], settings: ScanSettings | None = None, *, invalid_rows: int = 0) -> dict:
    settings = (settings or ScanSettings()).bounded()
    eligible = [
        event for event in events
        if settings.target == "both" or event.signal_type == settings.target
    ]
    if not eligible:
        return _empty_result(settings, invalid_rows)
    study_end = max(event.date for event in eligible)
    data_start = min(event.date for event in eligible)
    study_start = max(data_start, study_end - timedelta(days=settings.baseline_days - 1))
    eligible = [event for event in eligible if event.date >= study_start]
    study_days = (study_end - study_start).days + 1
    series = _make_series(eligible, study_start)
    candidates: list[Candidate] = []
    for item in series:
        candidates.extend(_scan_series(item, study_days, settings, True)[1])
    candidates.sort(key=lambda item: (-item.llr, -item.observed))
    seed_payload = {
        "settings": settings.__dict__,
        "events": [[event.date.isoformat(), event.location, event.signal_code, event.count] for event in eligible],
    }
    seed = int(hashlib.sha256(json.dumps(seed_payload, sort_keys=True).encode()).hexdigest()[:16], 16)
    rng = random.Random(seed)
    simulated_maxima: list[float] = []
    for _simulation in range(settings.permutations):
        maximum = 0.0
        for item in series:
            maximum = max(maximum, _scan_series(_permute(item, rng), study_days, settings, False)[0])
        simulated_maxima.append(maximum)
    signals = []
    for candidate in _non_overlapping(candidates):
        p_value = (1 + sum(value >= candidate.llr - 1e-12 for value in simulated_maxima)) / (settings.permutations + 1)
        if p_value > 0.05:
            continue
        recurrence = 1 / p_value
        meta = candidate.series.location_meta.get(candidate.location) if candidate.series.location_meta else None
        signal_code, organism, antibiotic = meta or (
            candidate.series.signal_code, candidate.series.organism, candidate.series.antibiotic
        )
        fingerprint = "|".join((signal_code, candidate.location, str(candidate.start), str(candidate.end)))
        signals.append({
            "signal_id": hashlib.sha256(fingerprint.encode()).hexdigest()[:12],
            "status": "alert" if recurrence >= settings.recurrence_threshold_days else "monitor",
            "signal_type": "Organism" if candidate.series.signal_type == "organism" else "Resistance phenotype",
            "organism": organism,
            "antibiotic": antibiotic,
            "scope": "Location cluster" if candidate.series.family == "space-time" else "All-location temporal cluster",
            "location": candidate.location if candidate.series.family == "space-time" else "All sites",
            "start_date": (study_start + timedelta(days=candidate.start)).isoformat(),
            "end_date": (study_start + timedelta(days=candidate.end)).isoformat(),
            "days": candidate.end - candidate.start + 1,
            "observed": candidate.observed,
            "expected": round(candidate.expected, 2),
            "excess": round(candidate.observed - candidate.expected, 2),
            "observed_expected_ratio": round(candidate.observed / candidate.expected, 2),
            "log_likelihood_ratio": round(candidate.llr, 3),
            "p_value": round(p_value, 4),
            "recurrence_interval_days": round(recurrence, 1),
        })
        if len(signals) >= 50:
            break
    warnings = []
    if study_days < 60:
        warnings.append("Fewer than 60 study days: baseline may be unstable.")
    if len({event.location for event in eligible}) < 2:
        warnings.append("Only one reporting site: geographic clusters cannot be estimated.")
    if settings.permutations < 999:
        warnings.append("Fewer than 999 Monte Carlo replications limits p-value resolution.")
    if invalid_rows:
        warnings.append(f"{invalid_rows} malformed aggregate row(s) excluded.")
    return {
        "method": "Kulldorff space-time permutation scan statistic",
        "analysis_type": settings.analysis_type,
        "settings": settings.__dict__,
        "study_start": study_start.isoformat(), "study_end": study_end.isoformat(),
        "eligible_events": sum(event.count for event in eligible),
        "locations": len({event.location for event in eligible}),
        "signals_tested": len({event.signal_code for event in eligible}),
        "maximum_possible_cluster_days": max(1, min(settings.max_cluster_days, study_days // 2)),
        "signals": signals, "warnings": warnings, "invalid_rows": invalid_rows,
    }


def _empty_result(settings: ScanSettings, invalid_rows: int) -> dict:
    return {
        "method": "Kulldorff space-time permutation scan statistic",
        "analysis_type": settings.analysis_type, "settings": settings.__dict__,
        "study_start": None, "study_end": None, "eligible_events": 0,
        "locations": 0, "signals_tested": 0, "maximum_possible_cluster_days": 0,
        "signals": [], "warnings": ["No eligible aggregate events."], "invalid_rows": invalid_rows,
    }
