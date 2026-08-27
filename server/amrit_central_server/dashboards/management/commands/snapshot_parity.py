"""Snapshot-parity harness for the scope refactor.

Phase 5 rewrites how every KPI is scoped. The only convincing evidence that it changed
nothing is to compute every snapshot before and after and diff the numbers.

    # before the refactor
    python manage.py snapshot_parity --write /tmp/before.json
    # after
    python manage.py snapshot_parity --compare /tmp/before.json

Snapshots are keyed here by the *withdrawn* spellings ("national", "state", "district")
purely as a stable alias: a capture taken before either scope rename and one taken after
then line up, even though what is stored changed twice. Nothing writes these spellings any
more. Values are compared exactly; a non-empty diff fails.
"""

from __future__ import annotations

import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from dashboards.models import KPISnapshot

# Canonical -> the withdrawn spelling, so captures from either side of a rename line up.
LEGACY_SCOPE = {"country": "national", "admin:1": "state", "admin:2": "district"}


def _legacy(scope_type: str) -> str:
    return LEGACY_SCOPE.get(scope_type, scope_type)


def capture(since=None) -> dict:
    """The newest snapshot per (metric, scope), which is what dashboards render.

    ``fresh`` records whether the row was produced by this run. Without it a scope that
    silently stopped being refreshed would still compare equal, because its stale row is
    still the newest one — which is exactly how a real fan-out regression hid here once.
    """
    newest: dict[str, dict] = {}
    for snapshot in KPISnapshot.objects.order_by("computed_at"):
        key = f"{snapshot.metric_key}|{_legacy(snapshot.scope_type)}|{snapshot.scope_value}"
        newest[key] = {
            "value": snapshot.value_json,
            "n_sites": snapshot.n_sites,
            "period_start": snapshot.period_start.isoformat() if snapshot.period_start else None,
            "period_end": snapshot.period_end.isoformat() if snapshot.period_end else None,
            "fresh": bool(since and snapshot.computed_at >= since),
        }
    return dict(sorted(newest.items()))


# Metrics whose value depends on the wall clock, so two runs minutes apart legitimately
# differ. Their denominators are still compared exactly — only the time-varying numerator
# is exempt, and every exemption is printed rather than applied silently.
TIME_DEPENDENT_METRICS = {"cov_sites_online"}
STABLE_KEYS_FOR_TIME_DEPENDENT = ("total",)


def diff(before: dict, after: dict) -> tuple[list[str], list[str]]:
    """Return (failures, notes).

    A new key inside a value is a note rather than a failure: the refactor adds
    per-level coverage counts alongside the existing ones. Every key present in the
    baseline must still be present and identical.
    """
    problems: list[str] = []
    notes: list[str] = []

    for key in sorted(set(before) - set(after)):
        problems.append(f"missing after refactor: {key}")
    for key in sorted(set(after) - set(before)):
        problems.append(f"appeared after refactor: {key}")

    for key in sorted(set(before) & set(after)):
        metric = key.split("|", 1)[0]
        old, new = before[key], after[key]
        if {k: v for k, v in old.items() if k != "fresh"} == {k: v for k, v in new.items() if k != "fresh"}:
            if old.get("fresh") and not new.get("fresh"):
                problems.append(f"no longer recomputed: {key}")
            continue

        if old.get("fresh") and not new.get("fresh"):
            problems.append(f"no longer recomputed: {key}")
            continue

        old_value, new_value = old.get("value"), new.get("value")
        if metric in TIME_DEPENDENT_METRICS:
            for field in STABLE_KEYS_FOR_TIME_DEPENDENT:
                if isinstance(old_value, dict) and old_value.get(field) != (new_value or {}).get(field):
                    problems.append(f"changed ({field}): {key}: {old_value.get(field)} -> {(new_value or {}).get(field)}")
            notes.append(f"time-dependent, value not compared: {key}")
            continue

        if isinstance(old_value, dict) and isinstance(new_value, dict):
            shared_changed = {
                field: (old_value[field], new_value.get(field))
                for field in old_value
                if old_value[field] != new_value.get(field)
            }
            ignored = {"value", "fresh"}
            rest_old = {field: value for field, value in old.items() if field not in ignored}
            rest_new = {field: value for field, value in new.items() if field not in ignored}
            if not shared_changed and rest_old == rest_new:
                added = sorted(set(new_value) - set(old_value))
                notes.append(f"keys added, existing values unchanged: {key} (+{', '.join(added)})")
                continue

        problems.append(
            f"changed: {key}\n    before {json.dumps(old, sort_keys=True)}\n    after  {json.dumps(new, sort_keys=True)}"
        )
    return problems, notes


class Command(BaseCommand):
    help = "Capture or compare every KPI snapshot value, to prove the scope refactor changed nothing."

    def add_arguments(self, parser):
        parser.add_argument("--write", help="compute snapshots and write the capture to this path")
        parser.add_argument("--compare", help="recompute snapshots and diff against this capture")
        parser.add_argument(
            "--no-refresh",
            action="store_true",
            help="use the snapshots already stored rather than recomputing them",
        )

    def handle(self, *args, **options):
        if not options["write"] and not options["compare"]:
            raise CommandError("pass --write <path> or --compare <path>")

        since = None
        if not options["no_refresh"]:
            from django.utils import timezone

            from dashboards.refresh import refresh_all_scopes

            since = timezone.now()
            written = refresh_all_scopes(source="snapshot")
            self.stdout.write(f"refreshed {written} snapshot(s)")

        current = capture(since)

        if options["write"]:
            Path(options["write"]).write_text(json.dumps(current, indent=2, sort_keys=True), encoding="utf-8")
            self.stdout.write(self.style.SUCCESS(f"captured {len(current)} snapshot value(s) -> {options['write']}"))
            return

        baseline = json.loads(Path(options["compare"]).read_text(encoding="utf-8"))
        problems, notes = diff(baseline, current)
        if notes:
            self.stdout.write(f"{len(notes)} accepted difference(s):")
            for note in notes[:10]:
                self.stdout.write(f"  · {note}")
            if len(notes) > 10:
                self.stdout.write(f"  · ... and {len(notes) - 10} more of the same kinds")
        if problems:
            self.stdout.write(self.style.ERROR(f"{len(problems)} difference(s) against the baseline:"))
            for problem in problems[:40]:
                self.stdout.write(f"  - {problem}")
            if len(problems) > 40:
                self.stdout.write(f"  ... and {len(problems) - 40} more")
            raise CommandError("snapshot parity failed")
        self.stdout.write(self.style.SUCCESS(f"snapshot parity holds across {len(current)} value(s)"))
