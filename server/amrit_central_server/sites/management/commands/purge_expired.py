"""Expire row-level operational data past the profile's retention period.

Defaults to a dry run. A purge cannot be undone from inside the application, so the
operator sees what would go before anything does; ``--apply`` is the deliberate second step.
"""

from django.core.management.base import BaseCommand, CommandError

from central.privacy import retention_days
from central.retention import purge_expired


class Command(BaseCommand):
    help = "Delete operational data older than the retention period set by the country profile."

    def add_arguments(self, parser):
        parser.add_argument("--country", default=None, help="Country code whose profile sets the period.")
        parser.add_argument("--days", type=int, default=None, help="Override the profile's retention period.")
        parser.add_argument("--apply", action="store_true", help="Actually delete. Without this the run is a preview.")

    def handle(self, *args, **options):
        country = options["country"]
        days = options["days"]
        if days is not None and days < 1:
            raise CommandError("--days must be at least 1.")

        if days is None and retention_days(country) is None:
            self.stdout.write(
                "No retention period is configured, so nothing expires. "
                "Set privacy.retention_days on the country profile, or pass --days."
            )
            return

        result = purge_expired(country_code=country, days=days, dry_run=not options["apply"])
        verb = "Deleted" if options["apply"] else "Would delete"
        self.stdout.write(f"Retention {result['retention_days']} days; cutoff {result['cutoff']}.")
        total = 0
        for entry in result["removed"]:
            total += entry["rows"]
            self.stdout.write(f"  {verb} {entry['rows']} from {entry['label']}")
        if not options["apply"]:
            self.stdout.write(self.style.WARNING(f"Preview only — {total} rows would be deleted. Re-run with --apply."))
        else:
            self.stdout.write(self.style.SUCCESS(f"{total} rows deleted."))
