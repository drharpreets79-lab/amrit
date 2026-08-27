"""The demonstration seeder against the country a deployment is actually configured for.

Two failures are being pinned here, and they pull in opposite directions.

The first is the one that took a portal down: a deployment whose country had no
demonstration pack got a `CommandError`, and because the container entrypoint treats a
failed seeder as a failed boot, the whole stack sat in a restart loop with the reason
scrolling past.

The second is what the error was protecting against and must survive the fix: a Testland
deployment must never end up holding Indian hospitals.
"""

from __future__ import annotations

import os
from io import StringIO
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase

from sites.models import Site


class SeedDemoCountryTests(TestCase):
    def test_a_country_with_no_pack_is_skipped_rather_than_failing_the_boot(self):
        out = StringIO()
        # ZZZ is the neutral fallback profile: no country configured at all.
        call_command("seed_demo", "--country", "ZZZ", "--no-activity", stdout=out)
        self.assertIn("No demonstration pack exists for ZZZ", out.getvalue())
        # Names the way out, and nothing was invented to fill the gap.
        self.assertIn("AMRIT_COUNTRY_PROFILE", out.getvalue())
        self.assertEqual(Site.objects.count(), 0)

    def test_strict_still_fails_for_a_caller_that_wants_to_know(self):
        with self.assertRaises(CommandError):
            call_command("seed_demo", "--country", "ZZZ", "--strict", "--no-activity")

    def test_the_india_pack_seeds_indian_sites(self):
        call_command("seed_demo", "--country", "IND", "--no-activity", stdout=StringIO())
        self.assertEqual(Site.objects.filter(country="India").count(), 16)
        aiims = Site.objects.get(lab_code="AIIMS-DEL")
        self.assertEqual(aiims.address.get("country_code"), "IND")
        self.assertTrue(get_user_model().objects.filter(username="superadmin").exists())

    def test_the_testland_pack_seeds_testland_sites_and_no_indian_ones(self):
        call_command("seed_demo", "--country", "TST", "--no-activity", stdout=StringIO())
        self.assertEqual(Site.objects.filter(country="Testland").count(), 4)
        self.assertFalse(Site.objects.filter(lab_code="AIIMS-DEL").exists())
        self.assertEqual(Site.objects.get(lab_code="TST-CENTRAL").address.get("country_code"), "TST")

    def test_seeding_twice_changes_nothing_the_second_time(self):
        call_command("seed_demo", "--country", "IND", "--no-activity", stdout=StringIO())
        first = Site.objects.count()
        call_command("seed_demo", "--country", "IND", "--no-activity", stdout=StringIO())
        self.assertEqual(Site.objects.count(), first)

    def test_the_configured_profile_chooses_the_pack_when_no_country_is_given(self):
        # No --country: the deployment's own profile decides, which is the path the
        # container entrypoint takes.
        from central.country_profile import get_profile

        out = StringIO()
        with patch.dict(os.environ, {"AMRIT_COUNTRY_PROFILE": "IN"}, clear=False):
            # The resolver caches, which is right for a server that reads its country once
            # at boot and wrong for a test that changes it.
            get_profile.cache_clear()
            try:
                call_command("seed_demo", "--no-activity", stdout=out)
            finally:
                get_profile.cache_clear()
        self.assertTrue(Site.objects.filter(lab_code="AIIMS-DEL").exists(), out.getvalue())
