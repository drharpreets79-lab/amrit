"""The boundary a patient's residence must never cross.

The desktop application records where a patient lives — the town and the postal code, never
the street — because that is what maps resistance and finds clusters. None of it belongs on
this server, which stores aggregates only. These tests pin that: a site response carrying
any part of a residence is refused, and the aggregate shapes that legitimately describe a
*place* rather than a person still pass.
"""

from __future__ import annotations

from unittest.mock import patch

from django.test import SimpleTestCase

from .pii_guard import PIIViolation, assert_aggregate_only, scan_payload


class PatientResidenceIsRefusedTests(SimpleTestCase):
    @patch(
        "central.country_profile.get_profile",
        return_value={"banned_identifier_keys": ["health-id"]},
    )
    def test_country_profile_identifier_keys_are_normalized(self, _profile):
        self.assertEqual(scan_payload({"healthId": "ABC-123"}), ["$.healthId"])

    def test_every_residence_component_is_a_violation(self):
        for key, value in (
            ("postal_code", "682011"),
            ("postalCode", "682011"),
            ("postal-code", "682011"),
            ("zip", "30329"),
            ("zipcode", "30329"),
            ("address", {"locality": "Kochi"}),
        ):
            with self.subTest(key=key):
                self.assertTrue(scan_payload({"rows": [{key: value}]}))

    def test_a_response_carrying_a_residence_is_rejected_outright(self):
        payload = {
            "metric": "resistance_rate",
            "numerator": 12,
            "denominator": 40,
            "patient_residence": {"country_code": "IND", "locality": "KOCHI", "postal_code": "682011"},
        }
        with self.assertRaisesMessage(PIIViolation, "postal_code"):
            assert_aggregate_only(payload)

    def test_a_coarsened_code_is_refused_just_the_same(self):
        """Three characters of a postal code is still a postal code on this server."""
        with self.assertRaises(PIIViolation):
            assert_aggregate_only({"buckets": [{"postal_code": "682", "count": 9}]})

    def test_aggregate_geography_by_administrative_path_still_passes(self):
        """What a site *may* report: the reporting unit, which is not a person's address."""
        assert_aggregate_only(
            {
                "metric": "resistance_rate",
                "numerator": 12,
                "denominator": 40,
                "admin_path": "IND/29/572",
                "country_code": "IND",
                "buckets": {"IND/29/572": 12},
            }
        )
