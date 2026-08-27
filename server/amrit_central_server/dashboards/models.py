"""KPISnapshot — the only aggregate data stored at rest on the web portal.

The USP is that patient-level data never leaves the desktop apps. Dashboards,
however, cannot block on a live federated pull on every page load (sites go
offline; latency is seconds-to-minutes). So the portal stores the last computed
"important numbers" per (metric, scope, period) as a ``KPISnapshot`` and renders
from it instantly with an "as of <timestamp>" stamp. A "Refresh live" action
pulls fresh aggregate numbers from the desktop apps and writes a new snapshot.

A snapshot holds *only* aggregate values (numerator, denominator, %R, CI,
bucket counts) — never a patient identifier. The PII guard middleware still
rejects any patient-keyed payload before it can reach here.
"""

from __future__ import annotations

import uuid

from django.db import models
from django.utils import timezone


# Levels are numbered, never named. "state" and "district" named one country's two tiers
# and could not express a third; migration ``0005`` rewrote every stored row, and
# ``central.scopes.accepted_spellings`` still *accepts* the old words on input so a saved
# link or a scripted call does not break.
SCOPE_CHOICES = (
    ("site", "Site / facility"),
    ("global", "Global (all countries)"),
    ("country", "Country"),
    ("admin:1", "Administrative level 1"),
    ("admin:2", "Administrative level 2"),
    ("admin:3", "Administrative level 3"),
    ("admin:4", "Administrative level 4"),
    ("admin:5", "Administrative level 5"),
    ("admin:6", "Administrative level 6"),
)

SOURCE_CHOICES = (
    ("snapshot", "Scheduled snapshot"),
    ("live", "On-demand live pull"),
    ("seed", "Seeded demo"),
)


class DashboardRefreshRun(models.Model):
    """Audit record for one explicit dashboard Refresh live click."""

    STATUS_CHOICES = (
        ("pending", "Pending"),
        ("success", "Success"),
        ("partial", "Partial"),
        ("failed", "Failed"),
    )

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    scope_type = models.CharField(max_length=16, choices=SCOPE_CHOICES, default="country", db_index=True)
    scope_value = models.CharField(max_length=120, blank=True, db_index=True)
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default="pending", db_index=True)
    clicked_at = models.DateTimeField(default=timezone.now, db_index=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    expected_sites = models.PositiveIntegerField(default=0)
    responded_sites = models.PositiveIntegerField(default=0)
    failed_sites = models.PositiveIntegerField(default=0)
    records_represented = models.PositiveBigIntegerField(default=0)
    fhir_bundles = models.PositiveIntegerField(default=0)
    site_lab_codes = models.JSONField(default=list, blank=True)
    query_ids = models.JSONField(default=list, blank=True)

    class Meta:
        ordering = ["-clicked_at"]
        indexes = [
            models.Index(
                fields=["scope_type", "scope_value", "-clicked_at"],
                name="dash_refresh_scope_time_idx",
            )
        ]


class KPISnapshot(models.Model):
    """One computed metric value for one scope + period."""

    metric_key = models.CharField(max_length=64, db_index=True)
    scope_type = models.CharField(max_length=16, choices=SCOPE_CHOICES, default="country", db_index=True)
    scope_value = models.CharField(max_length=120, blank=True, db_index=True)  # "" for the whole country

    period_start = models.DateField(null=True, blank=True)
    period_end = models.DateField(null=True, blank=True)

    filters_json = models.JSONField(default=dict, blank=True)
    value_json = models.JSONField(default=dict, blank=True)
    n_sites = models.PositiveIntegerField(default=0)

    source = models.CharField(max_length=16, choices=SOURCE_CHOICES, default="snapshot")
    refresh_run = models.ForeignKey(
        DashboardRefreshRun,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="snapshots",
    )
    is_stale = models.BooleanField(default=False)
    computed_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        ordering = ["-computed_at"]
        indexes = [
            models.Index(fields=["metric_key", "scope_type", "scope_value", "-computed_at"]),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.metric_key}@{self.scope_type}:{self.scope_value or 'ALL'} ({self.computed_at:%Y-%m-%d %H:%M})"

    # ---- convenience --------------------------------------------------------
    @property
    def headline(self):
        """The single number a KPI tile shows, chosen by value shape."""
        v = self.value_json or {}
        for key in ("rate_percent", "value", "total"):
            if key in v and v[key] is not None:
                return v[key]
        return None

    @property
    def denominator(self):
        return (self.value_json or {}).get("denominator")

    @property
    def ci_text(self):
        v = self.value_json or {}
        lo, hi = v.get("ci_low_percent"), v.get("ci_high_percent")
        if lo is None or hi is None:
            return ""
        return f"{lo}–{hi}%"

    @classmethod
    def latest(cls, metric_key, scope_type="country", scope_value=""):
        return (
            cls.objects.filter(
                metric_key=metric_key,
                scope_type=scope_type,
                scope_value=scope_value,
                is_stale=False,
            )
            .order_by("-computed_at")
            .first()
        )

    @classmethod
    def latest_map(cls, metric_keys, scope_type="country", scope_value=""):
        """Newest snapshot per metric_key for a scope, as a dict."""
        out = {}
        for key in metric_keys:
            out[key] = cls.latest(key, scope_type, scope_value)
        return out
