"""Phase 6b: the sectioned deployment settings form.

The screen shows the effective profile but stores only what differs from the base — the
distinction that keeps an untouched field tracking the base profile instead of being frozen
at whatever it said the day someone opened the page. These tests pin that behaviour, and the
two ways it can go quietly wrong: dropping a value the form cannot round-trip (the logo), and
writing a field nobody edited.
"""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.http import QueryDict
from django.test import Client, SimpleTestCase, TestCase
from django.urls import reverse

from central import country_profile as cp
from central.deployment_form import overrides_from_form
from geo.models import CountryConfig
from sites.models import UserProfile

User = get_user_model()

BASE = {
    "country_name": "India",
    "locale": "en-IN",
    "first_day_of_week": 7,
    "admin_levels": [
        {"level": 1, "key": "state", "label": "State / UT", "label_plural": "States & UTs",
         "code_system": "LGD", "required": True},
        {"level": 2, "key": "district", "label": "District", "label_plural": "Districts",
         "code_system": "LGD", "required": False},
    ],
    "branding": {"product_name": "ICMR AMRIT", "authority_name": "Indian Council of Medical Research",
                 "colors": {"navy": "#23376D"}},
    "map": {"center": [22.9734, 78.6569], "zoom": 4, "tile_url": None},
    "privacy": {"k_anonymity_floor": 5, "retention_days": None, "residency_note": None},
    "code_systems": {"snomed": {"enabled": True, "licence": "member-country"}},
}


def form(**values) -> QueryDict:
    data = QueryDict(mutable=True)
    for key, value in values.items():
        if isinstance(value, list):
            data.setlist(key, [str(item) for item in value])
        else:
            data[key] = str(value)
    return data


class SectionedFormTests(SimpleTestCase):
    def test_a_field_left_alone_is_not_stored(self):
        overrides = overrides_from_form(form(country_name="India", locale="en-IN"), BASE)
        self.assertEqual(overrides, {})

    def test_only_the_edited_field_is_stored(self):
        overrides = overrides_from_form(form(country_name="Bhārat", locale="en-IN"), BASE)
        self.assertEqual(overrides, {"country_name": "Bhārat"})

    def test_a_blank_timezone_is_stored_as_null_not_as_an_empty_string(self):
        overrides = overrides_from_form(form(timezone=""), {"timezone": "Asia/Kolkata"})
        self.assertIsNone(overrides["timezone"])

    def test_lists_are_split_on_commas_and_newlines(self):
        overrides = overrides_from_form(form(banned_identifier_keys="aadhaar, abha\nuhid"), BASE)
        self.assertEqual(overrides["banned_identifier_keys"], ["aadhaar", "abha", "uhid"])

    def test_removing_a_level_renumbers_the_rest(self):
        overrides = overrides_from_form(form(
            level_key=["state", "district", "block"],
            level_label=["State", "District", "Block"],
            level_label_plural=["States", "Districts", "Blocks"],
            level_code_system=["LGD", "LGD", "LGD"],
            level_required=["0"],
            level_removed=["1"],
        ), BASE)
        self.assertEqual([level["level"] for level in overrides["admin_levels"]], [1, 2])
        self.assertEqual([level["key"] for level in overrides["admin_levels"]], ["state", "block"])
        self.assertEqual([level["required"] for level in overrides["admin_levels"]], [True, False])

    def test_removing_every_level_is_refused(self):
        with self.assertRaises(ValidationError):
            overrides_from_form(form(level_key=["state"], level_removed=["0"]), BASE)

    def test_a_non_numeric_entry_is_named_rather_than_crashing(self):
        with self.assertRaises(ValidationError) as caught:
            overrides_from_form(form(first_day_of_week="Monday"), BASE)
        self.assertIn("first day of week", str(caught.exception))

    def test_an_uploaded_logo_survives_a_save_of_the_rest_of_the_form(self):
        stored = {"branding": {"logo": "data:image/png;base64,AAAA"}}
        overrides = overrides_from_form(
            form(product_name="National AMR Portal", authority_name="Ministry", colour_navy="#23376D"),
            BASE, stored,
        )
        self.assertEqual(overrides["branding"]["logo"], "data:image/png;base64,AAAA")
        self.assertEqual(overrides["branding"]["product_name"], "National AMR Portal")

    def test_the_reversed_mark_survives_the_same_save(self):
        # It is a second mark under the same rule, and it was dropped once already: losing
        # it returns the desktop sidebar to a white plate the next time anyone edits a
        # colour here, on a screen that never mentions the sidebar.
        stored = {"branding": {"logo": "icmr-emblem.png", "logo_reverse": "icmr-emblem-light.png"}}
        overrides = overrides_from_form(
            form(product_name="ICMR AMRIT", authority_name="ICMR", colour_navy="#23376D"),
            BASE, stored,
        )
        self.assertEqual(overrides["branding"]["logo_reverse"], "icmr-emblem-light.png")

    def test_an_override_the_form_does_not_cover_is_carried_through(self):
        stored = {"reporting_frameworks": ["GLASS", "NAP-AMR"]}
        overrides = overrides_from_form(form(country_name="Bhārat"), BASE, stored)
        self.assertEqual(overrides["reporting_frameworks"], ["GLASS", "NAP-AMR"])

    def test_an_unticked_code_system_is_disabled_rather_than_dropped(self):
        overrides = overrides_from_form(form(code_systems_present="yes"), BASE)
        self.assertFalse(overrides["code_systems"]["snomed"]["enabled"])
        # The licence position is a fact about the vocabulary, not a toggle; it stays.
        self.assertEqual(overrides["code_systems"]["snomed"]["licence"], "member-country")

    def test_a_blank_retention_period_means_no_expiry_rather_than_zero_days(self):
        overrides = overrides_from_form(form(k_anonymity_floor=5, retention_days="", residency_note=""), BASE)
        self.assertEqual(overrides, {})


class SectionedFormViewTests(TestCase):
    def setUp(self):
        cp.clear_cache()
        CountryConfig.objects.get_or_create(country_code="IND", defaults={"profile_id": "IN"})
        self.client = Client()
        user = User.objects.create_superuser(username="root", email="a@b.c", password="pw")
        self.client.force_login(user)

    def tearDown(self):
        cp.clear_cache()

    def _post(self, **extra):
        payload = {"country": "IND", "country_name": "India", "product_name": "National AMR Portal",
                   "authority_name": "Ministry of Health"}
        payload.update(extra)
        return self.client.post(reverse("dashboard_deployment_save"), payload, follow=True)

    def test_the_screen_renders_a_field_per_section_rather_than_only_raw_json(self):
        response = self.client.get(reverse("dashboard_deployment"), {"country": "IND"})
        for section in ("Identity and branding", "Administrative levels", "Locale and time",
                        "Standards and guidelines", "Privacy", "Map", "Identifier namespace"):
            self.assertContains(response, section)
        self.assertContains(response, 'name="product_name"')

    def test_saving_the_form_stores_only_what_changed(self):
        self._post()
        stored = CountryConfig.objects.get(country_code="IND").overrides
        self.assertEqual(set(stored), {"branding"})
        self.assertEqual(stored["branding"]["product_name"], "National AMR Portal")

    def test_a_namespace_change_from_the_form_still_needs_confirmation(self):
        self._post(base_uri="https://amr.example", urn_prefix="urn:example:amr")
        self.assertEqual(CountryConfig.objects.get(country_code="IND").overrides, {})

        self._post(base_uri="https://amr.example", urn_prefix="urn:example:amr", confirm_irreversible="yes")
        stored = CountryConfig.objects.get(country_code="IND").overrides
        self.assertEqual(stored["identifier_namespace"]["base_uri"], "https://amr.example")

    def test_a_hostile_tile_url_from_the_form_is_refused(self):
        self._post(map_lat=0, map_lng=0, map_zoom=2, map_tile_url="javascript:alert(1)")
        self.assertEqual(CountryConfig.objects.get(country_code="IND").overrides, {})

    def test_reverting_one_field_leaves_the_others_alone(self):
        CountryConfig.objects.filter(country_code="IND").update(
            overrides={"locale": "ta-IN", "map": {"zoom": 6}}
        )
        self.client.post(reverse("dashboard_deployment_revert"),
                         {"country": "IND", "field": "locale"}, follow=True)
        self.assertEqual(CountryConfig.objects.get(country_code="IND").overrides, {"map": {"zoom": 6}})

    def test_reverting_a_field_that_is_not_customised_changes_nothing(self):
        CountryConfig.objects.filter(country_code="IND").update(overrides={"locale": "ta-IN"})
        self.client.post(reverse("dashboard_deployment_revert"),
                         {"country": "IND", "field": "map"}, follow=True)
        self.assertEqual(CountryConfig.objects.get(country_code="IND").overrides, {"locale": "ta-IN"})

    def test_revert_is_refused_for_an_unprivileged_user(self):
        client = Client()
        user = User.objects.create_user(username="clerk", password="pw")
        UserProfile.objects.create(user=user, role="hospital_admin")
        client.force_login(user)
        response = client.post(reverse("dashboard_deployment_revert"), {"country": "IND", "field": "locale"})
        self.assertEqual(response.status_code, 403)
