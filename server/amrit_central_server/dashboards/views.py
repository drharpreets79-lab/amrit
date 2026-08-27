"""Role-based stakeholder dashboards (Basic + Advanced), snapshot-backed.

One generic view renders every stakeholder dashboard from ``config.DASHBOARDS``.
It reads the newest ``KPISnapshot`` per metric for the viewer's scope (country /
admin:N / site), so pages load instantly and show an "as of" stamp. A
"Refresh live" POST pulls fresh aggregate numbers from the desktop apps and
writes new snapshots. Every rendered number carries its ``MetricDef`` definition
and formula for an in-place "ⓘ Definition" popover.
"""

from __future__ import annotations

from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied
from django.http import Http404, JsonResponse
from django.shortcuts import redirect, render
from django.utils import timezone
from django.views.decorators.http import require_POST

from metrics import registry
from metrics.catalog import ANTIBIOGRAM_ANTIBIOTICS, ANTIBIOGRAM_ORGANISMS

from central.roles import (
    CAP_VIEW_ADVANCED_DASHBOARD,
    CAP_VIEW_ALL_SITES,
    CAP_VIEW_BASIC_DASHBOARD,
    dashboard_for_role,
    get_profile,
    get_role,
    has_cap,
)

from central.scopes import scope_label

from .config import DASHBOARD_ALIASES, DASHBOARDS, ranking_child_scope
from .models import DashboardRefreshRun, KPISnapshot
from .refresh import dispatch_live_pull, refresh_scope, wait_for_live_pull


def _country_profile():
    """The active country profile, or None. A bad profile must not break a dashboard."""
    from central.country_profile import get_profile as _profile

    try:
        return _profile()
    except Exception:  # noqa: BLE001 - the dashboard still renders without labels
        return None


# --------------------------------------------------------------------------- #
# Entry point — route each user to their stakeholder dashboard                #
# --------------------------------------------------------------------------- #
@login_required
def dashboard_home(request):
    kind = dashboard_for_role(get_role(request.user))
    if not kind:
        return redirect("public_summary")
    return redirect("stakeholder_dashboard", kind=kind)


# --------------------------------------------------------------------------- #
# Scope resolution                                                            #
# --------------------------------------------------------------------------- #
def _resolve_scope(request, cfg):
    """Return (scope_type, scope_value, blocked_reason).

    The administrative dashboard takes its *level* from the viewer's own unit rather than
    from the dashboard's name, which is what lets one dashboard serve every sub-national
    level of every country. An operator with no unit is blocked with a reason rather than
    silently shown the whole country.
    """
    from central.scopes import scope_for_level

    scope = cfg["scope"]
    user = request.user
    profile = get_profile(user)
    can_choose = has_cap(user, CAP_VIEW_ALL_SITES)

    if scope == "country":
        return "country", "", None
    if scope == "admin":
        unit = None
        if can_choose and request.GET.get("unit"):
            from geo.models import AdminUnit

            unit = AdminUnit.objects.filter(pk=request.GET["unit"]).first()
        unit = unit or getattr(profile, "admin_unit", None)
        if unit is None:
            return scope_for_level(1), "", "No administrative unit is set on your profile."
        return scope_for_level(unit.level), unit.code, None
    if scope == "site":
        if can_choose and request.GET.get("lab"):
            val = request.GET.get("lab")
        else:
            site = getattr(profile, "site", None)
            val = site.lab_code if site else ""
        return "site", val, (None if val else "No facility is linked to your profile.")
    return "country", "", None


def _section(request):
    section = request.GET.get("section", "basic").lower()
    if section == "advanced" and not has_cap(request.user, CAP_VIEW_ADVANCED_DASHBOARD):
        section = "basic"
    return section if section in {"basic", "advanced"} else "basic"


# --------------------------------------------------------------------------- #
# Tile / panel assembly                                                       #
# --------------------------------------------------------------------------- #
def _tile(metric_key, scope_type, scope_value, national_map=None):
    metric = registry.get(metric_key)
    if metric is None:
        return None
    snap = KPISnapshot.latest(metric_key, scope_type, scope_value)
    benchmark = None
    if national_map is not None and scope_type != "country":
        nat = national_map.get(metric_key)
        if nat is not None:
            benchmark = nat.headline
    headline = snap.headline if snap else None
    return {
        "key": metric_key,
        "metric": metric,
        "definition": metric.as_definition_dict(),
        "snapshot": snap,
        "headline": headline,
        "denominator": snap.denominator if snap else None,
        "ci_text": snap.ci_text if snap else "",
        "as_of": snap.computed_at if snap else None,
        "n_sites": snap.n_sites if snap else 0,
        "unit": metric.unit,
        "higher_is_worse": metric.higher_is_worse,
        "benchmark": benchmark,
        "band": _band(headline, metric),
        "vs_benchmark": (round(headline - benchmark, 1)
                         if headline is not None and benchmark is not None else None),
    }


def _band(headline, metric):
    """Colour band for a tile: red / amber / green / none."""
    if headline is None or metric.unit != "%":
        return "none"
    if not metric.higher_is_worse:
        return "info"
    if headline >= 50:
        return "critical"
    if headline >= 25:
        return "high"
    if headline >= 10:
        return "moderate"
    return "low"


def _trend_series(metric_key, scope_type, scope_value, limit=12):
    snaps = list(
        KPISnapshot.objects.filter(
            metric_key=metric_key,
            scope_type=scope_type,
            scope_value=scope_value or "",
            is_stale=False,
        ).order_by("computed_at")
    )
    snaps = snaps[-limit:]
    return {
        "labels": [s.computed_at.strftime("%Y-%m-%d") for s in snaps],
        "values": [s.headline for s in snaps],
        "metric": registry.get(metric_key).as_definition_dict() if registry.get(metric_key) else {},
    }


def _antibiogram_grid(scope_type, scope_value):
    """organism × antibiotic %S grid, derived from resistance snapshots (%S = 100 - %R)."""
    combo_index = {
        (m.organism_code, m.antibiotic_code): m
        for m in registry.by_family("resistance")
        if m.organism_code and m.antibiotic_code and not m.default_filters.get("specimen_category")
    }
    rows = []
    for org_code, org_name in ANTIBIOGRAM_ORGANISMS:
        cells = []
        for abx_code, _abx_name in ANTIBIOGRAM_ANTIBIOTICS:
            metric = combo_index.get((org_code, abx_code))
            cell = {"pct_s": None, "denominator": None, "reliable": False, "metric_key": None}
            if metric:
                snap = KPISnapshot.latest(metric.key, scope_type, scope_value)
                if snap and snap.headline is not None:
                    cell["pct_s"] = round(100 - snap.headline, 1)
                    cell["denominator"] = snap.denominator
                    cell["reliable"] = bool(snap.denominator and snap.denominator >= 30)
                    cell["metric_key"] = metric.key
            cells.append(cell)
        rows.append({"organism": org_name, "cells": cells})
    return {"antibiotics": [name for _c, name in ANTIBIOGRAM_ANTIBIOTICS], "rows": rows}


def _distribution(metric_key, scope_type, scope_value, top=8):
    snap = KPISnapshot.latest(metric_key, scope_type, scope_value)
    if not snap:
        return {"labels": [], "values": [], "definition": {}, "as_of": None}
    buckets = (snap.value_json or {}).get("buckets", {})
    items = list(buckets.items())[:top]
    metric = registry.get(metric_key)
    return {
        "labels": [k for k, _v in items],
        "values": [v for _k, v in items],
        "definition": metric.as_definition_dict() if metric else {},
        "as_of": snap.computed_at,
    }


def _ranking(child_scope, trend_metric, parent_scope_type, parent_scope_value):
    """Rank child scopes by the headline metric.

    Every spelling that names the tier is accepted, so a caller passing a withdrawn one
    still gets its snapshots.
    """
    from central.scopes import accepted_spellings

    qs = KPISnapshot.objects.filter(
        metric_key=trend_metric,
        scope_type__in=accepted_spellings(child_scope),
        is_stale=False,
    )
    # Newest snapshot per child scope_value.
    latest = {}
    for s in qs.order_by("computed_at"):
        latest[s.scope_value] = s
    rows = []
    for name, snap in latest.items():
        if not name:
            continue
        rows.append({"name": name, "rate": snap.headline, "denominator": snap.denominator})
    rows.sort(key=lambda r: (r["rate"] is None, -(r["rate"] or 0)))
    return rows[:20]


def _action_summary(scope_type, scope_value, role):
    try:
        from actionplans.models import ActionPlan
        from actionplans.access import plans_for_scope
    except Exception:
        return None
    plans = plans_for_scope(scope_type, scope_value, role)
    open_plans = plans.exclude(status__in=["completed", "closed", "dismissed"])
    return {
        "total": plans.count(),
        "open": open_plans.count(),
        "draft": plans.filter(status="draft").count(),
        "in_progress": plans.filter(status="in_progress").count(),
        "top": list(open_plans.order_by("-severity", "-created_at")[:5]),
    }


# --------------------------------------------------------------------------- #
# Main view                                                                   #
# --------------------------------------------------------------------------- #
@login_required
def stakeholder_dashboard(request, kind):
    if not has_cap(request.user, CAP_VIEW_BASIC_DASHBOARD):
        raise PermissionDenied("Your role has no dashboard.")
    if kind in DASHBOARD_ALIASES:
        # A bookmark to /dashboard/roles/state/ lands on the administrative dashboard
        # rather than a 404; the level comes from the viewer's own unit.
        return redirect("stakeholder_dashboard", kind=DASHBOARD_ALIASES[kind])
    cfg = DASHBOARDS.get(kind)
    if not cfg:
        raise Http404("Unknown dashboard.")

    # A user may only open the dashboard for their own role, unless admin.
    role = get_role(request.user)
    if role not in {"super_admin", "programme_admin"} and dashboard_for_role(role) != kind:
        raise PermissionDenied("This dashboard is not for your role.")

    scope_type, scope_value, blocked = _resolve_scope(request, cfg)
    section = _section(request)

    national_map = None
    if scope_type != "country":
        national_map = KPISnapshot.latest_map(cfg["basic_tiles"], "country", "")

    tiles = [t for t in (_tile(k, scope_type, scope_value, national_map) for k in cfg["basic_tiles"]) if t]
    trend = _trend_series(cfg["trend_metric"], scope_type, scope_value)
    action_summary = _action_summary(scope_type, scope_value, role)

    profile = _country_profile()
    context = {
        "kind": kind,
        "cfg": cfg,
        # The administrative dashboard's title carries the country's own word for the
        # level the viewer sits at — "Province", "Governorate", "District" — rather than
        # one country's word baked into the configuration.
        "title": cfg["title"].format(level=scope_label(profile, scope_type)),
        "section": section,
        "scope_type": scope_type,
        "scope_value": scope_value,
        "scope_display": scope_value or f"{(profile or {}).get('country_name') or 'Country'} (country)",
        "blocked": blocked,
        "tiles": tiles,
        "trend": trend,
        "action_summary": action_summary,
        "as_of": max((t["as_of"] for t in tiles if t["as_of"]), default=None),
        "panels": cfg["panels"],
    }

    if section == "advanced":
        context["adv_resistance"] = [
            t for t in (_tile(k, scope_type, scope_value, national_map)
                        for k in cfg["advanced_resistance"]) if t
        ]
        context["adv_phenotypes"] = [
            t for t in (_tile(k, scope_type, scope_value, national_map)
                        for k in cfg["advanced_phenotypes"]) if t
        ]
        if cfg["panels"].get("antibiogram"):
            context["antibiogram"] = _antibiogram_grid(scope_type, scope_value)
            ab = registry.get("antibiogram")
            context["antibiogram_def"] = ab.as_definition_dict() if ab else {}
        if cfg["panels"].get("distributions"):
            context["organism_dist"] = _distribution("burden_organism_mix", scope_type, scope_value)
            context["specimen_dist"] = _distribution("burden_specimen_mix", scope_type, scope_value)
        # What to rank is one level below whatever the viewer is looking at, resolved
        # against the country's own chain; at the bottom of the chain there is nothing to
        # rank and the panel is simply absent.
        child = ranking_child_scope(kind, profile, scope_type)
        if child:
            context["ranking"] = _ranking(child, cfg["trend_metric"], scope_type, scope_value)
            context["ranking_scope"] = child
            context["ranking_label"] = scope_label(profile, child)

    return render(request, "dashboard/roles/stakeholder.html", context)


# --------------------------------------------------------------------------- #
# Live refresh                                                                #
# --------------------------------------------------------------------------- #
@login_required
@require_POST
def refresh_live(request, kind):
    if not has_cap(request.user, CAP_VIEW_BASIC_DASHBOARD):
        raise PermissionDenied
    cfg = DASHBOARDS.get(DASHBOARD_ALIASES.get(kind, kind))
    if not cfg:
        raise Http404
    scope_type, scope_value, _blocked = _resolve_scope(request, cfg)

    # Every click is an isolated batch. Historical QueryResults remain audit
    # records and are never added into this refresh's numbers.
    clicked_at = timezone.now()
    summary = dispatch_live_pull(scope_type, scope_value)
    refresh_run = DashboardRefreshRun.objects.create(
        scope_type=scope_type,
        scope_value=scope_value or "",
        clicked_at=clicked_at,
        expected_sites=summary["sites"],
        site_lab_codes=summary.get("site_lab_codes") or [],
        query_ids=summary.get("query_ids") or [],
    )
    sync_count = wait_for_live_pull(summary)
    snapshot_failed = False

    if sync_count["complete"] and sync_count["expected_sites"] > 0:
        try:
            written = refresh_scope(
                scope_type,
                scope_value,
                source="live",
                query_ids=summary["query_ids"],
                site_ids=summary["site_ids"],
                refresh_run=refresh_run,
                computed_at=clicked_at,
                strict=True,
            )
            run_status = "success"
        except Exception:
            written = 0
            run_status = "partial"
            snapshot_failed = True
    else:
        written = 0
        run_status = "partial" if sync_count["completed_dispatches"] else "failed"

    refresh_run.status = run_status
    refresh_run.completed_at = timezone.now()
    refresh_run.responded_sites = sync_count["responded_sites"]
    refresh_run.failed_sites = sync_count["failed_sites"]
    refresh_run.records_represented = sync_count["records"]
    refresh_run.fhir_bundles = sync_count["fhir_bundles"]
    refresh_run.save(update_fields=[
        "status",
        "completed_at",
        "responded_sites",
        "failed_sites",
        "records_represented",
        "fhir_bundles",
    ])

    if request.headers.get("x-requested-with") == "XMLHttpRequest":
        return JsonResponse({
            "status": "refreshed",
            "snapshots_written": written,
            "live_pull": summary,
            "sync_count": sync_count,
            "refresh_run_id": str(refresh_run.id),
            "as_of": clicked_at.isoformat(),
        })

    expected = sync_count["expected_sites"]
    responded = sync_count["responded_sites"]
    records = sync_count["records"]
    fhir_bundles = sync_count["fhir_bundles"]
    if expected == 0:
        messages.warning(request, "No active AMRIT desktop sites found in this dashboard scope.")
    elif run_status == "success":
        messages.success(
            request,
            f"Refresh complete: {records:,} current records represented by aggregate FHIR "
            f"from {responded}/{expected} online sites; {written} timestamped KPI snapshots saved. "
            "Previous snapshots retained for time-series analysis.",
        )
    elif snapshot_failed:
        messages.warning(
            request,
            "All live replies arrived, but KPI snapshot computation failed. "
            "No dashboard values changed; previous snapshots remain active.",
        )
    elif responded:
        messages.warning(
            request,
            f"Partial refresh: {records:,} records received from {responded}/{expected} online sites, "
            f"but only {sync_count['completed_dispatches']}/{sync_count['expected_dispatches']} "
            "metric replies completed. Dashboard values unchanged; retry refresh.",
        )
    else:
        messages.error(
            request,
            f"Refresh failed: 0/{expected} online sites completed this batch. "
            "Dashboard values unchanged; keep desktop Network Sync ON, then retry.",
        )
    params = request.POST.get("section", "basic")
    return redirect(f"{request.path.replace('/refresh-live', '')}?section={params}")
