"""Compute + persist KPISnapshots, and trigger real-time pulls from desktops.

Two entry points:

* ``refresh_scope`` — recompute every dashboard metric for a scope from the
  aggregate ``QueryResult`` rows currently on the server and write fresh
  snapshots. Called by the scheduled ``refresh_snapshots`` command and by the
  dashboard "Refresh live" button (after a live pull is dispatched).
* ``dispatch_live_pull`` — enqueue fresh aggregate queries to the in-scope
  sites over the long-poll bridge, and (best effort) nudge online sites over
  the WebSocket bridge so they answer immediately.

Only aggregate values are ever written. Nothing here can persist a patient row.
"""

from __future__ import annotations

import logging
import time
from datetime import timedelta
from typing import Iterable, List, Optional

from django.conf import settings

from central.privacy import k_anonymity_floor

from central.scopes import site_scope_q
from django.db import transaction
from django.utils import timezone

from metrics import registry
from metrics.compute import compute_metric

from .models import KPISnapshot

LOG = logging.getLogger("amrit.dashboards")


# --------------------------------------------------------------------------- #
# Snapshot writing                                                            #
# --------------------------------------------------------------------------- #
def write_snapshot(metric_key, scope_type, scope_value, value_json, *,
                   n_sites=0, source="snapshot", period_start=None, period_end=None,
                   refresh_run=None, computed_at=None) -> KPISnapshot:
    snap = KPISnapshot.objects.create(
        metric_key=metric_key,
        scope_type=scope_type,
        scope_value=scope_value or "",
        value_json=value_json or {},
        n_sites=n_sites or (value_json or {}).get("n_sites", 0) or 0,
        source=source,
        refresh_run=refresh_run,
        period_start=period_start,
        period_end=period_end,
        computed_at=computed_at or timezone.now(),
    )
    _run_action_rules(snap)
    return snap


def refresh_metric(metric, scope_type, scope_value, *, source="snapshot",
                   query_ids=None, site_ids=None, refresh_run=None, computed_at=None) -> KPISnapshot:
    floor = k_anonymity_floor()
    value = compute_metric(
        metric,
        scope_type,
        scope_value,
        floor=floor,
        query_ids=query_ids,
        site_ids=site_ids,
    )
    return write_snapshot(
        metric.key, scope_type, scope_value, value,
        n_sites=value.get("n_sites", 0), source=source,
        refresh_run=refresh_run, computed_at=computed_at,
    )


def refresh_scope(scope_type="country", scope_value="", *, metric_keys=None,
                  source="snapshot", query_ids=None, site_ids=None,
                  refresh_run=None, computed_at=None, strict=False) -> int:
    metrics = registry.by_keys(metric_keys) if metric_keys else registry.all_metrics()
    def _write_all():
        written = 0
        for metric in metrics:
            try:
                refresh_metric(
                    metric,
                    scope_type,
                    scope_value,
                    source=source,
                    query_ids=query_ids,
                    site_ids=site_ids,
                    refresh_run=refresh_run,
                    computed_at=computed_at,
                )
                written += 1
            except Exception:
                LOG.exception("snapshot compute failed for %s @ %s:%s", metric.key, scope_type, scope_value)
                if strict:
                    raise
        return written

    if strict:
        with transaction.atomic():
            return _write_all()
    return _write_all()


def refresh_all_scopes(*, source="snapshot") -> int:
    """One snapshot for the country, one per unit at every administrative level, one per site.

    The fan-out follows the active country's chain rather than a hardcoded
    state-then-district loop, so a three-level country produces three tiers. Scopes are
    stored canonically as ``admin:<level>``; migration ``0009`` rewrote the rows that used
    to be stored as ``state``/``district``, so existing snapshots and links still resolve.
    """
    from central.country_profile import get_profile
    from central.scopes import distinct_scope_values, refresh_levels, scope_for_level

    try:
        profile = get_profile()
    except Exception:  # noqa: BLE001 - a bad profile must not stop a scheduled refresh
        profile = None

    total = refresh_scope("country", "", source=source)
    # Levels come from the profile *and* from the data, so a deployment that has not
    # configured a profile keeps producing every tier it already had.
    for level in refresh_levels(profile):
        stored_scope = scope_for_level(level)
        for value in distinct_scope_values(scope_for_level(level)):
            total += refresh_scope(stored_scope, value, source=source)
    for lab_code in distinct_scope_values("site"):
        total += refresh_scope("site", lab_code, source=source)
    return total


# --------------------------------------------------------------------------- #
# Live pull (real-time, from the desktop apps)                                #
# --------------------------------------------------------------------------- #
def _scope_sites(scope_type, scope_value, *, online_only=False):
    from sites.models import Site
    qs = Site.objects.filter(status="active")
    condition = site_scope_q(scope_type, scope_value)
    if condition:
        qs = qs.filter(condition)
    if online_only:
        online_window = int(getattr(settings, "AMRIT_ONLINE_WINDOW_SECONDS", 300))
        qs = qs.filter(last_poll_at__gte=timezone.now() - timedelta(seconds=online_window))
    return qs


def dispatch_live_pull(scope_type="country", scope_value="", *, metric_keys=None) -> dict:
    """Enqueue fresh aggregate queries to in-scope sites and nudge them live.

    Returns a summary dict. Sites answer on their next long-poll; online sites
    are also nudged over the WebSocket bridge for an immediate response.
    """
    from queries.models import Query, QueryDispatch
    from central.consumers import nudge_site_live  # lazy: avoids app-load cycle

    metrics = registry.by_keys(metric_keys) if metric_keys else registry.all_metrics()
    sites = list(_scope_sites(scope_type, scope_value, online_only=True))
    if not sites:
        return {
            "dispatched_queries": 0,
            "sites": 0,
            "nudged": 0,
            "query_ids": [],
            "isolate_count_query_ids": [],
            "site_ids": [],
            "site_lab_codes": [],
            "expected_dispatches": 0,
        }

    ttl = int(getattr(settings, "AMRIT_QUERY_TTL_SECONDS", 3600))
    expires_at = timezone.now() + timedelta(seconds=ttl)

    # De-duplicate the query set the catalog implies.
    specs = _query_specs(metrics)
    QueryDispatch.objects.filter(
        site__in=sites,
        status="pending",
        query__title__startswith="Live refresh ·",
    ).update(status="expired")
    created = 0
    query_ids = []
    isolate_count_query_ids = []
    for qtype, abx, organism, specimen in specs:
        filters = {}
        if organism:
            filters["organism"] = organism
        if specimen:
            filters["specimen_type"] = specimen
        q = Query.objects.create(
            type=qtype,
            title=f"Live refresh · {qtype}",
            antibiotic_code=abx,
            filters=filters,
            target_lab_codes=[s.lab_code for s in sites],
            expires_at=expires_at,
            status="queued",
        )
        QueryDispatch.objects.bulk_create(
            [QueryDispatch(query=q, site=s) for s in sites], ignore_conflicts=True
        )
        created += 1
        query_ids.append(str(q.id))
        if qtype == "isolate_count":
            isolate_count_query_ids.append(str(q.id))

    nudged = 0
    for s in sites:
        if s.is_online:
            try:
                nudge_site_live(s.lab_code)
                nudged += 1
            except Exception:  # pragma: no cover
                LOG.debug("ws nudge failed for %s", s.lab_code)

    return {
        "dispatched_queries": created,
        "sites": len(sites),
        "nudged": nudged,
        "query_ids": query_ids,
        "isolate_count_query_ids": isolate_count_query_ids,
        "site_ids": [site.id for site in sites],
        "site_lab_codes": [site.lab_code for site in sites],
        "expected_dispatches": created * len(sites),
    }


def wait_for_live_pull(summary: dict, *, timeout_seconds=None) -> dict:
    """Wait for current refresh-batch replies; never read historical results.

    Counts describe local records represented by aggregate FHIR responses. Raw
    patient rows are never uploaded or stored by the central server.
    """
    from queries.models import QueryDispatch, QueryResult

    query_ids = summary.get("query_ids") or []
    isolate_query_ids = summary.get("isolate_count_query_ids") or []
    expected = int(summary.get("sites") or 0)
    expected_dispatches = int(summary.get("expected_dispatches") or 0)
    if not query_ids or expected <= 0 or expected_dispatches <= 0:
        return {
            "records": 0,
            "responded_sites": 0,
            "failed_sites": 0,
            "expected_sites": expected,
            "fhir_bundles": 0,
            "timed_out": False,
            "expected_dispatches": expected_dispatches,
            "completed_dispatches": 0,
            "failed_dispatches": 0,
            "complete": expected == 0,
        }

    if timeout_seconds is None:
        timeout_seconds = float(getattr(settings, "AMRIT_REFRESH_WAIT_SECONDS", 30))
    deadline = time.monotonic() + max(0.0, float(timeout_seconds))

    while True:
        terminal = QueryDispatch.objects.filter(
            query_id__in=query_ids,
            status__in=("answered", "error", "expired"),
        ).count()
        if terminal >= expected_dispatches or time.monotonic() >= deadline:
            break
        time.sleep(0.25)

    latest_by_site = {}
    results = QueryResult.objects.filter(query_id__in=query_ids, ok=True).order_by(
        "query_id", "site_id", "-received_at"
    )
    for result in results:
        latest_by_site.setdefault((result.query_id, result.site_id), result)

    records = 0
    fhir_bundles = 0
    isolate_results = [
        result for (query_id, _site_id), result in latest_by_site.items()
        if str(query_id) in isolate_query_ids
    ]
    for result in isolate_results:
        try:
            records += max(0, int((result.result_json or {}).get("count", 0) or 0))
        except (TypeError, ValueError):
            continue
        if (result.fhir_json or {}).get("resourceType") == "Bundle":
            fhir_bundles += 1

    dispatches = QueryDispatch.objects.filter(
        query_id__in=query_ids,
        status__in=("answered", "error", "expired"),
    )
    terminal = dispatches.count()
    failed_dispatches = dispatches.filter(status__in=("error", "expired")).count()
    responded = len({result.site_id for result in isolate_results})
    successful_dispatches = len(latest_by_site)
    return {
        "records": records,
        "responded_sites": responded,
        "failed_sites": QueryDispatch.objects.filter(
            query_id__in=isolate_query_ids,
            status__in=("error", "expired"),
        ).count(),
        "expected_sites": expected,
        "fhir_bundles": fhir_bundles,
        "timed_out": terminal < expected_dispatches,
        "expected_dispatches": expected_dispatches,
        "completed_dispatches": terminal,
        "failed_dispatches": failed_dispatches,
        "successful_dispatches": successful_dispatches,
        "complete": (
            terminal >= expected_dispatches
            and failed_dispatches == 0
            and successful_dispatches >= expected_dispatches
        ),
    }


def wait_for_live_record_count(summary: dict, *, timeout_seconds=None) -> dict:
    """Backward-compatible alias for callers using the old helper name."""
    return wait_for_live_pull(summary, timeout_seconds=timeout_seconds)


def _query_specs(metrics) -> List[tuple]:
    """Collapse the catalog into a de-duplicated set of wire queries."""
    seen = set()
    specs = []
    for m in metrics:
        if m.query_type == "resistance_rate" and m.antibiotic_code:
            organism = m.organism_name
            specimen = m.default_filters.get("specimen_category", "")
            key = ("resistance_rate", m.antibiotic_code, organism, specimen)
        elif m.query_type in {"isolate_count", "organism_distribution", "specimen_distribution"}:
            key = (m.query_type, "", "", "")
        else:
            continue
        if key in seen:
            continue
        seen.add(key)
        specs.append(key)
    priority = {
        "isolate_count": 0,
        "organism_distribution": 1,
        "specimen_distribution": 2,
        "resistance_rate": 3,
    }
    specs.sort(key=lambda spec: priority.get(spec[0], 99))
    return specs


def _run_action_rules(snapshot) -> None:
    """Hook the action-plan rule engine, if the app is installed."""
    try:
        from actionplans.rules import evaluate_snapshot
    except Exception:
        return
    try:
        evaluate_snapshot(snapshot)
    except Exception:  # pragma: no cover
        LOG.exception("action rule evaluation failed for snapshot %s", snapshot.pk)
