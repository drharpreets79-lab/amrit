"""Phase 5 gate: scoping is country-driven, and it works for non-ASCII unit names."""

from __future__ import annotations

import hashlib

from django.contrib.auth import get_user_model
from django.test import TestCase

from central.roles import scope_sites
from central.scopes import (
    canonical_scope_type,
    child_scope,
    distinct_scope_values,
    accepted_spellings,
    refresh_levels,
    scope_chain,
    scope_for_level,
    scope_label,
    site_scope_q,
)
from geo.loader import canonical_bytes, load_pack, validate_pack
from geo.models import AdminUnit
from sites.models import RoleDefinition, Site, UserProfile

User = get_user_model()

TWO_LEVEL_PROFILE = {
    "country_name": "India",
    "admin_levels": [
        {"level": 1, "label": "State / UT", "code_system": "LGD"},
        {"level": 2, "label": "District", "code_system": "LGD"},
    ],
}
THREE_LEVEL_PROFILE = {
    "country_name": "Testland",
    "admin_levels": [
        {"level": 1, "label": "محافظة", "code_system": "ISO3166-2"},
        {"level": 2, "label": "قضاء", "code_system": "GeoNames"},
        {"level": 3, "label": "ناحية", "code_system": "GeoNames"},
    ],
}


def make_pack(country: str, units: list[dict], levels: list[dict]) -> dict:
    pack = {
        "schemaVersion": 1,
        "dataset": "amrit-geo-pack",
        "version": "1.0",
        "countryCode": country,
        "countryName": country,
        "levels": levels,
        "minimumCounts": {},
        "rowCounts": {"total": len(units)},
        "units": units,
    }
    pack["contentSha256"] = hashlib.sha256(canonical_bytes(units)).hexdigest()
    return validate_pack(pack)


class VocabularyTests(TestCase):
    def test_withdrawn_spellings_are_still_accepted_on_input(self):
        """Nothing stores them any more, but a saved link must not 404."""
        self.assertEqual(canonical_scope_type("national"), "country")
        self.assertEqual(canonical_scope_type("state"), "admin:1")
        self.assertEqual(canonical_scope_type("district"), "admin:2")
        self.assertEqual(canonical_scope_type("site"), "site")
        # Canonical input passes through unchanged.
        self.assertEqual(canonical_scope_type("admin:1"), "admin:1")

    def test_accepted_spellings_cover_a_tier_in_both_vocabularies(self):
        self.assertEqual(accepted_spellings("admin:1"), ["admin:1", "state"])
        self.assertEqual(accepted_spellings("state"), ["admin:1", "state"])
        self.assertEqual(accepted_spellings("country"), ["country", "national"])
        # A level the old vocabulary could not name has only its canonical spelling.
        self.assertEqual(accepted_spellings("admin:3"), ["admin:3"])

    def test_chain_follows_the_country(self):
        self.assertEqual(scope_chain(TWO_LEVEL_PROFILE), ["country", "admin:1", "admin:2", "site"])
        self.assertEqual(
            scope_chain(THREE_LEVEL_PROFILE), ["country", "admin:1", "admin:2", "admin:3", "site"]
        )
        self.assertEqual(scope_chain(TWO_LEVEL_PROFILE, include_global=True)[0], "global")

    def test_child_scope_walks_the_chain(self):
        self.assertEqual(child_scope("national", TWO_LEVEL_PROFILE), "admin:1")
        self.assertEqual(child_scope("state", TWO_LEVEL_PROFILE), "admin:2")
        self.assertEqual(child_scope("district", TWO_LEVEL_PROFILE), "site")
        self.assertIsNone(child_scope("site", TWO_LEVEL_PROFILE))
        # A third level appears only where the country has one.
        self.assertEqual(child_scope("admin:2", THREE_LEVEL_PROFILE), "admin:3")

    def test_labels_come_from_the_country(self):
        self.assertEqual(scope_label(TWO_LEVEL_PROFILE, "state"), "State / UT")
        self.assertEqual(scope_label(THREE_LEVEL_PROFILE, "admin:1"), "محافظة")
        self.assertEqual(scope_label(TWO_LEVEL_PROFILE, "national"), "India")


class ScopeFilterTests(TestCase):
    def setUp(self):
        levels = [
            {"level": 1, "key": "province", "label": "Province", "label_plural": "Provinces", "code_system": "ISO3166-2"},
            {"level": 2, "key": "district", "label": "District", "label_plural": "Districts", "code_system": "GeoNames"},
        ]
        load_pack(make_pack("TUR", [
            {"level": 1, "code": "TR-34", "parent_code": None, "name": "İstanbul"},
            {"level": 1, "code": "TR-06", "parent_code": None, "name": "Ankara"},
            {"level": 2, "code": "TR-34-01", "parent_code": "TR-34", "name": "Şişli"},
            {"level": 2, "code": "TR-06-01", "parent_code": "TR-06", "name": "Çankaya"},
        ], levels))

        self.istanbul = AdminUnit.objects.get(id="TUR:1:TR-34")
        self.sisli = AdminUnit.objects.get(id="TUR:2:TR-34-01")
        self.cankaya = AdminUnit.objects.get(id="TUR:2:TR-06-01")

        self.in_scope = Site.objects.create(lab_code="IST01", name="Şişli Lab", admin_unit=self.sisli)
        self.out_of_scope = Site.objects.create(lab_code="ANK01", name="Çankaya Lab", admin_unit=self.cankaya)

    def _filter(self, scope_type, value):
        return Site.objects.filter(site_scope_q(scope_type, value))

    def test_scoping_by_code_works_for_non_ascii_names(self):
        """The case that fails with name matching: dotted and dotless I."""
        self.assertEqual(list(self._filter("state", "TR-34")), [self.in_scope])
        self.assertEqual(list(self._filter("admin:1", "TR-34")), [self.in_scope])

    def test_scoping_by_name_still_works(self):
        self.assertEqual(list(self._filter("state", "İstanbul")), [self.in_scope])

    def test_a_site_with_no_unit_is_scoped_to_nothing(self):
        """Fails closed. There is no name column left to fall back to, by design."""
        unlinked = Site.objects.create(lab_code="OLD01", name="Unlinked")
        self.assertNotIn(unlinked, self._filter("state", "İstanbul"))
        self.assertNotIn(unlinked, self._filter("admin:1", "TR-34"))

    def test_an_unknown_scope_value_matches_nothing(self):
        """A scope filter that quietly becomes 'everything' would be a data leak."""
        self.assertEqual(self._filter("admin:3", "NOT-A-UNIT").count(), 0)
        self.assertEqual(self._filter("state", "Nowhere").count(), 0)

    def test_national_scope_applies_no_filter(self):
        self.assertEqual(Site.objects.filter(site_scope_q("national", "")).count(), 2)

    def test_country_scope_filters_by_country_code(self):
        self.assertEqual(Site.objects.filter(site_scope_q("country", "TUR")).count(), 2)
        self.assertEqual(Site.objects.filter(site_scope_q("country", "IND")).count(), 0)

    def test_related_prefix_scopes_a_joined_queryset(self):
        condition = site_scope_q("state", "TR-34", prefix="site__")
        self.assertIn("site__", str(condition))

    def test_refresh_levels_never_narrower_than_the_data(self):
        """A profile declaring one level must not stop deeper snapshots being produced."""
        one_level = {"admin_levels": [{"level": 1, "label": "Province", "code_system": "ISO3166-2"}]}
        self.assertEqual(refresh_levels(one_level), [1, 2])

    def test_distinct_scope_values_lists_units_in_use(self):
        values = distinct_scope_values(scope_for_level(1))
        self.assertIn("İstanbul", values)
        self.assertIn("Ankara", values)


class RbacScopingTests(TestCase):
    """scope_sites is the single gate; widening it is a data leak, narrowing it hides data."""

    def setUp(self):
        levels = [
            {"level": 1, "key": "province", "label": "Province", "label_plural": "Provinces", "code_system": "ISO3166-2"},
            {"level": 2, "key": "district", "label": "District", "label_plural": "Districts", "code_system": "GeoNames"},
        ]
        load_pack(make_pack("TUR", [
            {"level": 1, "code": "TR-34", "parent_code": None, "name": "İstanbul"},
            {"level": 1, "code": "TR-06", "parent_code": None, "name": "Ankara"},
            {"level": 2, "code": "TR-34-01", "parent_code": "TR-34", "name": "Şişli"},
            {"level": 2, "code": "TR-06-01", "parent_code": "TR-06", "name": "Çankaya"},
        ], levels))
        RoleDefinition.objects.update_or_create(
            slug="admin_officer",
            defaults={"label": "Administrative officer", "scope_kind": "admin", "dashboard_kind": "admin",
                      "capabilities": ["view_dashboard", "view_scoped_sites"], "is_active": True},
        )
        self.mine = Site.objects.create(lab_code="IST01", name="Şişli Lab",
                                        admin_unit=AdminUnit.objects.get(id="TUR:2:TR-34-01"))
        self.theirs = Site.objects.create(lab_code="ANK01", name="Çankaya Lab",
                                          admin_unit=AdminUnit.objects.get(id="TUR:2:TR-06-01"))

    def _officer(self, **profile_kwargs):
        user = User.objects.create_user(username=f"officer{User.objects.count()}", password="x")
        UserProfile.objects.create(user=user, role="admin_officer", **profile_kwargs)
        return user

    def test_officer_linked_to_a_unit_sees_only_that_subtree(self):
        user = self._officer(admin_unit=AdminUnit.objects.get(id="TUR:1:TR-34"))
        visible = scope_sites(user, Site.objects.all())
        self.assertEqual(list(visible), [self.mine])

    def test_one_role_serves_every_depth(self):
        """The same definition scopes a level-2 officer to their own district."""
        user = self._officer(admin_unit=AdminUnit.objects.get(id="TUR:2:TR-34-01"))
        visible = scope_sites(user, Site.objects.all())
        self.assertEqual(list(visible), [self.mine])
        self.assertNotIn(self.theirs, visible)

    def test_officer_with_no_scope_sees_nothing(self):
        user = self._officer()
        self.assertEqual(scope_sites(user, Site.objects.all()).count(), 0)

    def test_superuser_sees_everything(self):
        admin = User.objects.create_superuser(username="root", email="a@b.c", password="x")
        self.assertEqual(scope_sites(admin, Site.objects.all()).count(), 2)
