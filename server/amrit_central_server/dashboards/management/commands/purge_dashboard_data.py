"""Remove every dashboard number this server has computed or been sent.

Why this exists
---------------
Dashboard figures are derived: KPI snapshots are computed from aggregate query results, and
both accumulate for as long as the server runs. A deployment that has been demonstrated,
tested or seeded carries figures nobody wants on screen any more, and a dashboard cannot be
reasoned about while it is showing a mixture of real and abandoned refreshes.

Nothing here touches the registry. Sites, their tokens and their enrolment stay exactly as
they are, so a purge is followed by a refresh rather than by re-enrolling every laboratory.
Action-plan rows raised *from* a snapshot are removed with it, because an alert whose
evidence is gone cannot be reviewed.

Usage
-----
    python manage.py purge_dashboard_data                # preview
    python manage.py purge_dashboard_data --apply        # delete
    python manage.py purge_dashboard_data --apply --keep-results
"""

from __future__ import annotations

from django.core.management.base import BaseCommand
from django.db import transaction

from dashboards.models import DashboardRefreshRun, KPISnapshot
from queries.models import Query, QueryDispatch, QueryResult


def _action_models():
    """The action-plan rows raised from a snapshot, if that app is installed.

    Only plans that a snapshot triggered are in scope: a plan written by hand is somebody's
    work, not derived data, and deleting dashboard numbers is no reason to lose it.
    """
    try:
        from actionplans.models import ActionPlan  # noqa: WPS433 - optional app
    except Exception:  # pragma: no cover - the app is optional
        return []
    return [ActionPlan]


class Command(BaseCommand):
    help = "Delete KPI snapshots, refresh runs and the aggregate query results they were computed from."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Actually delete. Without this the run is a preview.")
        parser.add_argument(
            "--keep-results", action="store_true",
            help="Keep the aggregate QueryResult rows; delete only the computed snapshots.",
        )
        parser.add_argument(
            "--keep-actions", action="store_true",
            help="Keep action-plan rows even though the snapshots they cite are being deleted.",
        )

    def handle(self, *args, **options):
        action_models = [] if options["keep_actions"] else _action_models()
        counts = {
            "KPI snapshots": KPISnapshot.objects.count(),
            "dashboard refresh runs": DashboardRefreshRun.objects.count(),
            "query results": 0 if options["keep_results"] else QueryResult.objects.count(),
            "query dispatches": 0 if options["keep_results"] else QueryDispatch.objects.count(),
            "queries": 0 if options["keep_results"] else Query.objects.count(),
        }
        for model in action_models:
            counts[f"snapshot-triggered {model._meta.verbose_name_plural.lower()}"] = (
                model.objects.filter(trigger_snapshot__isnull=False).count()
            )

        total = sum(counts.values())
        verb = "Deleted" if options["apply"] else "Would delete"
        for label, rows in counts.items():
            self.stdout.write(f"  {verb} {rows} {label}")

        if not options["apply"]:
            self.stdout.write(self.style.WARNING(
                f"Preview only — {total} rows would be deleted. Re-run with --apply.\n"
                "Sites and their tokens are not touched; dashboards refill on the next refresh."
            ))
            return

        with transaction.atomic():
            for model in action_models:
                model.objects.filter(trigger_snapshot__isnull=False).delete()
            KPISnapshot.objects.all().delete()
            DashboardRefreshRun.objects.all().delete()
            if not options["keep_results"]:
                QueryResult.objects.all().delete()
                QueryDispatch.objects.all().delete()
                Query.objects.all().delete()

        self.stdout.write(self.style.SUCCESS(f"{total} rows deleted."))
        self.stdout.write("Dashboards are empty until the next refresh, scheduled or from the Refresh button.")
