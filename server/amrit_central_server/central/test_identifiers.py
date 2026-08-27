"""Phase 6 gate: India's emitted identifiers are unchanged; another country emits its own."""

from __future__ import annotations

import os
from unittest import mock

from django.test import SimpleTestCase

from central import country_profile as cp
from central import identifiers


class IndiaIdentifierParityTests(SimpleTestCase):
    """These strings are wire-visible. Changing them splits identifier continuity for
    every downstream consumer, so India must keep emitting exactly what it emitted before
    the namespace became configurable."""

    def setUp(self):
        cp.clear_cache()
        self.profile = cp.get_profile("IN")

    def tearDown(self):
        cp.clear_cache()

    def test_every_identifier_matches_the_previous_hardcoded_value(self):
        expected = {
            identifiers.lab_code_system(self.profile): "https://amrit.icmr.gov.in/lab-code",
            identifiers.measure_url("MEM", self.profile): "https://amrit.icmr.gov.in/Measure/resistance-rate-mem",
            identifiers.proportion_ci_extension(self.profile): "https://amrit.icmr.gov.in/StructureDefinition/proportion-ci",
            identifiers.bundle_identifier_system(self.profile): "https://amrit.icmr.gov.in/bundle-id",
            identifiers.aggregate_code_system(self.profile): "https://amrit.icmr.gov.in/CodeSystem/aggregate",
        }
        for actual, previous in expected.items():
            self.assertEqual(actual, previous)

    def test_measure_url_lowercases_the_antibiotic_code(self):
        self.assertEqual(
            identifiers.measure_url("MEM", self.profile), identifiers.measure_url("mem", self.profile)
        )


class OtherCountryIdentifierTests(SimpleTestCase):
    def setUp(self):
        cp.clear_cache()

    def tearDown(self):
        cp.clear_cache()

    def test_another_country_emits_its_own_namespace(self):
        profile = cp.get_profile("TESTLAND")
        self.assertEqual(identifiers.base_uri(profile), "https://amr.testland.example")
        self.assertEqual(identifiers.urn_prefix(profile), "urn:testland:amr")
        for value in (
            identifiers.lab_code_system(profile),
            identifiers.measure_url("MEM", profile),
            identifiers.bundle_identifier_system(profile),
            identifiers.aggregate_code_system(profile),
        ):
            self.assertNotIn("icmr", value.lower())
            self.assertTrue(value.startswith("https://amr.testland.example/"))

    def test_an_unconfigured_deployment_is_obvious_rather_than_borrowing(self):
        """A reserved .invalid host makes the unset state visible in exported FHIR."""
        with mock.patch.dict(os.environ, {"AMRIT_COUNTRY_PROFILE": ""}):
            cp.clear_cache()
            self.assertEqual(identifiers.base_uri(), "https://amrit.invalid")
            self.assertNotIn("icmr", identifiers.bundle_identifier_system().lower())

    def test_a_synthesized_country_never_borrows_another_namespace(self):
        profile = cp.get_profile("NGA")
        self.assertEqual(identifiers.base_uri(profile), "https://amrit.invalid")
        self.assertEqual(identifiers.urn_prefix(profile), "urn:amrit:ng")
