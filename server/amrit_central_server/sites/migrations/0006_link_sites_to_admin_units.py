"""Link existing sites and user profiles to administrative units.

Runs once against a populated database. Sites carry only free-text state/district today,
so the match is on Unicode-normalised, case-folded names — the only handle available.
Anything that cannot be matched is reported and left alone: a wrong link would silently
change who can see which data, which is worse than no link at all.

The geography itself is loaded separately (`manage.py load_geo_pack IN`); this migration
links only what is already present, so it is safe on an empty or partially loaded tree.
"""

from __future__ import annotations

import unicodedata

from django.db import migrations


def _fold(value: str) -> str:
    text = unicodedata.normalize("NFC", str(value or "")).strip()
    return " ".join(text.split()).casefold()


def link_sites(apps, schema_editor):
    AdminUnit = apps.get_model("geo", "AdminUnit")
    Site = apps.get_model("amrit_sites", "Site")
    UserProfile = apps.get_model("amrit_sites", "UserProfile")

    units = list(AdminUnit.objects.all())
    if not units:
        return

    by_level_name: dict[tuple[int, str], list] = {}
    for unit in units:
        by_level_name.setdefault((unit.level, _fold(unit.name)), []).append(unit)

    def resolve(level: int, name: str, parent=None):
        """A name matches only when it is unambiguous, optionally within a parent."""
        candidates = by_level_name.get((level, _fold(name)), [])
        if parent is not None:
            candidates = [unit for unit in candidates if unit.parent_id == parent.id]
        return candidates[0] if len(candidates) == 1 else None

    unmatched: list[str] = []

    for site in Site.objects.all():
        if site.admin_unit_id or not (site.state or site.district):
            continue
        state = resolve(1, site.state) if site.state else None
        district = resolve(2, site.district, parent=state) if site.district else None
        unit = district or state
        if unit is None:
            unmatched.append(f"site {site.lab_code}: {site.state!r}/{site.district!r}")
            continue
        site.admin_unit_id = unit.id
        site.admin_path = unit.admin_path
        site.country_code = unit.country_code
        site.save(update_fields=["admin_unit", "admin_path", "country_code"])

    for profile in UserProfile.objects.all():
        if profile.admin_unit_id or not (profile.state or profile.district):
            continue
        state = resolve(1, profile.state) if profile.state else None
        district = resolve(2, profile.district, parent=state) if profile.district else None
        unit = district or state
        if unit is None:
            unmatched.append(f"profile {profile_label(profile)}: {profile.state!r}/{profile.district!r}")
            continue
        profile.admin_unit_id = unit.id
        profile.country_code = unit.country_code
        profile.save(update_fields=["admin_unit", "country_code"])

    if unmatched:
        # Reported, never guessed. These keep working exactly as before through the
        # legacy columns until someone links them deliberately.
        print(f"\n  {len(unmatched)} row(s) could not be linked to an administrative unit:")
        for entry in unmatched[:20]:
            print(f"    - {entry}")
        if len(unmatched) > 20:
            print(f"    ... and {len(unmatched) - 20} more")


def profile_label(profile) -> str:
    return getattr(profile, "full_name", "") or f"user {profile.user_id}"


def unlink(apps, schema_editor):
    """Reverse cleanly: drop the links, leave the legacy columns untouched."""
    Site = apps.get_model("amrit_sites", "Site")
    UserProfile = apps.get_model("amrit_sites", "UserProfile")
    Site.objects.update(admin_unit=None, admin_path="", country_code="")
    UserProfile.objects.update(admin_unit=None, country_code="")


class Migration(migrations.Migration):
    dependencies = [
        ("amrit_sites", "0005_site_admin_path_site_admin_unit_site_country_code_and_more"),
        ("geo", "0001_initial"),
    ]

    operations = [migrations.RunPython(link_sites, unlink)]
