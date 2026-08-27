"""Rewrite action-plan and threshold-rule scopes into level numbers.

Same change as ``dashboards.0005``, for the rows that decide which plans an operator sees:
a plan addressed to "district" was addressed to a tier only some countries have.
"""

from __future__ import annotations

from django.db import migrations


CANONICAL = {"national": "country", "state": "admin:1", "district": "admin:2"}
REVERSE = {value: key for key, value in CANONICAL.items()}


def _rewrite(apps, mapping):
    for model_name in ("ActionPlan", "ThresholdRule"):
        model = apps.get_model("actionplans", model_name)
        for old, new in mapping.items():
            model.objects.filter(scope_type=old).update(scope_type=new)


def canonicalise(apps, schema_editor):
    _rewrite(apps, CANONICAL)


def restore(apps, schema_editor):
    _rewrite(apps, REVERSE)


class Migration(migrations.Migration):
    dependencies = [("actionplans", "0002_alter_actionplan_scope_type_and_more")]

    operations = [migrations.RunPython(canonicalise, restore)]
