"""Retention: expiry of row-level operational data the server holds.

The server is aggregate-first — row-level isolate data never leaves the site — but it does
accumulate an operational trail: the queries it issued, what came back, and the poll audit.
Several jurisdictions cap how long that may be kept, and until now nothing expired.

Deliberately NOT purged:

* ``KPISnapshot`` — the aggregate surveillance record itself. It is what the system exists
  to produce, carries no row-level personal data, and deleting it would silently rewrite
  published history.
* ``Site``, ``UserProfile``, geography, roles and configuration. These describe the
  deployment, not a person, and removing them would break referential integrity.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from .privacy import retention_days


@dataclass(frozen=True)
class RetentionTarget:
    label: str
    model_path: str
    #: Field carrying the row's age. Always the latest available, never the earliest.
    field: str


#: ``QueryDispatch`` is deliberately absent: it carries no timestamp of its own that is
#: always set, and it cascades from its ``Query``, so it expires with the query it belongs
#: to rather than on a date it cannot supply.
RETENTION_TARGETS: tuple[RetentionTarget, ...] = (
    RetentionTarget("Poll audit entries", "queries.PollAuditEntry", "created_at"),
    RetentionTarget("Query results", "queries.QueryResult", "received_at"),
    RetentionTarget("Queries", "queries.Query", "created_at"),
    RetentionTarget("Dashboard refresh runs", "dashboards.DashboardRefreshRun", "clicked_at"),
)


def cutoff_for(days: int | None, *, now=None):
    """The instant on or after which data is kept, or None when retention is unset."""
    if days is None:
        return None
    if int(days) < 1:
        raise ValueError(f"Retention must be at least 1 day: {days!r}")
    return (now or timezone.now()) - timedelta(days=int(days))


def _model(path: str):
    from django.apps import apps

    app_label, model_name = path.split(".", 1)
    return apps.get_model(app_label, model_name)


def purge_expired(*, country_code: str | None = None, days: int | None = None, dry_run: bool = True, now=None) -> dict:
    """Report — and when ``dry_run`` is false, delete — data past the retention period.

    Ordered child-before-parent so a cascade never removes a row this pass has already
    counted, and wrapped in one transaction so a failure leaves nothing half-purged.
    """
    period = days if days is not None else retention_days(country_code)
    cutoff = cutoff_for(period, now=now)
    if cutoff is None:
        return {"applied": False, "dry_run": dry_run, "retention_days": None, "cutoff": None, "removed": []}

    removed = []

    def run() -> None:
        for target in RETENTION_TARGETS:
            queryset = _model(target.model_path).objects.filter(**{f"{target.field}__lt": cutoff})
            count = queryset.count()
            removed.append({"label": target.label, "model": target.model_path, "rows": count})
            if not dry_run and count:
                queryset.delete()

    if dry_run:
        run()
    else:
        with transaction.atomic():
            run()

    return {
        "applied": True,
        "dry_run": dry_run,
        "retention_days": int(period),
        "cutoff": cutoff.isoformat(),
        "removed": removed,
    }
