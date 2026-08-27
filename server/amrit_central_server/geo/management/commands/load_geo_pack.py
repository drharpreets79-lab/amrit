"""Load a country's administrative units from a geo pack."""

from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from geo.loader import GeoPackError, available_packs, load_pack, read_pack


class Command(BaseCommand):
    help = "Load administrative units from a geo pack (shared/geo-packs/<CODE>.json or a path)."

    def add_arguments(self, parser):
        parser.add_argument("source", nargs="?", help="profile id, ISO 3166-1 alpha-3, or a path")
        parser.add_argument("--list", action="store_true", help="list the packs shipped with this build")

    def handle(self, *args, **options):
        if options["list"] or not options["source"]:
            packs = available_packs()
            if not packs:
                self.stdout.write("No geo packs are bundled with this build.")
                return
            self.stdout.write("Available geo packs: " + ", ".join(packs))
            if not options["source"]:
                return

        try:
            pack = read_pack(options["source"])
        except GeoPackError as error:
            raise CommandError(str(error)) from error

        result = load_pack(pack)
        self.stdout.write(
            self.style.SUCCESS(
                f"{result['country_code']}: {result['total']} unit(s) "
                f"({result['created']} created, {result['updated']} updated)"
            )
        )
