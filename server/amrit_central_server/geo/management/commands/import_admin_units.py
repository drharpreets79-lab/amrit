"""Import administrative units from a CSV.

The path for a country whose deeper levels nobody has packaged. Accepts the same column
set as tools/generate_geo_pack.py, and a GeoNames admin1/admin2 export mapped onto it.

    level,code,parent_code,name,name_local,unit_type,active,sort_order

Levels are described with --level, repeated once per level:

    --level 1:state:State:States:ISO3166-2
"""

from __future__ import annotations

import csv
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from geo.loader import GeoPackError, load_pack, validate_pack
import hashlib

from geo.loader import canonical_bytes


class Command(BaseCommand):
    help = "Import administrative units for a country from a CSV file."

    def add_arguments(self, parser):
        parser.add_argument("--country", required=True, help="ISO 3166-1 alpha-3")
        parser.add_argument("--name", default="", help="country display name")
        parser.add_argument("--file", required=True, help="CSV of administrative units")
        parser.add_argument(
            "--level",
            action="append",
            default=[],
            required=True,
            help="number:key:label:label_plural:code_system (repeat per level)",
        )
        parser.add_argument("--dry-run", action="store_true", help="validate and report without writing")

    def handle(self, *args, **options):
        country = str(options["country"]).strip().upper()
        if len(country) != 3 or not country.isalpha():
            raise CommandError("--country must be an ISO 3166-1 alpha-3 code")

        levels = []
        for specification in options["level"]:
            parts = specification.split(":")
            if len(parts) != 5 or not parts[0].isdigit():
                raise CommandError(
                    f"--level must be 'number:key:label:label_plural:code_system', got {specification!r}"
                )
            levels.append(
                {
                    "level": int(parts[0]),
                    "key": parts[1],
                    "label": parts[2],
                    "label_plural": parts[3],
                    "code_system": parts[4],
                }
            )

        path = Path(options["file"])
        if not path.is_file():
            raise CommandError(f"file not found: {path}")

        declared = {level["level"] for level in levels}
        units = []
        with path.open(newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            missing = {"level", "code", "name"} - set(reader.fieldnames or [])
            if missing:
                raise CommandError(f"missing required column(s): {', '.join(sorted(missing))}")
            for line, row in enumerate(reader, start=2):
                level_text = str(row.get("level", "")).strip()
                if not level_text:
                    continue
                if not level_text.isdigit() or int(level_text) not in declared:
                    raise CommandError(f"line {line}: level {level_text!r} has no matching --level definition")
                code = str(row.get("code", "")).strip()
                name = str(row.get("name", "")).strip()
                if not code or not name:
                    raise CommandError(f"line {line}: code and name are both required")
                sort_text = str(row.get("sort_order", "") or "0").strip()
                units.append(
                    {
                        "level": int(level_text),
                        "code": code,
                        "parent_code": str(row.get("parent_code", "") or "").strip() or None,
                        "name": name,
                        "name_local": str(row.get("name_local", "") or "").strip() or None,
                        "unit_type": str(row.get("unit_type", "") or "").strip() or None,
                        "active": 0 if str(row.get("active", "1")).strip() in {"0", "false", "False"} else 1,
                        "sort_order": int(sort_text) if sort_text.lstrip("-").isdigit() else 0,
                    }
                )

        pack = {
            "schemaVersion": 1,
            "dataset": "amrit-geo-pack",
            "version": "imported",
            "countryCode": country,
            "countryName": options["name"] or country,
            "levels": sorted(levels, key=lambda level: level["level"]),
            "minimumCounts": {},
            "rowCounts": {"total": len(units)},
            "contentSha256": hashlib.sha256(canonical_bytes(units)).hexdigest(),
            "units": units,
        }

        # Validated with exactly the rules the packaged loader applies, so an import can
        # never introduce a tree the runtime would reject.
        try:
            validate_pack(pack)
        except GeoPackError as error:
            raise CommandError(str(error)) from error

        if options["dry_run"]:
            by_level = {level["level"]: sum(1 for unit in units if unit["level"] == level["level"]) for level in levels}
            self.stdout.write(f"{country}: {len(units)} unit(s) would be imported {by_level}")
            return

        result = load_pack(pack)
        self.stdout.write(
            self.style.SUCCESS(
                f"{result['country_code']}: {result['total']} unit(s) "
                f"({result['created']} created, {result['updated']} updated)"
            )
        )
