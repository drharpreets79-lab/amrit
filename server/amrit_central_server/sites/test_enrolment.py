"""Phase 8 gate: site enrolment is authenticated, and the wire contract stays tolerant.

Before this, both endpoints were reachable with no credential at all. fetch_site_token
issues a *new* bearer token and returns it, and issuing rotates the token, so an
unauthenticated caller knowing only a lab code could impersonate a laboratory and cut off
the real site's sync in the same request.
"""

from __future__ import annotations

import hashlib
import os
from unittest import mock

from django.core.cache import cache
from django.test import Client, TestCase, override_settings
from django.urls import reverse

from geo.loader import canonical_bytes, load_pack, validate_pack
from sites.models import Site, SiteEnrolmentRequest

SECRET = "enrolment-secret-for-tests"


def geo_pack() -> dict:
    units = [
        {"level": 1, "code": "TR-34", "parent_code": None, "name": "İstanbul"},
        {"level": 2, "code": "TR-34-01", "parent_code": "TR-34", "name": "Şişli"},
    ]
    pack = {
        "schemaVersion": 1, "dataset": "amrit-geo-pack", "version": "1.0",
        "countryCode": "TUR", "countryName": "Türkiye",
        "levels": [
            {"level": 1, "key": "province", "label": "Province", "label_plural": "Provinces", "code_system": "ISO3166-2"},
            {"level": 2, "key": "district", "label": "District", "label_plural": "Districts", "code_system": "GeoNames"},
        ],
        "minimumCounts": {}, "rowCounts": {"total": len(units)}, "units": units,
    }
    pack["contentSha256"] = hashlib.sha256(canonical_bytes(units)).hexdigest()
    return validate_pack(pack)


class EnrolmentAuthorisationTests(TestCase):
    def setUp(self):
        cache.clear()  # the enrolment throttle counts per caller and outlives a test
        self.client = Client()

    def _post(self, name, payload, secret=None):
        headers = {"HTTP_X_AMRIT_ENROLMENT_SECRET": secret} if secret else {}
        return self.client.post(reverse(name), payload, content_type="application/json", **headers)

    @mock.patch.dict(os.environ, {"AMRIT_ENROLMENT_SECRET": SECRET, "AMRIT_ALLOW_UNAUTHENTICATED_ENROLMENT": ""})
    def test_asking_needs_no_secret_and_registers_nothing(self):
        """Asking is open because asking achieves nothing: approval is the gate.

        Requiring a secret here would mean issuing one shared secret to every laboratory in
        the programme — a worse thing to have to protect than a queue entry that grants
        nobody anything.
        """
        response = self._post("create_labcode", {"lab_code": "NEW01", "laboratory_name": "New"})
        self.assertEqual(response.status_code, 202)
        self.assertFalse(Site.objects.filter(lab_code="NEW01").exists())
        self.assertTrue(SiteEnrolmentRequest.objects.filter(lab_code="NEW01", status="pending").exists())

    @mock.patch.dict(os.environ, {"AMRIT_ENROLMENT_SECRET": SECRET, "AMRIT_ALLOW_UNAUTHENTICATED_ENROLMENT": ""})
    def test_editing_a_registered_site_without_the_secret_is_refused(self):
        """The path that can overwrite a live site's name and geography keeps the secret."""
        Site.objects.create(lab_code="LIVE10", name="Original name", status="active")
        response = self._post("create_labcode", {"lab_code": "LIVE10", "laboratory_name": "Overwritten"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(Site.objects.get(lab_code="LIVE10").name, "Original name")

    @mock.patch.dict(os.environ, {"AMRIT_ENROLMENT_SECRET": SECRET, "AMRIT_ALLOW_UNAUTHENTICATED_ENROLMENT": ""})
    def test_editing_a_registered_site_with_a_wrong_secret_is_refused(self):
        Site.objects.create(lab_code="LIVE11", name="Original name", status="active")
        response = self._post(
            "create_labcode", {"lab_code": "LIVE11", "laboratory_name": "Overwritten"}, secret="wrong")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(Site.objects.get(lab_code="LIVE11").name, "Original name")

    @mock.patch.dict(os.environ, {"AMRIT_ENROLMENT_SECRET": SECRET, "AMRIT_ALLOW_UNAUTHENTICATED_ENROLMENT": ""})
    def test_one_caller_cannot_flood_the_approval_queue(self):
        """An open door must not also be a megaphone: a queue nobody can read is not a gate."""
        codes = [f"FLOOD{index:02d}" for index in range(12)]
        statuses = [self._post("register_site", {"lab_code": code, "name": code}).status_code
                    for code in codes]
        self.assertEqual(statuses.count(202), 10)
        self.assertEqual(statuses.count(429), 2)
        self.assertEqual(SiteEnrolmentRequest.objects.count(), 10)

    def test_forwarded_address_is_ignored_without_explicit_proxy_trust(self):
        response = self.client.post(
            reverse("register_site"),
            {"lab_code": "IPSAFE01", "name": "IP-safe"},
            content_type="application/json",
            REMOTE_ADDR="10.20.30.40",
            HTTP_X_FORWARDED_FOR="203.0.113.250",
        )
        self.assertEqual(response.status_code, 202)
        self.assertEqual(
            SiteEnrolmentRequest.objects.get(lab_code="IPSAFE01").source_ip,
            "10.20.30.40",
        )

    @override_settings(AMRIT_TRUST_PROXY_HEADERS=True)
    def test_forwarded_address_is_used_only_behind_configured_proxy(self):
        response = self.client.post(
            reverse("register_site"),
            {"lab_code": "IPPROXY1", "name": "Proxy-safe"},
            content_type="application/json",
            REMOTE_ADDR="10.20.30.40",
            HTTP_X_FORWARDED_FOR="203.0.113.250, 10.20.30.1",
        )
        self.assertEqual(response.status_code, 202)
        self.assertEqual(
            SiteEnrolmentRequest.objects.get(lab_code="IPPROXY1").source_ip,
            "203.0.113.250",
        )

    @mock.patch.dict(os.environ, {"AMRIT_ENROLMENT_SECRET": SECRET, "AMRIT_ALLOW_UNAUTHENTICATED_ENROLMENT": ""})
    def test_a_laboratory_retrying_its_own_request_is_not_throttled(self):
        """A desktop waiting for a decision retries steadily; that is correct behaviour."""
        statuses = [self._post("register_site", {"lab_code": "RETRY99", "name": "Patient"}).status_code
                    for _ in range(15)]
        self.assertEqual(set(statuses), {202})
        self.assertEqual(SiteEnrolmentRequest.objects.filter(lab_code="RETRY99").count(), 1)

    @mock.patch.dict(os.environ, {"AMRIT_ENROLMENT_SECRET": SECRET, "AMRIT_ALLOW_UNAUTHENTICATED_ENROLMENT": ""})
    def test_token_issuance_without_the_secret_is_refused(self):
        """The sharpest case: this endpoint mints a credential and rotates the old one."""
        site = Site.objects.create(lab_code="LIVE01", name="Live", status="active")
        site.set_auth_token(Site.issue_token())
        site.save(update_fields=["auth_token_hash", "auth_token_prefix"])
        before = site.auth_token_hash

        response = self._post("fetch_site_token", {"lab_code": "LIVE01"})

        self.assertEqual(response.status_code, 401)
        site.refresh_from_db()
        # The existing token must survive: rotation here is also a denial of service.
        self.assertEqual(site.auth_token_hash, before)

    @mock.patch.dict(os.environ, {"AMRIT_ENROLMENT_SECRET": SECRET, "AMRIT_ALLOW_UNAUTHENTICATED_ENROLMENT": ""})
    def test_token_issuance_with_the_secret_succeeds(self):
        site = Site.objects.create(lab_code="LIVE02", name="Live", status="active")
        response = self._post("fetch_site_token", {"lab_code": "LIVE02"}, secret=SECRET)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["new_token"])

    @mock.patch.dict(os.environ, {"AMRIT_ENROLMENT_SECRET": "", "AMRIT_ALLOW_UNAUTHENTICATED_ENROLMENT": ""})
    def test_an_unconfigured_server_still_takes_requests_but_permits_no_edits(self):
        """A server with no secret set can be asked, and can change nothing.

        Which is the useful shape: a deployment that has not yet distributed an enrolment
        secret can still onboard laboratories through approval, while the path that rewrites
        existing registry rows stays shut.
        """
        asked = self._post("create_labcode", {"lab_code": "NEW02", "laboratory_name": "New"})
        self.assertEqual(asked.status_code, 202)
        self.assertFalse(Site.objects.filter(lab_code="NEW02").exists())

        Site.objects.create(lab_code="LIVE12", name="Original name", status="active")
        edit = self._post("create_labcode", {"lab_code": "LIVE12", "laboratory_name": "Overwritten"})
        self.assertEqual(edit.status_code, 503)
        self.assertEqual(Site.objects.get(lab_code="LIVE12").name, "Original name")

    @mock.patch.dict(os.environ, {"AMRIT_ENROLMENT_SECRET": "", "AMRIT_ALLOW_UNAUTHENTICATED_ENROLMENT": "1"})
    def test_the_transition_escape_hatch_only_affects_edits_now(self):
        """The hatch waives the secret on the edit path; asking never needed it."""
        with self.assertLogs("amrit.sites", level="WARNING") as logs:
            Site.objects.create(lab_code="OLD01", name="Original name", status="active")
            response = self._post("create_labcode", {"lab_code": "OLD01", "laboratory_name": "Legacy"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(Site.objects.get(lab_code="OLD01").name, "Legacy")
        self.assertIn("unauthenticated", " ".join(logs.output).lower())


@mock.patch.dict(os.environ, {"AMRIT_ENROLMENT_SECRET": SECRET, "AMRIT_ALLOW_UNAUTHENTICATED_ENROLMENT": ""})
class WireContractToleranceTests(TestCase):
    """What the two registration endpoints accept, and what they do with it.

    An unrecognised lab code now files a request instead of registering itself, so these
    assert on the request the server recorded. That the geography is parsed here and
    *resolved* on approval is covered end to end in test_registry_admin.py.
    """

    def setUp(self):
        cache.clear()  # the enrolment throttle counts per caller and outlives a test
        self.client = Client()
        load_pack(geo_pack())

    def _post(self, name, payload):
        return self.client.post(
            reverse(name), payload, content_type="application/json",
            HTTP_X_AMRIT_ENROLMENT_SECRET=SECRET,
        )

    def test_a_structured_address_is_stored_and_rendered(self):
        response = self._post("create_labcode", {
            "lab_code": "ADDR10", "laboratory_name": "Addressed client",
            "country": "India", "country_code": "IND",
            "address": {"address_lines": ["12 Hospital Road"], "locality": "Kochi",
                        "admin_area": "Kerala", "postal_code": "682011"},
        })
        self.assertEqual(response.status_code, 202)
        pending = SiteEnrolmentRequest.objects.get(lab_code="ADDR10")
        self.assertEqual(pending.address["postal_code"], "682011")
        self.assertIn("12 Hospital Road", pending.address["formatted"])

    def test_an_address_that_breaks_its_country_rules_is_a_400(self):
        """Refused at the door, with the field named, rather than stored unrenderable."""
        response = self._post("create_labcode", {
            "lab_code": "BADADDR", "laboratory_name": "Bad address", "country_code": "IND",
            "address": {"postal_code": "NOT-A-PIN"},
        })
        self.assertEqual(response.status_code, 400)
        self.assertIn("pin", response.json()["error"].lower())
        self.assertFalse(Site.objects.filter(lab_code="BADADDR").exists())
        # Nor may a rejected payload leave a request behind for someone to approve.
        self.assertFalse(SiteEnrolmentRequest.objects.filter(lab_code="BADADDR").exists())

    def test_missing_geography_is_accepted(self):
        response = self._post("create_labcode", {"lab_code": "NOGEO", "laboratory_name": "No geography"})
        self.assertEqual(response.status_code, 202)
        pending = SiteEnrolmentRequest.objects.get(lab_code="NOGEO")
        self.assertEqual(pending.address, {})
        self.assertEqual(pending.admin_units, [])

    def test_a_missing_lab_code_is_a_400_not_a_crash(self):
        self.assertEqual(self._post("create_labcode", {"laboratory_name": "Nameless"}).status_code, 400)

    def test_v2_records_administrative_codes_at_any_depth_as_claimed(self):
        response = self._post("register_site", {
            "lab_code": "NEWCLIENT", "name": "Country-neutral client",
            "country_code": "TUR",
            "admin_units": [{"level": 1, "code": "TR-34"}, {"level": 2, "code": "TR-34-01"}],
        })
        self.assertEqual(response.status_code, 202)
        pending = SiteEnrolmentRequest.objects.get(lab_code="NEWCLIENT")
        self.assertEqual(pending.country_code, "TUR")
        # Stored as claimed, at whatever depth: resolution waits for the decision, so a
        # request that arrives before its unit is loaded still places correctly later.
        self.assertEqual([entry["code"] for entry in pending.admin_units], ["TR-34", "TR-34-01"])

    def test_v2_tells_a_client_that_nothing_is_registered_yet(self):
        response = self._post("register_site", {"lab_code": "PLAIN", "name": "Plain"})
        self.assertEqual(response.status_code, 202)
        body = response.json()
        self.assertEqual(body["status"], "pending")
        self.assertEqual(body["lab_code"], "PLAIN")
        self.assertTrue(body["requested_at"])

    def test_a_registered_site_updating_its_details_is_not_sent_to_the_queue(self):
        """The queue is for strangers. A known site editing itself is what the secret governs."""
        Site.objects.create(lab_code="KNOWN01", name="Old name", status="active")
        response = self._post("register_site", {
            "lab_code": "KNOWN01", "name": "New name", "country_code": "TUR",
            "admin_units": [{"level": 2, "code": "TR-34-01"}],
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["admin_path"], "TUR/TR-34/TR-34-01")
        self.assertEqual(Site.objects.get(lab_code="KNOWN01").name, "New name")
        self.assertFalse(SiteEnrolmentRequest.objects.filter(lab_code="KNOWN01").exists())

    def test_a_client_that_retries_refreshes_its_request_rather_than_burying_the_queue(self):
        first = self._post("register_site", {"lab_code": "RETRY01", "name": "First try"})
        second = self._post("register_site", {"lab_code": "RETRY01", "name": "Second try"})
        self.assertEqual((first.status_code, second.status_code), (202, 202))
        self.assertEqual(SiteEnrolmentRequest.objects.filter(lab_code="RETRY01").count(), 1)
        self.assertEqual(SiteEnrolmentRequest.objects.get(lab_code="RETRY01").name, "Second try")


class UrlNameTests(TestCase):
    def test_the_two_enrolment_routes_have_distinct_names(self):
        """Both were named create_labcode, so reverse() resolved to whichever registered last."""
        self.assertEqual(reverse("create_labcode"), "/create_labcode/")
        self.assertEqual(reverse("fetch_site_token"), "/fetch_site_token/")
