"""Country-neutral administrative geography.

Replaces the assumption, baked in throughout this server, that every country has exactly
two sub-national levels called "state" and "district". An AdminUnit tree of arbitrary
depth carries the same India data plus anything else, and admin_path makes every scope
filter an ASCII prefix match instead of a case-insensitive name comparison — which is
what makes scoping work for countries whose unit names are not ASCII.
"""

from __future__ import annotations

import unicodedata

from django.db import models


def normalize_name(value: str) -> str:
    """Fold a place name for matching: NFC, casefolded, whitespace-collapsed.

    Used only to link legacy free-text values to units. Nothing downstream matches on
    names — codes do that — but the one-time backfill has nothing else to go on.
    """
    text = unicodedata.normalize("NFC", str(value or "")).strip()
    return " ".join(text.split()).casefold()


class AdminUnitQuerySet(models.QuerySet):
    def for_country(self, country_code: str) -> "AdminUnitQuerySet":
        return self.filter(country_code=str(country_code or "").upper())

    def at_level(self, level: int) -> "AdminUnitQuerySet":
        return self.filter(level=int(level))

    def descendants_of(self, unit: "AdminUnit", *, include_self: bool = False) -> "AdminUnitQuerySet":
        """Everything beneath a unit, found by prefix rather than by recursion."""
        queryset = self.filter(admin_path__startswith=f"{unit.admin_path}/")
        if include_self:
            queryset = queryset | self.filter(pk=unit.pk)
        return queryset


class AdminUnit(models.Model):
    """One administrative unit at one level of one country's hierarchy."""

    # '<country>:<level>:<code>', e.g. 'IND:2:583'. Matches the desktop app's ids so a
    # unit means the same thing on both sides of the sync.
    id = models.CharField(max_length=128, primary_key=True)
    country_code = models.CharField(max_length=3, db_index=True)
    level = models.PositiveSmallIntegerField(db_index=True)
    parent = models.ForeignKey(
        "self", on_delete=models.PROTECT, null=True, blank=True, related_name="children"
    )
    code = models.CharField(max_length=64)
    code_system = models.CharField(max_length=32, default="ISO3166-2")
    name = models.CharField(max_length=200)
    name_local = models.CharField(max_length=200, blank=True)
    unit_type = models.CharField(max_length=64, blank=True)
    # Materialised path of codes: 'IND/28/583'. Indexed, and the basis of every scope
    # filter in the system.
    admin_path = models.CharField(max_length=512, db_index=True)
    active = models.BooleanField(default=True)
    sort_order = models.IntegerField(default=0)
    metadata = models.JSONField(default=dict, blank=True)
    source_dataset = models.CharField(max_length=64, blank=True)
    source_version = models.CharField(max_length=32, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = AdminUnitQuerySet.as_manager()

    class Meta:
        ordering = ["country_code", "level", "sort_order", "name"]
        constraints = [
            models.UniqueConstraint(
                fields=["country_code", "level", "code"], name="uniq_admin_unit_country_level_code"
            )
        ]
        indexes = [models.Index(fields=["country_code", "level"])]

    def __str__(self) -> str:
        return f"{self.name} ({self.country_code}/{self.code})"

    @staticmethod
    def make_id(country_code: str, level: int, code: str) -> str:
        return f"{str(country_code).upper()}:{int(level)}:{code}"


class CountryConfig(models.Model):
    """Per-country profile overrides, one row per country this deployment hosts.

    A single-country deployment needs none of this: AMRIT_COUNTRY_PROFILE is enough. It
    exists so a regional office or a research network can host several countries on one
    server, each with its own hierarchy, identifiers and branding.
    """

    country_code = models.CharField(max_length=3, primary_key=True)
    profile_id = models.CharField(max_length=32, blank=True)
    # A JSON patch applied over the resolved profile. Empty means "use the profile as is".
    overrides = models.JSONField(default=dict, blank=True)
    enabled = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["country_code"]

    def __str__(self) -> str:
        return self.profile_id or self.country_code
