"""Action-plan inbox, plan detail (edit points / status / file ATR), tracking board."""

from __future__ import annotations

from datetime import datetime

from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied
from django.db.models import Count, Q
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.http import require_POST

from central.roles import (
    CAP_MANAGE_ACTION_PLANS,
    CAP_TRACK_ACTION_POINTS,
    get_role,
    has_cap,
)
from dashboards.models import SCOPE_CHOICES
from sites.models import ROLE_CHOICES

from .access import can_view_plan, plans_for_user, scope_for_user
from .models import (
    ActionPlan,
    ActionPlanTemplate,
    ActionPoint,
    ActionTakenReport,
    OPEN_STATUSES,
    PLAN_STATUS_CHOICES,
    POINT_STATUS_CHOICES,
    SEVERITY_CHOICES,
)


def _require_any_action_cap(user):
    if not (has_cap(user, CAP_TRACK_ACTION_POINTS) or has_cap(user, CAP_MANAGE_ACTION_PLANS)):
        raise PermissionDenied("Your role cannot access action plans.")


# --------------------------------------------------------------------------- #
# Inbox                                                                       #
# --------------------------------------------------------------------------- #
@login_required
def action_inbox(request):
    _require_any_action_cap(request.user)
    status = request.GET.get("status", "open").strip()
    plans = plans_for_user(request.user).select_related("threshold_rule").annotate(
        n_points=Count("points"), n_done=Count("points", filter=Q(points__status="done")),
    )
    if status == "open":
        plans = plans.filter(status__in=OPEN_STATUSES)
    elif status and status != "all":
        plans = plans.filter(status=status)

    plans = list(plans.order_by("-severity", "-created_at")[:200])
    counts = {
        "open": plans_for_user(request.user).filter(status__in=OPEN_STATUSES).count(),
        "draft": plans_for_user(request.user).filter(status="draft").count(),
        "all": plans_for_user(request.user).count(),
    }
    return render(request, "dashboard/actionplans/inbox.html", {
        "plans": plans, "status": status, "counts": counts,
        "status_choices": PLAN_STATUS_CHOICES,
    })


# --------------------------------------------------------------------------- #
# Tracking board                                                              #
# --------------------------------------------------------------------------- #
@login_required
def action_tracking(request):
    _require_any_action_cap(request.user)
    base = plans_for_user(request.user)
    by_status = {s: base.filter(status=s).count() for s, _l in PLAN_STATUS_CHOICES}
    by_severity = {s: base.filter(severity=s).count() for s, _l in SEVERITY_CHOICES}
    overdue = [p for p in base.filter(status__in=OPEN_STATUSES) if p.is_overdue]
    return render(request, "dashboard/actionplans/tracking.html", {
        "by_status": by_status, "by_severity": by_severity,
        "overdue": overdue, "total": base.count(),
        "open_total": base.filter(status__in=OPEN_STATUSES).count(),
    })


# --------------------------------------------------------------------------- #
# Plan detail + all mutations                                                 #
# --------------------------------------------------------------------------- #
@login_required
def action_plan_detail(request, pk):
    _require_any_action_cap(request.user)
    plan = get_object_or_404(ActionPlan, pk=pk)
    if not can_view_plan(request.user, plan):
        raise PermissionDenied("This plan is not in your scope.")

    if request.method == "POST":
        return _handle_plan_post(request, plan)

    points = list(plan.points.select_related("owner_user").all())
    atrs = list(plan.atrs.select_related("reported_by", "action_point").all())
    return render(request, "dashboard/actionplans/plan_detail.html", {
        "plan": plan, "points": points, "atrs": atrs, "progress": plan.progress(),
        "point_status_choices": POINT_STATUS_CHOICES,
        "plan_status_choices": PLAN_STATUS_CHOICES,
        "can_manage": has_cap(request.user, CAP_MANAGE_ACTION_PLANS),
        "can_track": has_cap(request.user, CAP_TRACK_ACTION_POINTS),
    })


def _handle_plan_post(request, plan):
    op = request.POST.get("op", "")
    can_manage = has_cap(request.user, CAP_MANAGE_ACTION_PLANS)
    can_track = has_cap(request.user, CAP_TRACK_ACTION_POINTS)

    if op == "plan_status":
        new = request.POST.get("status", "")
        if new not in dict(PLAN_STATUS_CHOICES):
            messages.error(request, "Invalid status.")
        elif new in {"issued", "closed", "dismissed"} and not can_manage:
            raise PermissionDenied("Only a plan manager can issue/close/dismiss.")
        elif not (can_manage or can_track):
            raise PermissionDenied
        else:
            plan.status = new
            plan.save(update_fields=["status", "updated_at"])
            messages.success(request, f"Plan marked {plan.get_status_display()}.")

    elif op == "point_status":
        if not (can_track or can_manage):
            raise PermissionDenied
        point = get_object_or_404(ActionPoint, pk=request.POST.get("point_id"), plan=plan)
        new = request.POST.get("status", "")
        if new in dict(POINT_STATUS_CHOICES):
            point.status = new
            if not point.owner_user and request.user.is_authenticated:
                point.owner_user = request.user
            point.save()
            # Auto-advance the plan when the first point starts moving.
            if plan.status in {"draft", "issued"} and new in {"in_progress", "done"}:
                plan.status = "in_progress"
                plan.save(update_fields=["status", "updated_at"])
            messages.success(request, "Action point updated.")

    elif op == "add_point":
        if not can_manage:
            raise PermissionDenied("Only a plan manager can add points.")
        text = request.POST.get("text", "").strip()
        if text:
            order = plan.points.count()
            ActionPoint.objects.create(
                plan=plan, text=text, owner_role=request.POST.get("owner_role", ""),
                due_date=_parse_date(request.POST.get("due_date")), order=order,
            )
            messages.success(request, "Action point added.")

    elif op == "file_atr":
        if not (can_track or can_manage):
            raise PermissionDenied
        narrative = request.POST.get("narrative", "").strip()
        if narrative:
            point = None
            pid = request.POST.get("action_point")
            if pid:
                point = ActionPoint.objects.filter(pk=pid, plan=plan).first()
            ActionTakenReport.objects.create(
                plan=plan, action_point=point, narrative=narrative,
                attachment_url=request.POST.get("attachment_url", "").strip(),
                evidence_numbers_json=_evidence(plan),
                reported_by=request.user,
            )
            messages.success(request, "Action-Taken Report filed.")
        else:
            messages.error(request, "ATR narrative cannot be empty.")

    elif op == "set_due":
        if not can_manage:
            raise PermissionDenied
        plan.due_date = _parse_date(request.POST.get("due_date"))
        plan.save(update_fields=["due_date", "updated_at"])
        messages.success(request, "Due date updated.")

    return redirect("action_plan_detail", pk=plan.pk)


def _evidence(plan) -> dict:
    """Snapshot the aggregate number that triggered the plan into the ATR."""
    out = {}
    if plan.trigger_metric_key:
        out["metric"] = plan.trigger_metric_key
    if plan.observed_value is not None:
        out["observed_value"] = plan.observed_value
    if plan.trigger_snapshot_id and plan.trigger_snapshot:
        out["snapshot_computed_at"] = plan.trigger_snapshot.computed_at.isoformat()
    return out


# --------------------------------------------------------------------------- #
# Manual authoring                                                            #
# --------------------------------------------------------------------------- #
@login_required
def action_plan_new(request):
    if not has_cap(request.user, CAP_MANAGE_ACTION_PLANS):
        raise PermissionDenied("Only a plan manager can author plans.")

    if request.method == "POST":
        title = request.POST.get("title", "").strip()
        if not title:
            messages.error(request, "A title is required.")
        else:
            plan = ActionPlan.objects.create(
                title=title,
                summary=request.POST.get("summary", "").strip(),
                scope_type=request.POST.get("scope_type", "national"),
                scope_value=request.POST.get("scope_value", "").strip(),
                severity=request.POST.get("severity", "moderate"),
                target_role=request.POST.get("target_role", ""),
                status="issued",
                is_auto=False,
                created_by=request.user,
                due_date=_parse_date(request.POST.get("due_date")),
            )
            for i, line in enumerate(request.POST.get("points", "").splitlines()):
                line = line.strip()
                if line:
                    ActionPoint.objects.create(plan=plan, text=line,
                                               owner_role=plan.target_role, order=i)
            messages.success(request, "Action plan created and issued.")
            return redirect("action_plan_detail", pk=plan.pk)

    default_scope_type, default_scope_value = scope_for_user(request.user)
    return render(request, "dashboard/actionplans/plan_new.html", {
        "scope_choices": SCOPE_CHOICES,
        "severity_choices": SEVERITY_CHOICES,
        "role_choices": ROLE_CHOICES,
        "templates": list(ActionPlanTemplate.objects.all()),
        "default_scope_type": default_scope_type,
        "default_scope_value": default_scope_value,
    })


def _parse_date(value):
    if not value:
        return None
    try:
        return datetime.strptime(value.strip(), "%Y-%m-%d").date()
    except (ValueError, AttributeError):
        return None
