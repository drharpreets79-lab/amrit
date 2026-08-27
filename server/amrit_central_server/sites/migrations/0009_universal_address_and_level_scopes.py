"""Retire the last India-shaped geography from the site registry.

Three things go, all of them the same mistake — one country's two administrative levels
written into the schema:

  - ``Site.state`` / ``Site.district``: free text naming levels 1 and 2. A country with
    three sub-national levels could not record its third, and one with a single level had a
    column called "district" it could never fill. Where a site is *reported* is
    ``admin_unit``; where its building *is* becomes a structured postal address on the
    ISO 19160-1 field set, which is a different question and is now stored as one.
  - ``UserProfile.state`` / ``UserProfile.district``: an operator's scope, by name.
    Migration ``0006`` already linked most profiles to a unit; anything still unlinked is
    resolved here by the same unambiguous-name rule, and anything that still cannot be
    resolved is reported and left with no unit — which fails closed, showing that operator
    nothing until someone links them deliberately. A wrong link would silently widen who
    sees what.
  - the ``state``/``district`` role and scope spellings: ``scope_kind`` and
    ``dashboard_kind`` become level-numbered, and the two seeded roles that differed only
    by level name — with identical capabilities — collapse into ``admin_officer``, whose
    depth comes from the operator's own unit.

Names are not thrown away. A site's level-1 and level-2 names become the address's
``admin_area`` and ``locality``, so what was recorded is still recorded, and still shown.
"""

from __future__ import annotations

import unicodedata

from django.db import migrations, models


# Both had exactly the same capability set, and differed only in which level they named.
ROLE_REWRITES = {
    "state_health_officer": "admin_officer",
    "district_health_officer": "admin_officer",
}
SCOPE_KIND_REWRITES = {"state": ("admin", 1), "district": ("admin", 2)}
DASHBOARD_REWRITES = {"national": "country", "state": "admin", "district": "admin"}


def _fold(value: str) -> str:
    text = unicodedata.normalize("NFC", str(value or "")).strip()
    return " ".join(text.split()).casefold()


def _resolver(apps):
    """Name -> unit, but only when the name is unambiguous at that level."""
    AdminUnit = apps.get_model("geo", "AdminUnit")
    by_level_name: dict[tuple[int, str], list] = {}
    for unit in AdminUnit.objects.all():
        by_level_name.setdefault((unit.level, _fold(unit.name)), []).append(unit)

    def resolve(level: int, name: str, parent=None):
        candidates = by_level_name.get((level, _fold(name)), [])
        if parent is not None:
            candidates = [unit for unit in candidates if unit.parent_id == parent.id]
        return candidates[0] if len(candidates) == 1 else None

    return resolve


def carry_names_into_addresses(apps, schema_editor):
    """Move each site's level names into its address, and link any site still unlinked.

    The address is built from the profile's country because that is the only country a
    row without one can honestly be assigned to; a site already linked to a unit takes the
    country from the unit instead.
    """
    Site = apps.get_model("amrit_sites", "Site")
    resolve = _resolver(apps)
    unmatched: list[str] = []

    for site in Site.objects.all():
        state = (site.state or "").strip()
        district = (site.district or "").strip()
        changed = False

        if not site.admin_unit_id and (state or district):
            level1 = resolve(1, state) if state else None
            level2 = resolve(2, district, parent=level1) if district else None
            unit = level2 or level1
            if unit is None:
                unmatched.append(f"site {site.lab_code}: {state!r}/{district!r}")
            else:
                site.admin_unit_id = unit.id
                site.admin_path = unit.admin_path
                site.country_code = unit.country_code
                changed = True

        if (state or district) and not site.address:
            address = {"country_code": (site.country_code or "").upper()}
            if state:
                address["admin_area"] = state
            if district:
                address["locality"] = district
            site.address = address
            changed = True

        if changed:
            site.save(update_fields=["admin_unit", "admin_path", "country_code", "address"])

    if unmatched:
        print(f"\n  {len(unmatched)} site(s) had a level name matching no administrative unit:")
        for entry in unmatched[:20]:
            print(f"    - {entry}")
        if len(unmatched) > 20:
            print(f"    ... and {len(unmatched) - 20} more")
        print("  Their names are kept in the site address; link them from the site editor.")


def link_remaining_profiles(apps, schema_editor):
    """Resolve any operator scope still held only as a name, and report what cannot be."""
    UserProfile = apps.get_model("amrit_sites", "UserProfile")
    resolve = _resolver(apps)
    unresolved: list[str] = []

    for profile in UserProfile.objects.all():
        state = (profile.state or "").strip()
        district = (profile.district or "").strip()
        if profile.admin_unit_id or not (state or district):
            continue
        level1 = resolve(1, state) if state else None
        level2 = resolve(2, district, parent=level1) if district else None
        unit = level2 or level1
        if unit is None:
            unresolved.append(f"user {profile.user_id}: {state!r}/{district!r}")
            continue
        profile.admin_unit_id = unit.id
        profile.country_code = unit.country_code
        profile.save(update_fields=["admin_unit", "country_code"])

    if unresolved:
        # Deliberately fails closed: an operator with no unit is scoped to nothing rather
        # than to a guess about which place they meant.
        print(f"\n  {len(unresolved)} operator profile(s) could not be scoped to a unit and now see no sites:")
        for entry in unresolved[:20]:
            print(f"    - {entry}")
        if len(unresolved) > 20:
            print(f"    ... and {len(unresolved) - 20} more")
        print("  Assign each an administrative unit in the user administration screen.")


def rewrite_roles_and_scopes(apps, schema_editor):
    """Level-numbered scopes, and one administrative role instead of two named ones."""
    RoleDefinition = apps.get_model("amrit_sites", "RoleDefinition")
    UserProfile = apps.get_model("amrit_sites", "UserProfile")

    for definition in RoleDefinition.objects.all():
        fields = []
        rewrite = SCOPE_KIND_REWRITES.get(definition.scope_kind)
        if rewrite:
            definition.scope_kind, level = rewrite
            fields.append("scope_kind")
            if definition.scope_level is None:
                definition.scope_level = level
                fields.append("scope_level")
        dashboard = DASHBOARD_REWRITES.get(definition.dashboard_kind)
        if dashboard:
            definition.dashboard_kind = dashboard
            fields.append("dashboard_kind")
        new_slug = ROLE_REWRITES.get(definition.slug)
        if new_slug and not RoleDefinition.objects.filter(slug=new_slug).exclude(pk=definition.pk).exists():
            definition.slug = new_slug
            fields.append("slug")
        if fields:
            definition.save(update_fields=fields)

    # A slug that could not be taken because the target already existed leaves a duplicate
    # definition behind; the profiles move to the surviving one either way.
    for old, new in ROLE_REWRITES.items():
        UserProfile.objects.filter(role=old).update(role=new)
    RoleDefinition.objects.filter(slug__in=ROLE_REWRITES).delete()


def noop(apps, schema_editor):
    """Reverse is a no-op by design.

    Re-deriving ``state``/``district`` from a unit would invent them for every country
    whose levels are not called that, so the reverse migration restores the columns empty
    rather than filling them with a guess.
    """


class Migration(migrations.Migration):
    dependencies = [
        ("amrit_sites", "0008_manage_deployment_capability"),
        ("geo", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="site",
            name="address",
            field=models.JSONField(blank=True, default=dict),
        ),
        migrations.RunPython(carry_names_into_addresses, noop),
        migrations.RunPython(link_remaining_profiles, noop),
        migrations.RunPython(rewrite_roles_and_scopes, noop),
        migrations.RemoveField(model_name="site", name="state"),
        migrations.RemoveField(model_name="site", name="district"),
        migrations.RemoveField(model_name="userprofile", name="state"),
        migrations.RemoveField(model_name="userprofile", name="district"),
        migrations.AlterField(
            model_name="roledefinition",
            name="scope_kind",
            field=models.CharField(
                choices=[
                    ("none", "No sites"),
                    ("all", "All sites"),
                    ("site", "Assigned site"),
                    ("admin", "Profile administrative unit"),
                    ("country", "Profile country"),
                ],
                default="none",
                max_length=16,
            ),
        ),
        migrations.AlterField(
            model_name="roledefinition",
            name="dashboard_kind",
            field=models.CharField(
                blank=True,
                choices=[
                    ("", "Operations / public only"),
                    ("country", "Country-wide"),
                    ("admin", "Administrative unit"),
                    ("epidemiologist", "Epidemiology"),
                    ("hospital", "Hospital"),
                ],
                max_length=32,
            ),
        ),
    ]
