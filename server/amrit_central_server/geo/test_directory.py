"""The server half of the shared geocoding fixture.

``shared/golden-datasets/geo_directory_reference.json`` is the same file the desktop app's
``tests/geo-directory.test.ts`` reads, run against the same shards. A facility that lands in
one place on the desktop and another on the portal is the same defect as not being placed at
all, so the two implementations are pinned to each other rather than each to itself.
"""

from __future__ import annotations

import json
from pathlib import Path

from django.test import SimpleTestCase

from geo import directory

FIXTURE = json.loads(
    (Path(__file__).resolve().parent.parent / "shared" / "golden-datasets" / "geo_directory_reference.json")
    .read_text(encoding="utf-8")
)


class GeoDirectoryFixtureTests(SimpleTestCase):
    def setUp(self):
        directory.reset_cache()

    def test_every_case_in_the_shared_fixture(self):
        for case in FIXTURE["cases"]:
            with self.subTest(case["name"]):
                if case.get("locality") and not case.get("postal_code"):
                    result = directory.resolve(
                        case["country_code"],
                        locality=case["locality"],
                        subdivision_code=case.get("subdivision_code"),
                    )
                else:
                    result = directory.resolve(
                        case["country_code"],
                        postal_code=case.get("postal_code"),
                        subdivision_code=case.get("subdivision_code"),
                    )
                expected = case["expect"]

                if "available" in expected:
                    self.assertEqual(result.available, expected["available"])
                if "candidate_count" in expected:
                    self.assertEqual(len(result.candidates), expected["candidate_count"])
                if "candidate_count_at_least" in expected:
                    self.assertGreaterEqual(len(result.candidates), expected["candidate_count_at_least"])
                if "postal_code_unknown" in expected:
                    self.assertEqual(result.postal_code_unknown, expected["postal_code_unknown"])
                if "country_has_no_postal_directory" in expected:
                    self.assertEqual(
                        result.country_has_no_postal_directory,
                        expected["country_has_no_postal_directory"],
                    )
                if "first" in expected:
                    self.assertTrue(result.candidates, "expected at least one candidate")
                    first = result.candidates[0].as_dict()
                    for key, value in expected["first"].items():
                        self.assertEqual(first.get(key), value, key)
                if "point" in expected:
                    self.assertIsNotNone(result.point)
                    point = result.point.as_dict()
                    for key, value in expected["point"].items():
                        self.assertEqual(point.get(key), value, key)
                if "point_precision" in expected:
                    self.assertIsNotNone(result.point)
                    self.assertEqual(result.point.precision, expected["point_precision"])


class PostalCodeNormalisationTests(SimpleTestCase):
    def test_separators_an_operator_types_do_not_defeat_the_lookup(self):
        self.assertEqual(directory.normalize_postal_code(" ec1y 8sy "), "EC1Y8SY")
        self.assertEqual(directory.normalize_postal_code("22162-1010"), "221621010")
        self.assertEqual(directory.normalize_postal_code("154-0023"), "1540023")


class PrecisionTests(SimpleTestCase):
    def test_resolving_never_silently_coarsens_a_stored_point(self):
        self.assertTrue(directory.is_at_least_as_precise("postal_area", "locality"))
        self.assertFalse(directory.is_at_least_as_precise("subdivision", "postal_area"))
        self.assertFalse(directory.is_at_least_as_precise("country", "subdivision"))
        self.assertTrue(directory.is_at_least_as_precise("country", None))
        # A coordinate somebody typed knew something the directory does not.
        self.assertFalse(directory.is_at_least_as_precise("locality", "manual"))


class BundleTests(SimpleTestCase):
    def test_the_directory_is_bundled_with_this_product(self):
        countries = list(directory.bundled_countries())
        self.assertGreater(len(countries), 200, "the whole world is meant to be bundled")
        self.assertIn("IND", countries)

    def test_attribution_is_available_wherever_a_point_is_shown(self):
        # CC BY 4.0 requires it, and a resolved point is a use of the data.
        self.assertIn("GeoNames", directory.attribution())
