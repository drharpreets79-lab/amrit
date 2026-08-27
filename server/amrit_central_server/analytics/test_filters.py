from unittest.mock import patch

from django.test import SimpleTestCase

from analytics.filters import coerce_request_filters, filters_catalog


class ProfileGuidelineFilterTests(SimpleTestCase):
    PROFILE = {
        "guidelines": {
            "default": "EUCAST",
            "available": ["EUCAST", "NATIONAL-AST"],
            "national_body": "National Reference Laboratory",
        }
    }

    @patch("central.country_profile.get_profile", return_value=PROFILE)
    def test_catalog_uses_profile_guidelines(self, _profile):
        guideline = next(item for item in filters_catalog() if item["name"] == "guideline")
        self.assertEqual(
            guideline["enum"],
            ["EUCAST", "NATIONAL-AST", "National Reference Laboratory", "Other"],
        )
        self.assertNotIn("ICMR", guideline["enum"])

    @patch("central.country_profile.get_profile", return_value=PROFILE)
    def test_filter_accepts_profile_value_and_rejects_unconfigured_value(self, _profile):
        self.assertEqual(
            coerce_request_filters({"guideline": "NATIONAL-AST"}),
            {"guideline": "NATIONAL-AST"},
        )
        self.assertEqual(coerce_request_filters({"guideline": "ICMR"}), {})
