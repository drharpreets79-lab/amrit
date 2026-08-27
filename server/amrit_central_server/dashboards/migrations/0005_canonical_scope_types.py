"""Rewrite stored scope names into level numbers.

``national``/``state``/``district`` described one country's hierarchy: a country with three
sub-national levels had nowhere to put its third, and one with a single level carried a
scope called "district" it could never use. Snapshots and refresh runs now store
``country`` and ``admin:<level>``.

Nothing is lost and nothing moves: the level a row described is the level it still
describes. Old spellings remain *accepted on input* (``central.scopes.accepted_spellings``)
so a saved link or a scripted call keeps resolving.
"""

from __future__ import annotations

from django.db import migrations


CANONICAL = {"national": "country", "state": "admin:1", "district": "admin:2"}
REVERSE = {value: key for key, value in CANONICAL.items()}


def _rewrite(apps, mapping):
    for model_name in ("KPISnapshot", "DashboardRefreshRun"):
        model = apps.get_model("dashboards", model_name)
        for old, new in mapping.items():
            model.objects.filter(scope_type=old).update(scope_type=new)


def canonicalise(apps, schema_editor):
    _rewrite(apps, CANONICAL)


def restore(apps, schema_editor):
    """Only the two levels the old spellings could express come back; deeper ones stay."""
    _rewrite(apps, REVERSE)


class Migration(migrations.Migration):
    dependencies = [("dashboards", "0004_alter_dashboardrefreshrun_scope_type_and_more")]

    operations = [migrations.RunPython(canonicalise, restore)]
