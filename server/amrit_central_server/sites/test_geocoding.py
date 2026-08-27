"""Placing a registered site, and the order of authority between the ways of doing it.

A site can acquire a coordinate three ways: it reports one itself with consent, someone
types one, or the directory resolves one from its address. They are not equally good, and
the rules about which wins are the part that would rot silently.
"""

from __future__ import annotations

from django.test import TestCase

from sites.models import Site


class SiteGeocodingTests(TestCase):
    def test_a_site_with_an_address_is_placed_on_save(self):
        site = Site.objects.create(
            lab_code="GEO-1",
            name="Government Medical College",
            country_code="IND",
            address={
                "country_code": "IND",
                "address_lines": ["Department of Microbiology"],
                "locality": "Kochi",
                "admin_area": "Kerala",
                "postal_code": "682011",
            },
        )
        point = site.address["geo_point"]
        self.assertEqual(point["precision"], "postal_area")
        self.assertAlmostEqual(point["latitude"], 9.967, places=3)
        self.assertAlmostEqual(point["longitude"], 76.3159, places=3)
        self.assertEqual(point["source"], "geonames-postal")

    def test_a_site_with_no_address_is_left_unplaced_rather_than_guessed(self):
        site = Site.objects.create(lab_code="GEO-2", name="Unplaced", country_code="IND")
        self.assertEqual(site.address, {})
        self.assertIsNone(site.map_point)

    def test_a_stored_point_is_never_overwritten_by_a_later_save(self):
        # Somebody corrected this by hand. A directory update, or any unrelated edit, must
        # not quietly move the facility back to where the postal code says it is.
        site = Site.objects.create(
            lab_code="GEO-3",
            name="Corrected",
            country_code="IND",
            address={
                "country_code": "IND",
                "locality": "Kochi",
                "postal_code": "682011",
                "geo_point": {
                    "latitude": 9.9,
                    "longitude": 76.2,
                    "precision": "manual",
                    "source": "manual",
                },
            },
        )
        site.name = "Corrected, renamed"
        site.save()
        site.refresh_from_db()
        self.assertEqual(site.address["geo_point"]["precision"], "manual")
        self.assertAlmostEqual(site.address["geo_point"]["latitude"], 9.9, places=4)

    def test_the_installations_own_reading_outranks_one_derived_from_the_address(self):
        site = Site.objects.create(
            lab_code="GEO-4",
            name="Reporting its own position",
            country_code="IND",
            address={"country_code": "IND", "locality": "Kochi", "postal_code": "682011"},
            latitude=9.9312,
            longitude=76.2673,
        )
        point = site.map_point
        self.assertEqual(point["precision"], "device")
        self.assertAlmostEqual(point["latitude"], 9.9312, places=4)
        # The address-derived point is still stored; it is simply not the one the map uses.
        self.assertEqual(site.address["geo_point"]["precision"], "postal_area")

    def test_a_country_with_no_postal_system_is_placed_by_its_town(self):
        site = Site.objects.create(
            lab_code="GEO-5",
            name="Hospital Geral",
            country_code="AGO",
            address={"country_code": "AGO", "locality": "Saurimo"},
        )
        point = site.address["geo_point"]
        self.assertEqual(point["precision"], "locality")
        self.assertAlmostEqual(point["latitude"], -9.6608, places=3)

    def test_a_plus_code_places_a_site_without_postal_or_town_data(self):
        site = Site.objects.create(
            lab_code="GEO-OLC",
            name="Facility using a global location code",
            country_code="IND",
            address={"country_code": "IND", "plus_code": "7J3Q2M8Q+P9"},
        )
        point = site.address["geo_point"]
        self.assertEqual(point["precision"], "plus_code")
        self.assertEqual(point["source"], "open-location-code")
        self.assertAlmostEqual(point["longitude"], 75.6884375)

    def test_a_malformed_point_is_dropped_rather_than_losing_the_address(self):
        site = Site.objects.create(
            lab_code="GEO-6",
            name="Bad point",
            country_code="IND",
            address={
                "country_code": "IND",
                "locality": "Kochi",
                "geo_point": {"latitude": 999, "longitude": 76.2, "precision": "postal_area"},
            },
        )
        # The impossible latitude is discarded and the address survives; the site is then
        # placed from its town on the same save.
        self.assertEqual(site.address["locality"], "KOCHI")
        self.assertEqual(site.address["geo_point"]["precision"], "locality")

    def test_a_point_with_no_precision_is_refused(self):
        # A coordinate whose exactness is unknown cannot be filtered, and would be plotted
        # as though it were a street address.
        site = Site.objects.create(
            lab_code="GEO-7",
            name="No precision",
            country_code="IND",
            address={
                "country_code": "IND",
                "postal_code": "682011",
                "geo_point": {"latitude": 9.5, "longitude": 76.5},
            },
        )
        self.assertEqual(site.address["geo_point"]["precision"], "postal_area")
