"""Remove every registered site, and everything that only exists because of one.

Why this exists
---------------
A registry that has been used for testing or for a demonstration ends up holding sites
nobody wants to keep, and there is no per-row way to get back to an empty registry: each
site drags dispatches, results, audit entries and enrolment paperwork behind it.

What it does not do is soften the consequence. Deleting a site destroys the credentials the
desktop installation holds, so every laboratory that was enrolled has to request access and
collect a new token before it can sync again. That is stated before anything is deleted, and
the run is a preview unless ``--apply`` is given.

Usage
-----
    python manage.py purge_sites                 # preview
    python manage.py purge_sites --apply         # delete
    python manage.py purge_sites --apply --keep-requests
"""

from __future__ import annotations

from django.core.management.base import BaseCommand
from django.db import transaction

from queries.models import PollAuditEntry, QueryDispatch, QueryResult
from sites.models import Site, SiteEnrolmentRequest


class Command(BaseCommand):
    help = "Delete every site, its queued work, its results and its enrolment requests."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Actually delete. Without this the run is a preview.")
        parser.add_argument(
            "--keep-requests", action="store_true",
            help="Leave the enrolment request rows in place, so the registry history survives.",
        )
        parser.add_argument(
            "--keep-audit", action="store_true",
            help="Leave poll audit entries in place. They survive site deletion anyway, with a null site.",
        )

    def handle(self, *args, **options):
        counts = {
            "sites": Site.objects.count(),
            "query dispatches": QueryDispatch.objects.count(),
            "query results": QueryResult.objects.count(),
            "enrolment requests": 0 if options["keep_requests"] else SiteEnrolmentRequest.objects.count(),
            "poll audit entries": 0 if options["keep_audit"] else PollAuditEntry.objects.count(),
        }
        total = sum(counts.values())
        verb = "Deleted" if options["apply"] else "Would delete"
        for label, rows in counts.items():
            self.stdout.write(f"  {verb} {rows} {label}")

        if not options["apply"]:
            self.stdout.write(self.style.WARNING(
                f"Preview only — {total} rows would be deleted. Re-run with --apply.\n"
                "Every enrolled desktop would have to request access and collect a new token."
            ))
            return

        with transaction.atomic():
            if not options["keep_audit"]:
                PollAuditEntry.objects.all().delete()
            if not options["keep_requests"]:
                SiteEnrolmentRequest.objects.all().delete()
            # Dispatches and results cascade from the site, but they are deleted first so a
            # failure part-way leaves no orphaned aggregate rows pointing at a live site.
            QueryResult.objects.all().delete()
            QueryDispatch.objects.all().delete()
            Site.objects.all().delete()

        self.stdout.write(self.style.SUCCESS(f"{total} rows deleted. The registry is empty."))
        self.stdout.write(
            "Every laboratory now has to use Request access on its desktop, and an administrator "
            "has to approve it, before that laboratory can sync again."
        )
