"""Persistent queue + result store for aggregate queries dispatched to AMRIT sites."""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone

SUPPORTED_QUERY_TYPES = (
    ("heartbeat", "Heartbeat"),
    ("isolate_count", "Isolate count"),
    ("organism_distribution", "Organism distribution"),
    ("specimen_distribution", "Specimen distribution"),
    ("resistance_rate", "Resistance rate"),
    ("measure_bundle", "FHIR MeasureReport bundle"),
    ("cluster_scan", "Outbreak scan aggregate cases"),
)

SUPPORTED_QUERY_TYPE_VALUES = tuple(code for code, _label in SUPPORTED_QUERY_TYPES)


class Query(models.Model):
    """A query authored on the central server, dispatched to one or more sites."""

    STATUS_CHOICES = (
        ("queued", "Queued"),
        ("dispatched", "Dispatched"),
        ("partial", "Partial"),
        ("completed", "Completed"),
        ("expired", "Expired"),
        ("error", "Error"),
        ("cancelled", "Cancelled"),
    )

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    type = models.CharField(max_length=64, choices=SUPPORTED_QUERY_TYPES, db_index=True)
    title = models.CharField(max_length=200, blank=True)
    notes = models.TextField(blank=True)

    target_lab_codes = models.JSONField(default=list, blank=True)
    """Empty list = all active sites; otherwise broadcast to listed lab_codes."""

    antibiotic_code = models.CharField(max_length=16, blank=True)
    filters = models.JSONField(default=dict, blank=True)

    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default="queued", db_index=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="amrit_queries",
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    expires_at = models.DateTimeField(null=True, blank=True, db_index=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:  # pragma: no cover
        return f"{self.type} · {self.id}"

    def is_expired(self) -> bool:
        return bool(self.expires_at and timezone.now() >= self.expires_at)

    def to_amrit_payload(self, lab_code: str) -> dict:
        """Serialize as the JSON object an AMRIT site expects from /v1/poll."""
        body = {
            "id": str(self.id),
            "type": self.type,
            "lab_code": lab_code,
            "filters": self.filters or {},
        }
        if self.antibiotic_code:
            body["antibiotic_code"] = self.antibiotic_code
        return body


class QueryDispatch(models.Model):
    """One row per (query, site) — created either eagerly when site is enumerated
    or lazily on first long-poll if target_lab_codes is empty."""

    STATUS_CHOICES = (
        ("pending", "Pending"),
        ("delivered", "Delivered"),
        ("answered", "Answered"),
        ("error", "Error"),
        ("expired", "Expired"),
    )

    query = models.ForeignKey(Query, on_delete=models.CASCADE, related_name="dispatches")
    site = models.ForeignKey("amrit_sites.Site", on_delete=models.CASCADE, related_name="dispatches")
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default="pending", db_index=True)
    delivered_at = models.DateTimeField(null=True, blank=True)
    answered_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        unique_together = (("query", "site"),)
        indexes = [
            models.Index(fields=["site", "status"]),
            models.Index(fields=["query", "status"]),
        ]


class QueryResult(models.Model):
    """Aggregate JSON returned by a site for a dispatched query."""

    query = models.ForeignKey(Query, on_delete=models.CASCADE, related_name="results")
    site = models.ForeignKey("amrit_sites.Site", on_delete=models.CASCADE, related_name="results")
    ok = models.BooleanField(default=True)
    result_json = models.JSONField(default=dict, blank=True)
    fhir_json = models.JSONField(default=dict, blank=True)
    error = models.TextField(blank=True)
    received_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-received_at"]
        indexes = [
            models.Index(fields=["query", "received_at"]),
            models.Index(fields=["site", "received_at"]),
        ]


class PollAuditEntry(models.Model):
    """Server-side audit of every poll + response. Mirrors the AMRIT site audit log."""

    site = models.ForeignKey(
        "amrit_sites.Site", on_delete=models.SET_NULL, null=True, blank=True, related_name="audit_entries"
    )
    lab_code = models.CharField(max_length=32, blank=True, db_index=True)
    action = models.CharField(max_length=32, db_index=True)
    query = models.ForeignKey(Query, on_delete=models.SET_NULL, null=True, blank=True)
    detail = models.TextField(blank=True)
    error = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at"]
