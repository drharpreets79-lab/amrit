"""Restricted portal surface for aggregate outbreak and resistance-cluster detection."""

from __future__ import annotations

from datetime import date, timedelta

from django.contrib import messages
from django.core.cache import cache
from django.shortcuts import redirect, render
from django.utils import timezone
from django.views.decorators.http import require_http_methods

from central.roles import (
    CAP_RUN_QUERY,
    CAP_VIEW_ADVANCED_DASHBOARD,
    has_cap,
    require_cap,
    scope_sites,
)
from queries.models import Query, QueryDispatch, QueryResult
from sites.models import Site

from .outbreak_detection import ScanSettings, parse_aggregate_rows, scan


def _integer(raw, default: int, minimum: int, maximum: int) -> int:
    try:
        return max(minimum, min(maximum, int(raw)))
    except (TypeError, ValueError):
        return default


def _settings(request) -> ScanSettings:
    source = request.GET
    return ScanSettings(
        analysis_type=source.get("analysis_type", "prospective"),
        target=source.get("target", "both"),
        baseline_days=_integer(source.get("baseline_days"), 365, 30, 3650),
        max_cluster_days=_integer(source.get("max_cluster_days"), 60, 1, 365),
        minimum_cases=_integer(source.get("minimum_cases"), 3, 2, 100),
        permutations=_integer(source.get("permutations"), 999, 19, 9999),
        recurrence_threshold_days=_integer(source.get("recurrence_threshold_days"), 365, 20, 100_000),
    ).bounded()


def _visible_cluster_queries(user, visible_sites):
    if not visible_sites.exists():
        return Query.objects.none()
    return Query.objects.filter(type="cluster_scan", dispatches__site__in=visible_sites).distinct().order_by("-created_at")


@require_cap(CAP_VIEW_ADVANCED_DASHBOARD)
@require_http_methods(["GET", "POST"])
def outbreak_dashboard(request):
    visible_sites = scope_sites(request.user, Site.objects.filter(status="active"))
    if request.method == "POST":
        if not has_cap(request.user, CAP_RUN_QUERY):
            from django.core.exceptions import PermissionDenied
            raise PermissionDenied("This role may review signals but may not dispatch site queries.")
        start = request.POST.get("period_start", "").strip()
        end = request.POST.get("period_end", "").strip()
        try:
            start_date = date.fromisoformat(start)
            end_date = date.fromisoformat(end)
        except ValueError:
            messages.error(request, "Enter valid ISO start and end dates.")
            return redirect("outbreak_dashboard")
        if end_date < start_date or (end_date - start_date).days > 3650:
            messages.error(request, "End date must follow start date; maximum collection period is 10 years.")
            return redirect("outbreak_dashboard")
        targets = list(visible_sites.values_list("lab_code", flat=True))
        if not targets:
            messages.error(request, "No active reporting sites are visible in your scope.")
            return redirect("outbreak_dashboard")
        query = Query.objects.create(
            type="cluster_scan",
            title=f"Outbreak scan inputs · {start} to {end}",
            notes="Aggregate daily organism and recorded-resistant (R) phenotype counts; no row-level records.",
            target_lab_codes=targets,
            filters={
                "period_start": start,
                "period_end": end,
                "deduplication_days": _integer(request.POST.get("deduplication_days"), 30, 0, 365),
            },
            created_by=request.user,
            expires_at=timezone.now() + timedelta(hours=24),
            status="queued",
        )
        QueryDispatch.objects.bulk_create([QueryDispatch(query=query, site=site) for site in visible_sites])
        messages.success(request, f"Outbreak input query queued for {len(targets)} site(s). Results appear as sites sync.")
        return redirect(f"/dashboard/outbreaks/?query={query.pk}")

    queries = _visible_cluster_queries(request.user, visible_sites)[:30]
    selected = None
    selected_id = request.GET.get("query", "").strip()
    if selected_id:
        selected = _visible_cluster_queries(request.user, visible_sites).filter(pk=selected_id).first()
    if selected is None:
        selected = queries[0] if queries else None
    settings = _settings(request)
    result = None
    reporting_sites = 0
    if selected is not None:
        latest_by_site = {}
        for query_result in QueryResult.objects.filter(
            query=selected, site__in=visible_sites, ok=True
        ).select_related("site").order_by("-received_at"):
            latest_by_site.setdefault(query_result.site_id, query_result)
        rows = []
        invalid_payloads = 0
        for query_result in latest_by_site.values():
            payload = query_result.result_json if isinstance(query_result.result_json, dict) else {}
            payload_rows = payload.get("rows", [])
            if not isinstance(payload_rows, list):
                invalid_payloads += 1
                continue
            for row in payload_rows:
                if isinstance(row, dict):
                    rows.append({**row, "location": query_result.site.lab_code})
        reporting_sites = len(latest_by_site)
        events, invalid_rows = parse_aggregate_rows(rows)
        cache_key = "outbreak-scan:" + ":".join((str(selected.pk), str(selected.completed_at or selected.created_at), repr(settings)))
        result = cache.get(cache_key)
        if result is None:
            result = scan(events, settings, invalid_rows=invalid_rows + invalid_payloads)
            cache.set(cache_key, result, 300)
    default_end = date.today()
    return render(request, "dashboard/outbreaks.html", {
        "queries": queries,
        "selected_query": selected,
        "scan": result,
        "settings": settings,
        "reporting_sites": reporting_sites,
        "visible_site_count": visible_sites.count(),
        "can_dispatch": has_cap(request.user, CAP_RUN_QUERY),
        "default_period_start": (default_end - timedelta(days=364)).isoformat(),
        "default_period_end": default_end.isoformat(),
    })
