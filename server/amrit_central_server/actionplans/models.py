"""Action plans, action points, and Action-Taken Reports (ATRs).

This is the workflow the USP explicitly stores on the web portal: draft action
plans raised when a KPI breaches a threshold, the action points stakeholders own
and track, and the ATRs they file. No patient data — only the aggregate number
that triggered a plan (``observed_value``) plus free-text narrative.
"""

from __future__ import annotations

from django.conf import settings
from django.db import models
from django.utils import timezone

from dashboards.models import SCOPE_CHOICES

SEVERITY_CHOICES = (
    ("info", "Info"),
    ("moderate", "Moderate"),
    ("high", "High"),
    ("critical", "Critical"),
)
SEVERITY_ORDER = {"info": 0, "moderate": 1, "high": 2, "critical": 3}

PLAN_STATUS_CHOICES = (
    ("draft", "Draft"),
    ("issued", "Issued"),
    ("in_progress", "In progress"),
    ("completed", "Completed"),
    ("closed", "Closed"),
    ("dismissed", "Dismissed"),
)
OPEN_STATUSES = ("draft", "issued", "in_progress")

POINT_STATUS_CHOICES = (
    ("open", "Open"),
    ("in_progress", "In progress"),
    ("blocked", "Blocked"),
    ("done", "Done"),
)

COMPARATORS = (
    ("gt", "greater than"),
    ("gte", "greater than or equal"),
    ("lt", "less than"),
    ("lte", "less than or equal"),
)


class ThresholdRule(models.Model):
    """When ``metric_key`` at ``scope_type`` breaches ``threshold``, draft a plan."""

    name = models.CharField(max_length=200)
    metric_key = models.CharField(max_length=64, db_index=True)
    scope_type = models.CharField(max_length=16, choices=SCOPE_CHOICES, default="country")
    comparator = models.CharField(max_length=4, choices=COMPARATORS, default="gte")
    threshold = models.FloatField(help_text="Compared against the metric's headline value (e.g. %R).")
    severity = models.CharField(max_length=12, choices=SEVERITY_CHOICES, default="high")
    target_role = models.CharField(max_length=32, blank=True, help_text="Role the plan is addressed to.")

    title_template = models.CharField(max_length=200, blank=True)
    body_template = models.TextField(blank=True)
    default_action_points = models.JSONField(default=list, blank=True)

    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["metric_key", "-threshold"]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.name} ({self.metric_key} {self.comparator} {self.threshold})"

    def breached(self, value) -> bool:
        if value is None:
            return False
        return {
            "gt": value > self.threshold,
            "gte": value >= self.threshold,
            "lt": value < self.threshold,
            "lte": value <= self.threshold,
        }[self.comparator]


class ActionPlanTemplate(models.Model):
    """Reusable preset for manual plan authoring (not threshold-triggered)."""

    name = models.CharField(max_length=200)
    severity = models.CharField(max_length=12, choices=SEVERITY_CHOICES, default="moderate")
    summary = models.TextField(blank=True)
    default_action_points = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:  # pragma: no cover
        return self.name


class ActionPlan(models.Model):
    """A plan targeted at a stakeholder role + scope, tracked to completion."""

    title = models.CharField(max_length=200)
    summary = models.TextField(blank=True)

    trigger_metric_key = models.CharField(max_length=64, blank=True, db_index=True)
    trigger_snapshot = models.ForeignKey(
        "dashboards.KPISnapshot", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="action_plans",
    )
    threshold_rule = models.ForeignKey(
        ThresholdRule, on_delete=models.SET_NULL, null=True, blank=True, related_name="plans",
    )
    observed_value = models.FloatField(null=True, blank=True)

    scope_type = models.CharField(max_length=16, choices=SCOPE_CHOICES, default="country", db_index=True)
    scope_value = models.CharField(max_length=120, blank=True, db_index=True)

    severity = models.CharField(max_length=12, choices=SEVERITY_CHOICES, default="moderate", db_index=True)
    status = models.CharField(max_length=16, choices=PLAN_STATUS_CHOICES, default="draft", db_index=True)
    target_role = models.CharField(max_length=32, blank=True, db_index=True)

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="authored_plans",
    )
    is_auto = models.BooleanField(default=False, help_text="Raised by the threshold rule engine.")
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)
    due_date = models.DateField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["scope_type", "scope_value", "status"])]

    def __str__(self) -> str:  # pragma: no cover
        return self.title

    @property
    def is_open(self) -> bool:
        return self.status in OPEN_STATUSES

    @property
    def severity_rank(self) -> int:
        return SEVERITY_ORDER.get(self.severity, 0)

    @property
    def is_overdue(self) -> bool:
        return bool(self.due_date and self.is_open and self.due_date < timezone.now().date())

    def progress(self) -> dict:
        pts = list(self.points.all())
        total = len(pts)
        done = sum(1 for p in pts if p.status == "done")
        return {"total": total, "done": done,
                "percent": round(done / total * 100) if total else 0}


class ActionPoint(models.Model):
    """One trackable task inside a plan."""

    plan = models.ForeignKey(ActionPlan, on_delete=models.CASCADE, related_name="points")
    text = models.CharField(max_length=400)
    owner_role = models.CharField(max_length=32, blank=True)
    owner_user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="owned_action_points",
    )
    status = models.CharField(max_length=16, choices=POINT_STATUS_CHOICES, default="open", db_index=True)
    due_date = models.DateField(null=True, blank=True)
    order = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["order", "id"]

    def __str__(self) -> str:  # pragma: no cover
        return self.text[:60]


class ActionTakenReport(models.Model):
    """An ATR: narrative + the aggregate evidence cited, filed against a plan/point."""

    plan = models.ForeignKey(ActionPlan, on_delete=models.CASCADE, related_name="atrs")
    action_point = models.ForeignKey(
        ActionPoint, on_delete=models.SET_NULL, null=True, blank=True, related_name="atrs",
    )
    narrative = models.TextField()
    evidence_numbers_json = models.JSONField(default=dict, blank=True,
                                             help_text="Aggregate KPI values cited (no patient data).")
    attachment_url = models.URLField(blank=True)
    reported_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="filed_atrs",
    )
    reported_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-reported_at"]

    def __str__(self) -> str:  # pragma: no cover
        return f"ATR · {self.plan.title[:40]} · {self.reported_at:%Y-%m-%d}"
