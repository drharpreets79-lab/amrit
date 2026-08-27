"""Country profile registry tests.

The headline test is test_every_selectable_country_synthesizes_and_validates: it is the
gate that makes "any country in the world can install this" checkable rather than
claimed. If it fails, some country cannot be deployed.
"""

from __future__ import annotations

import json
import os
from unittest import mock

from django.test import SimpleTestCase

from central import country_profile as cp


class CountryReferenceTests(SimpleTestCase):
    def setUp(self):
        cp.clear_cache()

    def test_reference_covers_iso_3166_1_and_excludes_organisations(self):
        selectable = cp.available_countries()
        iso_only = cp.available_countries(iso_only=True)
        codes = {entry["alpha3"] for entry in selectable}

        # The underlying WHONET country code set also carries two organisations.
        self.assertNotIn("WHO", codes)
        self.assertNotIn("FAO", codes)
        # Kosovo is user-assigned (XK/XKX): usable, but not ISO 3166-1.
        self.assertIn("XKX", codes)
        self.assertNotIn("XKX", {entry["alpha3"] for entry in iso_only})

        self.assertEqual(len(iso_only), 249)
        self.assertEqual(len(selectable), 250)

    def test_locale_defaults_differ_by_country(self):
        reference = {entry["alpha3"]: entry for entry in cp.available_countries()}

        # The unconditional day-first parse in normalizeDate is wrong for the US.
        self.assertEqual(reference["USA"]["date_input_order"], "MDY")
        self.assertEqual(reference["IND"]["date_input_order"], "DMY")

        # A country-level time zone would mis-stamp dates where several zones apply.
        self.assertTrue(reference["USA"]["timezone_ambiguous"])
        self.assertIsNone(reference["USA"]["timezone"])
        self.assertGreater(len(reference["USA"]["timezones"]), 1)

        # Canonical IANA identifiers, not the legacy ICU aliases.
        self.assertEqual(reference["IND"]["timezone"], "Asia/Kolkata")
        self.assertEqual(reference["NPL"]["timezone"], "Asia/Kathmandu")

        # Non-Latin digits must be normalised on input rather than rejected.
        self.assertEqual(reference["NPL"]["numbering_system"], "deva")
        self.assertEqual(reference["EGY"]["text_direction"], "rtl")

    def test_resolve_country_code_accepts_alpha2_and_alpha3(self):
        self.assertEqual(cp.resolve_country_code("in"), "IND")
        self.assertEqual(cp.resolve_country_code("IND"), "IND")
        self.assertEqual(cp.resolve_country_code(" ng "), "NGA")
        self.assertIsNone(cp.resolve_country_code("ZZ"))


class ProfileSynthesisTests(SimpleTestCase):
    def setUp(self):
        cp.clear_cache()

    def test_every_selectable_country_synthesizes_and_validates(self):
        """The "any country" gate. Every country must be deployable with nothing authored."""
        failures = []
        for entry in cp.available_countries():
            try:
                cp.validate_profile(cp.synthesize_profile(entry["alpha3"]))
            except Exception as exc:  # noqa: BLE001 - report every failure, not the first
                failures.append(f"{entry['alpha3']}: {exc}")
        self.assertEqual(failures, [], f"{len(failures)} countries cannot be deployed")

    def test_synthesis_refuses_an_organisation_entry(self):
        with self.assertRaisesMessage(cp.ProfileError, "not a country"):
            cp.synthesize_profile("WHO")

    def test_synthesized_defaults_are_licence_safe_and_obviously_unset(self):
        profile = cp.synthesize_profile("NGA")
        # SNOMED ships enabled with its licence position recorded, rather than being
        # silently disabled for a deployment that may be entitled to use it.
        self.assertTrue(profile["code_systems"]["snomed"]["enabled"])
        self.assertIn("licence", profile["code_systems"]["snomed"]["licence"].lower())
        # A reserved .invalid host makes an unconfigured FHIR namespace obvious rather
        # than silently borrowing another country's identifiers.
        self.assertEqual(profile["identifier_namespace"]["base_uri"], "https://amrit.invalid")
        # EUCAST is free worldwide; CLSI M100 is a paid licence.
        self.assertEqual(profile["guidelines"]["default"], "EUCAST")


class ProfileResolutionTests(SimpleTestCase):
    def setUp(self):
        cp.clear_cache()

    def tearDown(self):
        cp.clear_cache()

    def test_curated_profile_wins_over_synthesis(self):
        for requested in ("IN", "IND", "in"):
            cp.clear_cache()
            profile = cp.get_profile(requested)
            self.assertEqual(profile["profile_id"], "IN")
            self.assertEqual(profile["source"], "curated")
            self.assertEqual(profile["country_code"], "IND")
            self.assertEqual(cp.admin_level(profile, 1)["label"], "State / UT")
            self.assertEqual(cp.admin_level(profile, 2)["label"], "District")
            self.assertEqual(cp.admin_level(profile, 1)["code_system"], "LGD")
            self.assertEqual(profile["identifier_namespace"]["urn_prefix"], "urn:icmr:amrit")

    def test_three_level_rtl_fixture_profile(self):
        profile = cp.get_profile("TESTLAND")
        self.assertEqual(len(profile["admin_levels"]), 3)
        self.assertEqual(profile["text_direction"], "rtl")
        self.assertEqual(profile["numbering_system"], "arab")
        self.assertEqual(profile["epi_week_system"], "mmwr")
        self.assertEqual(profile["fiscal_year_start_month"], 10)

    def test_environment_variable_selects_the_profile(self):
        with mock.patch.dict(os.environ, {"AMRIT_COUNTRY_PROFILE": "TESTLAND"}):
            cp.clear_cache()
            self.assertEqual(cp.get_profile()["profile_id"], "TESTLAND")

    def test_falls_back_when_nothing_is_configured(self):
        with mock.patch.dict(os.environ, {"AMRIT_COUNTRY_PROFILE": ""}):
            cp.clear_cache()
            profile = cp.get_profile()
            self.assertEqual(profile["profile_id"], "DEFAULT")
            self.assertEqual(profile["source"], "fallback")

    def test_unknown_request_is_rejected(self):
        with self.assertRaisesMessage(cp.ProfileError, "not an ISO 3166-1 country code"):
            cp.get_profile("NOT_A_COUNTRY")

    def test_every_curated_profile_satisfies_the_json_schema(self):
        """profile.schema.json is the contract; the app mirrors it in zod.

        Both products validate the same checked-in files, so a drift between the two
        validators surfaces here or in the app suite rather than in production.
        """
        profile_ids = cp.curated_profile_ids()
        self.assertIn("IN", profile_ids)
        for profile_id in profile_ids:
            with self.subTest(profile=profile_id):
                cp.validate_profile(cp.get_profile(profile_id))

        fallback = json.loads((cp.PROFILE_ROOT / "_default.json").read_text(encoding="utf-8"))
        cp.validate_profile(fallback)
