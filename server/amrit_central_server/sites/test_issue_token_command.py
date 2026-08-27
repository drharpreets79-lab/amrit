from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.test import TestCase

from central.country_profile import clear_cache
from sites.models import Site


class IssueTokenCountryTests(TestCase):
    def tearDown(self):
        clear_cache()
        super().tearDown()

    def test_create_uses_active_country_profile(self):
        output = StringIO()
        with patch.dict("os.environ", {"AMRIT_COUNTRY_PROFILE": "TESTLAND"}):
            clear_cache()
            call_command(
                "issue_token",
                "SITE-001",
                create=True,
                name="Reference Laboratory",
                stdout=output,
            )

        site = Site.objects.get(lab_code="SITE-001")
        self.assertEqual(site.country_code, "TST")
        self.assertEqual(site.country, "تستلاند (Testland)")
        self.assertTrue(site.auth_token_hash)
        self.assertNotIn("India", output.getvalue())
