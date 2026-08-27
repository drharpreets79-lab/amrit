"""Recompute KPISnapshots from stored aggregate results.

Run on a schedule (cron / Celery-beat / a docker compose sidecar):

    python manage.py refresh_snapshots            # national + every state/district/site
    python manage.py refresh_snapshots --scope national
    python manage.py refresh_snapshots --live     # dispatch a live pull first

The live pull enqueues fresh aggregate queries to the sites; they answer on
their next long-poll, then the snapshot sweep rolls those results up.
"""

from __future__ import annotations

from django.core.management.base import BaseCommand

from dashboards.refresh import dispatch_live_pull, refresh_all_scopes, refresh_scope


class Command(BaseCommand):
    help = "Recompute KPI snapshots for dashboards from aggregate results."

    def add_arguments(self, parser):
        parser.add_argument("--scope", choices=["country", "all"], default="all")
        parser.add_argument("--live", action="store_true",
                            help="Dispatch a live pull to sites before rolling up.")

    def handle(self, *args, **opts):
        if opts["live"]:
            summary = dispatch_live_pull("country", "")
            self.stdout.write(self.style.WARNING(
                f"live pull dispatched: {summary['dispatched_queries']} queries "
                f"to {summary['sites']} sites ({summary['nudged']} nudged over WebSocket)"
            ))

        if opts["scope"] == "country":
            written = refresh_scope("country", "")
        else:
            written = refresh_all_scopes()

        self.stdout.write(self.style.SUCCESS(f"snapshots written: {written}"))
