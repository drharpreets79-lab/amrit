"""Presence, with a location only when the site gave one.

A heartbeat says a laboratory is alive. Coordinates are an optional extra: the desktop's
settings screen, its stored configuration and this handler all treat them as optional, and
the two sides have to agree about that — a desktop that consented to sharing a location
without typing one must still be able to report that it is online.
"""

from __future__ import annotations

import json

from django.test import Client, TestCase

from sites.models import Site


class HeartbeatTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.token = Site.issue_token(24)
        self.site_token = Site.issue_token(16)
        self.site = Site(lab_code="LAB01", name="Test laboratory", status="active")
        self.site.set_auth_token(self.token)
        self.site.set_site_token(self.site_token)
        self.site.save()
        self.headers = {
            "HTTP_AUTHORIZATION": f"Bearer {self.token}",
            "HTTP_X_AMRIT_SITE": self.site_token,
        }

    def _beat(self, body: dict):
        return self.client.post(
            "/v1/heartbeat", data=json.dumps(body), content_type="application/json", **self.headers
        )

    def test_presence_without_coordinates_is_accepted(self):
        response = self._beat({"lab_code": "LAB01", "app_version": "2.0.0", "gps_consent": True})
        self.assertEqual(response.status_code, 200)
        self.site.refresh_from_db()
        self.assertIsNotNone(self.site.last_seen_at)
        # No location was given, so none was invented.
        self.assertIsNone(self.site.latitude)
        self.assertIsNone(self.site.longitude)

    def test_coordinates_are_stored_when_they_are_given(self):
        response = self._beat({
            "lab_code": "LAB01", "gps_consent": True, "gps_source": "manual",
            "latitude": 28.61, "longitude": 77.21,
        })
        self.assertEqual(response.status_code, 200)
        self.site.refresh_from_db()
        self.assertAlmostEqual(self.site.latitude, 28.61)
        self.assertAlmostEqual(self.site.longitude, 77.21)

    def test_a_coordinate_out_of_range_is_refused(self):
        response = self._beat({"lab_code": "LAB01", "gps_consent": True, "latitude": 128.6, "longitude": 77.2})
        self.assertEqual(response.status_code, 400)
        self.site.refresh_from_db()
        self.assertIsNone(self.site.latitude)

    def test_coordinates_without_consent_are_not_stored(self):
        response = self._beat({"lab_code": "LAB01", "gps_consent": False, "latitude": 28.61, "longitude": 77.21})
        self.assertEqual(response.status_code, 200)
        self.site.refresh_from_db()
        self.assertIsNone(self.site.latitude)

    def test_an_unauthenticated_heartbeat_is_refused(self):
        response = self.client.post(
            "/v1/heartbeat", data=json.dumps({"lab_code": "LAB01"}), content_type="application/json"
        )
        self.assertEqual(response.status_code, 401)
