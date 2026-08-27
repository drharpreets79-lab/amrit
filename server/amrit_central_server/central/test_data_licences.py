"""Phase 10 gate: every bundled dataset's terms are recorded and reachable.

A licence obligation nobody can find has not been communicated, so these assert the terms
are surfaced in the running application rather than only in a file in the repository.
"""

from __future__ import annotations

import json

from django.contrib.auth import get_user_model
from django.test import Client, SimpleTestCase, TestCase
from django.urls import reverse

from central import country_profile as cp
from central.data_licences import MANIFEST_PATH, data_licences, licence_notices

User = get_user_model()


class ManifestTests(SimpleTestCase):
    def test_the_manifest_ships_with_the_server(self):
        self.assertTrue(MANIFEST_PATH.is_file(), "shared/ must be vendored into the server")
        self.assertGreater(len(data_licences()), 0)

    def test_every_entry_states_a_source_and_terms(self):
        for entry in data_licences():
            with self.subTest(dataset=entry.get("id")):
                for field in ("id", "name", "source", "licence"):
                    self.assertTrue(str(entry.get(field, "")).strip(), f"{field} is empty")
                self.assertIn("bundled", entry)

    def test_snomed_is_recorded_as_requiring_a_licence(self):
        """It ships enabled, so the obligation must be stated rather than assumed away."""
        snomed = next((entry for entry in data_licences() if entry["id"] == "snomed-ct"), None)
        self.assertIsNotNone(snomed)
        self.assertTrue(snomed["bundled"])
        self.assertTrue(snomed.get("warn"), "SNOMED must be flagged so the view calls it out")
        self.assertIn("licence", snomed["licence"].lower())
        self.assertIn("snomed.org", snomed.get("url", ""))

    def test_paid_and_free_breakpoint_bodies_are_distinguished(self):
        """What may ship is decided by the licence, not by which table is more useful.

        EUCAST publishes free of charge and permits redistribution with attribution, so its
        table ships with the installer; CLSI M100 is a paid standard, so it is linked and
        importable and never redistributed. This assertion used to require both to be
        unbundled, which stopped describing the deployment once the EUCAST table was
        bundled under recorded terms.
        """
        by_id = {entry["id"]: entry for entry in data_licences()}
        self.assertFalse(by_id["clsi-breakpoints"]["bundled"], "a paid standard must not ship")
        self.assertIn("paid", by_id["clsi-breakpoints"]["licence"].lower())
        self.assertTrue(by_id["eucast-breakpoints"]["bundled"])
        self.assertIn("free", by_id["eucast-breakpoints"]["licence"].lower())
        self.assertIn("redistribution permitted", by_id["eucast-breakpoints"]["licence"].lower())
        self.assertTrue(by_id["eucast-breakpoints"]["attribution_required"])

    def test_notices_are_the_entries_that_require_action(self):
        notices = licence_notices()
        self.assertGreater(len(notices), 0)
        self.assertTrue(all(entry.get("warn") for entry in notices))

    def test_gadm_is_not_bundled(self):
        """Non-commercial-only terms are incompatible with an unrestricted installer."""
        names = " ".join(str(entry.get("name", "")).lower() for entry in data_licences())
        self.assertNotIn("gadm", names)


class ProfileLicenceTests(SimpleTestCase):
    def setUp(self):
        cp.clear_cache()

    def tearDown(self):
        cp.clear_cache()

    def test_snomed_ships_enabled_with_the_notice_recorded(self):
        for profile_id in ("IN", "TESTLAND"):
            with self.subTest(profile=profile_id):
                snomed = cp.get_profile(profile_id)["code_systems"]["snomed"]
                self.assertTrue(snomed["enabled"])
                self.assertIn("SNOMED CT licence", snomed["licence"])

    def test_a_synthesized_profile_carries_the_same_notice(self):
        snomed = cp.synthesize_profile("NGA")["code_systems"]["snomed"]
        self.assertTrue(snomed["enabled"])
        self.assertIn("affiliate licence", snomed["licence"])


class LicenceViewTests(TestCase):
    def test_any_signed_in_user_can_read_the_licences(self):
        """Attribution and the SNOMED position are obligations, not privileged information."""
        user = User.objects.create_user(username="reader", password="pw")
        client = Client()
        client.force_login(user)

        response = client.get(reverse("dashboard_licences"))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Open data and licences")
        self.assertContains(response, "SNOMED")
        self.assertContains(response, "Requires action by this deployment")

    def test_an_anonymous_user_is_sent_to_sign_in(self):
        response = Client().get(reverse("dashboard_licences"))
        self.assertIn(response.status_code, {302, 403})

    def test_the_view_names_every_bundled_dataset(self):
        user = User.objects.create_user(username="reader2", password="pw")
        client = Client()
        client.force_login(user)
        response = client.get(reverse("dashboard_licences"))
        for entry in data_licences():
            if entry.get("bundled"):
                self.assertContains(response, entry["name"])
