"""Replace the ecosystem's two-level geography with an administrative path.

``Organization.state_code``/``district_code`` and ``ProgrammeMilestone.state_code`` said
where a body's remit or a target sits by naming one country's two tiers. A country with
three sub-national levels could not express its third, and one with a single level had a
district column it could never fill. Both become ``admin_path``, the materialised path of
codes that the rest of this server already scopes on.

The codes are lifted, not dropped: each is resolved against the administrative tree and the
row keeps the path of the unit it named. A code the tree does not carry is reported, and
its row is left with no path rather than a guessed one — an organisation attached to the
wrong place is worse than one attached to none.

``organization_type`` loses ``state`` and ``district`` for the same reason; both become
``sub_national``, and how deep a body actually sits is what its ``admin_path`` says.
"""

from __future__ import annotations

from django.db import migrations, models


def lift_codes_to_paths(apps, schema_editor):
    AdminUnit = apps.get_model("geo", "AdminUnit")
    Organization = apps.get_model("ecosystem", "Organization")
    ProgrammeMilestone = apps.get_model("ecosystem", "ProgrammeMilestone")

    units = list(AdminUnit.objects.all())
    by_level_code: dict[tuple[int, str], list] = {}
    for unit in units:
        by_level_code.setdefault((unit.level, unit.code), []).append(unit)

    def resolve(level: int, code: str):
        candidates = by_level_code.get((level, str(code).strip()), [])
        return candidates[0] if len(candidates) == 1 else None

    unresolved: list[str] = []

    for organization in Organization.objects.all():
        district = (organization.district_code or "").strip()
        state = (organization.state_code or "").strip()
        if not (district or state):
            continue
        unit = (resolve(2, district) if district else None) or (resolve(1, state) if state else None)
        if unit is None:
            unresolved.append(f"organization {organization.code}: {state!r}/{district!r}")
            continue
        organization.admin_path = unit.admin_path
        organization.country_code = unit.country_code
        organization.save(update_fields=["admin_path", "country_code"])

    for milestone in ProgrammeMilestone.objects.all():
        code = (milestone.state_code or "").strip()
        if not code:
            continue
        unit = resolve(1, code)
        if unit is None:
            unresolved.append(f"milestone {milestone.objective_code}: {code!r}")
            continue
        milestone.admin_path = unit.admin_path
        milestone.save(update_fields=["admin_path"])

    if unresolved:
        print(f"\n  {len(unresolved)} ecosystem row(s) named a code with no administrative unit:")
        for entry in unresolved[:20]:
            print(f"    - {entry}")
        if len(unresolved) > 20:
            print(f"    ... and {len(unresolved) - 20} more")
        print("  Load the country's geo pack and set their administrative unit.")


def retype_organizations(apps, schema_editor):
    Organization = apps.get_model("ecosystem", "Organization")
    Organization.objects.filter(organization_type__in=["state", "district"]).update(organization_type="sub_national")


def noop(apps, schema_editor):
    """Reverse restores the columns empty: which level a path names is not a code."""


class Migration(migrations.Migration):

    dependencies = [
        ("ecosystem", "0002_alter_alertcase_sector_and_more"),
        ("geo", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="organization",
            name="admin_path",
            field=models.CharField(blank=True, db_index=True, max_length=512),
        ),
        migrations.AddField(
            model_name="organization",
            name="country_code",
            field=models.CharField(blank=True, db_index=True, max_length=3),
        ),
        migrations.AddField(
            model_name="programmemilestone",
            name="admin_path",
            field=models.CharField(blank=True, db_index=True, max_length=512),
        ),
        migrations.RunPython(lift_codes_to_paths, noop),
        migrations.RunPython(retype_organizations, noop),
        migrations.RemoveField(model_name="organization", name="district_code"),
        migrations.RemoveField(model_name="organization", name="state_code"),
        migrations.RemoveField(model_name="programmemilestone", name="state_code"),
        migrations.AlterField(
            model_name="organization",
            name="organization_type",
            field=models.CharField(
                choices=[
                    ("national", "National"),
                    ("ministry", "Ministry"),
                    ("sub_national", "Sub National"),
                    ("facility", "Facility"),
                    ("laboratory", "Laboratory"),
                    ("research", "Research"),
                    ("regulator", "Regulator"),
                ],
                max_length=24,
            ),
        ),
    ]
