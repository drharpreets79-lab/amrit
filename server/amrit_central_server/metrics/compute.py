"""Turn federated aggregate results into dashboard metric values.

Two layers:

1.  ``site_resistance_payload`` — the *reference producer*. It computes a
    resistance-rate result from raw isolate rows the **same way** the desktop
    app does in ``aggregate_measures.calculate_resistance_summary`` (%R over
    S/I/R). This is what a site puts on the wire and is pinned by a test so the
    server's understanding of the payload never drifts from the producer.

2.  ``compute_metric`` — the production path. It reads already-stored,
    aggregate ``QueryResult`` rows (never patient rows), scopes them, and rolls
    them up into a ``value_json`` for a ``KPISnapshot``.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Dict, Iterable, List, Optional

from analytics.fhir import wilson_ci
from central.scopes import site_scope_q

from .registry import (
    FAMILY_BURDEN,
    FAMILY_COVERAGE,
    FAMILY_PHENOTYPE,
    FAMILY_RESISTANCE,
    MetricDef,
)

SIR = {"R", "I", "S"}


# --------------------------------------------------------------------------- #
# Reference producer — mirrors desktop aggregate_measures                     #
# --------------------------------------------------------------------------- #
def site_resistance_payload(rows: Iterable[Dict[str, Any]], antibiotic_code: str) -> Dict[str, Any]:
    """Compute the resistance_rate wire payload for one site from isolate rows.

    ``rows`` items look like ``{"antibiotic_results": {ABX: {"result": "R"}}, ...}``
    already parsed to a dict, OR carry a flat ``result`` for the target antibiotic.
    Mirrors the desktop numerator/denominator definition exactly.
    """
    numerator = denominator = 0
    by_origin: Dict[str, Dict[str, int]] = defaultdict(lambda: {"numerator": 0, "denominator": 0})
    for row in rows:
        result = _row_result(row, antibiotic_code)
        if result not in SIR:
            continue
        denominator += 1
        origin = str(row.get("infection_origin") or row.get("origin") or "Unknown")
        by_origin[origin]["denominator"] += 1
        if result == "R":
            numerator += 1
            by_origin[origin]["numerator"] += 1
    return {
        "antibiotic_code": antibiotic_code,
        "numerator": numerator,
        "denominator": denominator,
        "rate_percent": round(numerator / denominator * 100, 2) if denominator else 0.0,
        "by_origin": {k: dict(v) for k, v in by_origin.items()},
    }


def _row_result(row: Dict[str, Any], antibiotic_code: str) -> str:
    abx = row.get("antibiotic_results")
    if isinstance(abx, dict):
        payload = abx.get(antibiotic_code) or {}
        return str((payload or {}).get("result") or "").strip().upper()
    return str(row.get("result") or "").strip().upper()


# --------------------------------------------------------------------------- #
# Aggregation across sites                                                     #
# --------------------------------------------------------------------------- #
def aggregate_resistance(payloads: List[Dict[str, Any]], *, ci_level: float = 0.95) -> Dict[str, Any]:
    """Roll up per-site resistance payloads into one value_json (with Wilson CI)."""
    num = den = 0
    by_site: List[Dict[str, Any]] = []
    for p in payloads:
        n = int(p.get("numerator", 0) or 0)
        d = int(p.get("denominator", 0) or 0)
        num += n
        den += d
        by_site.append({
            "lab_code": p.get("lab_code", ""),
            "site_name": p.get("site_name", ""),
            # Where the site reports from, as the materialised path of codes. One field
            # covers a hierarchy of any depth; two named ones covered exactly two levels.
            "admin_path": p.get("admin_path", ""),
            "numerator": n,
            "denominator": d,
            "rate_percent": round(n / d * 100, 2) if d else None,
        })
    ci = wilson_ci(num, den, level=ci_level)
    return {
        "numerator": num,
        "denominator": den,
        "rate_percent": round(num / den * 100, 2) if den else None,
        "ci_low_percent": round(ci["low"] * 100, 2),
        "ci_high_percent": round(ci["high"] * 100, 2),
        "ci_level": ci["level"],
        "n_sites": sum(1 for s in by_site if s["denominator"] > 0),
        "by_site": by_site,
    }


def merge_distribution(bucket_dicts: List[Dict[str, int]], *, floor: int = 0) -> Dict[str, Any]:
    merged: Dict[str, int] = defaultdict(int)
    for buckets in bucket_dicts:
        for label, count in (buckets or {}).items():
            merged[label] += int(count or 0)
    merged = {k: v for k, v in merged.items() if v >= floor}
    ordered = dict(sorted(merged.items(), key=lambda kv: kv[1], reverse=True))
    return {"total": sum(ordered.values()), "buckets": ordered}


# --------------------------------------------------------------------------- #
# Production path — read stored aggregate QueryResults                         #
# --------------------------------------------------------------------------- #
def _scope_site_filter(scope_type: str, scope_value: str):
    """A Q restricting results to one scope, via central.scopes.

    Accepts the withdrawn spellings ("state", "district", "national") as well as the
    canonical ones, so a stored row or an inbound parameter written before the rename
    still resolves to the level it always meant.
    """
    return site_scope_q(scope_type, scope_value, prefix="site__")


def _results_for(query_type: str, scope_type: str, scope_value: str, *, query_ids=None):
    from queries.models import QueryResult  # local import: avoids app-load cycle
    qs = QueryResult.objects.filter(query__type=query_type, ok=True).select_related("site", "query")
    condition = _scope_site_filter(scope_type, scope_value)
    if condition:
        qs = qs.filter(condition)
    if query_ids is not None:
        qs = qs.filter(query_id__in=query_ids)
    return qs


def _latest_per_site(results):
    """Keep one newest successful result per site; older syncs are audit-only."""
    latest = {}
    for result in results.order_by("site_id", "-received_at"):
        latest.setdefault(result.site_id, result)
    return list(latest.values())


def compute_metric(metric: MetricDef, scope_type: str, scope_value: str,
                   *, floor: int = 5, query_ids=None, site_ids=None) -> Dict[str, Any]:
    """Compute a metric's value_json from stored aggregate results for a scope."""
    if metric.family == FAMILY_RESISTANCE:
        return _compute_resistance(metric, scope_type, scope_value, query_ids=query_ids)
    if metric.family == FAMILY_PHENOTYPE:
        return _compute_resistance(metric, scope_type, scope_value, query_ids=query_ids)  # same shape
    if metric.family == FAMILY_BURDEN:
        return _compute_burden(metric, scope_type, scope_value, floor=floor, query_ids=query_ids)
    if metric.family == FAMILY_COVERAGE:
        return _compute_coverage(
            metric,
            scope_type,
            scope_value,
            query_ids=query_ids,
            site_ids=site_ids,
        )
    return {}


def _compute_resistance(metric: MetricDef, scope_type: str, scope_value: str, *, query_ids=None) -> Dict[str, Any]:
    qs = _results_for("resistance_rate", scope_type, scope_value, query_ids=query_ids)
    if metric.antibiotic_code:
        qs = qs.filter(query__antibiotic_code=metric.antibiotic_code)
    matching = []
    for qr in qs:
        filters = qr.query.filters or {}
        actual_org = str(filters.get("organism", "")).strip().lower()
        if metric.organism_name:
            if not actual_org or metric.organism_name.split()[0].lower() not in actual_org:
                continue
        elif actual_org:
            continue
        desired_specimen = str(metric.default_filters.get("specimen_category", "")).strip().lower()
        actual_specimen = str(filters.get("specimen_type", "")).strip().lower()
        if desired_specimen:
            if not actual_specimen or desired_specimen not in actual_specimen:
                continue
        elif actual_specimen:
            continue
        matching.append(qr)

    payloads = []
    for qr in _latest_per_site(qs.filter(id__in=[item.id for item in matching])):
        rj = qr.result_json or {}
        payloads.append({
            "lab_code": qr.site.lab_code,
            "site_name": qr.site.name,
            "admin_path": qr.site.admin_path,
            "numerator": rj.get("numerator", 0),
            "denominator": rj.get("denominator", 0),
        })
    return aggregate_resistance(payloads)


def _compute_burden(metric: MetricDef, scope_type: str, scope_value: str, *, floor: int, query_ids=None) -> Dict[str, Any]:
    if metric.query_type == "isolate_count":
        qs = _results_for("isolate_count", scope_type, scope_value, query_ids=query_ids)
        total = 0
        by_site: Dict[str, int] = {}
        for qr in _latest_per_site(qs):
            n = int((qr.result_json or {}).get("count", 0) or 0)
            total += n
            by_site[qr.site.lab_code] = n
        return {"total": total, "by_site": by_site, "n_sites": len(by_site)}
    # distribution families
    qs = _results_for(metric.query_type, scope_type, scope_value, query_ids=query_ids)
    latest = _latest_per_site(qs)
    dist = merge_distribution([(qr.result_json or {}).get("buckets", {}) for qr in latest], floor=floor)
    dist["n_sites"] = len({qr.site_id for qr in latest})
    return dist


def _compute_coverage(metric: MetricDef, scope_type: str, scope_value: str, *, query_ids=None, site_ids=None) -> Dict[str, Any]:
    from django.utils import timezone
    from datetime import timedelta
    from sites.models import Site
    from queries.models import QueryResult

    sites = Site.objects.filter(status="active")
    if site_ids is not None:
        sites = sites.filter(id__in=site_ids)
    condition = site_scope_q(scope_type, scope_value)
    if condition:
        sites = sites.filter(condition)

    online_threshold = timezone.now() - timedelta(minutes=5)
    total = sites.count()
    if metric.key == "cov_sites_online":
        online = sites.filter(last_seen_at__gte=online_threshold).count()
        return {"value": online, "total": total, "rate_percent": _pct(online, total)}
    if metric.key == "cov_geo":
        # Coverage is counted per administrative level, one key per level the data
        # actually uses. Two fixed keys could only ever describe two levels.
        return {f"admin{level}": count for level, count in _coverage_by_level(sites).items()}
    if metric.key == "cov_ast_completeness":
        # Best-effort: share of isolate_count results carrying a denominator hint.
        return {"value": None, "total": total, "rate_percent": None}
    # cov_sites_reporting (default)
    reporting_results = QueryResult.objects.filter(site__in=sites, ok=True)
    if query_ids is not None:
        reporting_results = reporting_results.filter(query_id__in=query_ids)
    reporting_ids = set(reporting_results.values_list("site_id", flat=True))
    reporting = len(reporting_ids)
    return {"value": reporting, "total": total, "rate_percent": _pct(reporting, total)}


def _coverage_by_level(sites) -> Dict[int, int]:
    """Distinct administrative units covered, per level, for linked sites."""
    counts: Dict[int, int] = {}
    seen: Dict[int, set] = {}
    for path in sites.exclude(admin_path="").values_list("admin_path", flat=True):
        segments = str(path).split("/")
        # segments[0] is the country code; each further segment is one level down.
        for level, code in enumerate(segments[1:], start=1):
            seen.setdefault(level, set()).add("/".join(segments[: level + 1]))
    for level, values in seen.items():
        counts[level] = len(values)
    return counts


def _pct(n: int, d: int) -> Optional[float]:
    return round(n / d * 100, 1) if d else None
