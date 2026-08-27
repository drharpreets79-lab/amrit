"""Administering the registry from the portal: approve, decline, rename, disable, remove.

Two things are being pinned down here.

The first is that joining the registry is a decision. Holding the enrolment secret gets a
laboratory as far as asking; a person with ``manage_sites`` is what turns a request into a
site, and until they do, nothing about it exists and no token can be fetched.

The second is the fix for a registry and a desktop that disagree about a laboratory's code —
the failure a site sees as ``HTTP 403 {"error": "lab_code mismatch"}``. The server can be
renamed to match the desktop, carrying the queries addressed to the old code, leaving the
audit trail alone and leaving the token valid so the laboratory reconfigures nothing.
"""

from __future__ import annotations

import os
from datetime import timedelta
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import Client, TestCase
from django.urls import reverse
from django.utils import timezone

from geo.models import AdminUnit
from queries.models import PollAuditEntry, Query, QueryDispatch, QueryResult
from sites.models import RoleDefinition, Site, SiteEnrolmentRequest, UserProfile

SECRET = "enrolment-secret-for-tests"


class RegistryAdminTestCase(TestCase):
    def setUp(self):
        # The enrolment throttle counts per caller in the cache, which outlives a test case:
        # every test here calls from 127.0.0.1, so without this they share one hourly budget
        # and whichever runs eleventh fails for reasons that have nothing to do with it.
        cache.clear()
        self.client = Client()
        self.istanbul = AdminUnit.objects.create(
            id="TUR:1:TR-34", country_code="TUR", level=1, code="TR-34", name="İstanbul",
            admin_path="TUR/TR-34")
        self.sisli = AdminUnit.objects.create(
            id="TUR:2:TR-34-01", country_code="TUR", level=2, code="TR-34-01", parent=self.istanbul,
            name="Şişli", admin_path="TUR/TR-34/TR-34-01")
        RoleDefinition.objects.update_or_create(
            slug="registry_admin",
            defaults={"label": "Registry administrator", "scope_kind": "all", "dashboard_kind": "country",
                      "capabilities": ["manage_sites", "view_dashboard", "view_all_sites"], "is_active": True},
        )
        self.operator = get_user_model().objects.create_user(username="registrar", password="test-pass")
        UserProfile.objects.create(user=self.operator, role="registry_admin")
        self.client.force_login(self.operator)

    def request_for(self, lab_code, **fields):
        return SiteEnrolmentRequest.objects.create(lab_code=lab_code, **fields)

    def decide(self, enrolment, decision, note=""):
        return self.client.post(
            reverse("dashboard_site_request_decide", args=[enrolment.pk]),
            {"decision": decision, "note": note},
        )


class ScreenRenderTests(RegistryAdminTestCase):
    """Every registry screen renders. Two of these views shipped with no template at all."""

    def setUp(self):
        super().setUp()
        self.site = Site.objects.create(lab_code="RENDER01", name="Rendered lab", status="active")

    def test_each_screen_answers_200(self):
        for name, args in [
            ("dashboard_sites", []),
            ("dashboard_site_requests", []),
            ("dashboard_site_create", []),
            ("dashboard_site_edit", ["RENDER01"]),
            ("dashboard_site_rename", ["RENDER01"]),
            ("dashboard_site_delete", ["RENDER01"]),
            ("dashboard_site_token", ["RENDER01"]),
        ]:
            with self.subTest(screen=name):
                self.assertEqual(self.client.get(reverse(name, args=args)).status_code, 200)

    def test_the_rename_screen_states_what_it_will_carry(self):
        Query.objects.create(type="isolate_count", target_lab_codes=["RENDER01"])
        response = self.client.get(reverse("dashboard_site_rename", args=["RENDER01"]))
        self.assertEqual(response.context["targeted_queries"], 1)
        self.assertContains(response, "Bearer token")

    @mock.patch.dict(os.environ, {"AMRIT_ENROLMENT_SECRET": SECRET, "AMRIT_ALLOW_UNAUTHENTICATED_ENROLMENT": ""})
    def test_a_requested_address_reads_as_an_address(self):
        """Not as a Python list. The queue showed ``['Dhanvantari Nagar'], Puducherry``."""
        self.client.post(
            reverse("register_site"),
            {"lab_code": "IN-JIPMER-PDY", "name": "JIPMER Puducherry", "country_code": "IND",
             "address": {"address_lines": ["Dhanvantari Nagar"], "locality": "Puducherry",
                         "admin_area": "Puducherry", "postal_code": "605006"}},
            content_type="application/json", HTTP_X_AMRIT_ENROLMENT_SECRET=SECRET)
        self.client.force_login(self.operator)
        response = self.client.get(reverse("dashboard_site_requests"))
        body = response.content.decode()
        self.assertIn("Dhanvantari Nagar", body)
        self.assertIn("605006", body)
        self.assertNotIn("[&#x27;Dhanvantari Nagar&#x27;]", body)
        self.assertNotIn("['Dhanvantari Nagar']", body)
        # A multi-line {# … #} is not a comment in Django, so it used to render as text.
        self.assertNotIn("clean_address", body)

    def test_the_header_counts_what_is_waiting_for_whoever_can_decide(self):
        self.request_for("BADGE01", name="Waiting")
        response = self.client.get(reverse("dashboard_sites"))
        self.assertEqual(response.context["amrit_pending_site_requests"], 1)

    def test_an_operator_who_cannot_decide_is_not_shown_a_count(self):
        RoleDefinition.objects.update_or_create(
            slug="bystander", defaults={"label": "Bystander", "scope_kind": "all",
                                        "capabilities": ["view_dashboard", "view_all_sites"],
                                        "is_active": True})
        bystander = get_user_model().objects.create_user(username="bystander", password="test-pass")
        UserProfile.objects.create(user=bystander, role="bystander")
        self.request_for("BADGE02", name="Waiting")
        self.client.force_login(bystander)
        response = self.client.get(reverse("dashboard_sites"))
        self.assertEqual(response.context["amrit_pending_site_requests"], 0)


class ApprovalTests(RegistryAdminTestCase):
    def test_the_queue_lists_what_is_waiting(self):
        self.request_for("WAIT01", name="Waiting lab")
        response = self.client.get(reverse("dashboard_site_requests"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "WAIT01")
        self.assertContains(response, "Waiting lab")

    def test_the_registry_page_carries_the_decision_buttons_itself(self):
        """Not only a link to a queue: the decision is on the page already open."""
        self.request_for("INLINE01", name="Waiting lab")
        response = self.client.get(reverse("dashboard_sites"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual([r.lab_code for r in response.context["pending_request_list"]], ["INLINE01"])
        self.assertContains(response, "Awaiting your decision")
        self.assertContains(response, 'name="decision" value="approve"')
        self.assertContains(response, 'name="decision" value="reject"')
        self.assertContains(response, "Decline")
        self.assertContains(response, reverse("dashboard_site_request_decide", args=[
            SiteEnrolmentRequest.objects.get(lab_code="INLINE01").pk]))

    def test_declining_from_the_registry_page_returns_to_it(self):
        enrolment = self.request_for("INLINE02", name="Waiting lab")
        response = self.client.post(
            reverse("dashboard_site_request_decide", args=[enrolment.pk]),
            {"decision": "reject", "note": "no", "next": "/dashboard/sites/?status=active"})
        self.assertRedirects(response, "/dashboard/sites/?status=active")
        self.assertEqual(SiteEnrolmentRequest.objects.get(pk=enrolment.pk).status, "rejected")

    def test_approving_still_lands_on_the_token_screen(self):
        """A registered site that cannot sync is not finished business."""
        enrolment = self.request_for("INLINE03", name="Waiting lab")
        response = self.client.post(
            reverse("dashboard_site_request_decide", args=[enrolment.pk]),
            {"decision": "approve", "next": "/dashboard/sites/"})
        self.assertRedirects(response, reverse("dashboard_site_token", args=["INLINE03"]))

    def test_an_off_host_return_target_is_ignored(self):
        """An unchecked posted redirect makes every button here an open redirect."""
        enrolment = self.request_for("INLINE04", name="Waiting lab")
        response = self.client.post(
            reverse("dashboard_site_request_decide", args=[enrolment.pk]),
            {"decision": "reject", "next": "https://evil.example/login"})
        self.assertRedirects(response, reverse("dashboard_site_requests"))

    def test_an_operator_who_cannot_decide_is_not_shown_the_requests(self):
        """The cards carry a stranger's contact address and originating IP."""
        RoleDefinition.objects.update_or_create(
            slug="watcher", defaults={"label": "Watcher", "scope_kind": "all",
                                      "capabilities": ["view_dashboard", "view_all_sites"],
                                      "is_active": True})
        watcher = get_user_model().objects.create_user(username="watcher", password="test-pass")
        UserProfile.objects.create(user=watcher, role="watcher")
        self.request_for("HIDDEN01", name="Waiting lab", contact_email="private@example.org")
        self.client.force_login(watcher)
        response = self.client.get(reverse("dashboard_sites"))
        self.assertEqual(response.context["pending_request_list"], [])
        self.assertEqual(response.context["pending_requests"], 0)
        self.assertNotContains(response, "private@example.org")
        self.assertNotContains(response, "HIDDEN01")

    def test_approving_is_what_creates_the_site(self):
        enrolment = self.request_for(
            "AIIMS01", name="AIIMS Delhi", country="India", country_code="IND",
            contact_email="lab@example.org")
        self.assertFalse(Site.objects.filter(lab_code="AIIMS01").exists())

        response = self.decide(enrolment, "approve", note="verified by phone")

        self.assertRedirects(response, reverse("dashboard_site_token", args=["AIIMS01"]))
        site = Site.objects.get(lab_code="AIIMS01")
        self.assertEqual(site.name, "AIIMS Delhi")
        self.assertEqual(site.contact_email, "lab@example.org")
        self.assertEqual(site.status, "active")
        enrolment.refresh_from_db()
        self.assertEqual(enrolment.status, "approved")
        self.assertEqual(enrolment.decided_by, self.operator)
        self.assertEqual(enrolment.decision_note, "verified by phone")
        self.assertEqual(enrolment.site, site)

    def test_approval_does_not_mint_a_token_as_a_side_effect(self):
        """A decision made quickly through a list must not also issue a credential."""
        enrolment = self.request_for("NOTOK01", name="No token yet")
        self.decide(enrolment, "approve")
        self.assertEqual(Site.objects.get(lab_code="NOTOK01").auth_token_hash, "")

    def test_approval_resolves_the_deepest_administrative_unit_claimed(self):
        enrolment = self.request_for(
            "DEEP01", name="Deep claim", country_code="TUR",
            admin_units=[{"level": 1, "code": "TR-34"}, {"level": 2, "code": "TR-34-01"}])
        self.decide(enrolment, "approve")
        site = Site.objects.get(lab_code="DEEP01")
        self.assertEqual(site.admin_unit_id, "TUR:2:TR-34-01")
        self.assertEqual(site.admin_path, "TUR/TR-34/TR-34-01")

    def test_an_unrecognised_claim_places_the_site_nowhere_rather_than_somewhere_wrong(self):
        enrolment = self.request_for(
            "NOWHERE01", name="Unknown geography", country_code="TUR",
            admin_units=[{"level": 1, "code": "NOT-A-UNIT"}])
        self.decide(enrolment, "approve")
        self.assertIsNone(Site.objects.get(lab_code="NOWHERE01").admin_unit_id)

    def test_declining_keeps_the_row_and_creates_nothing(self):
        enrolment = self.request_for("NOPE01", name="Declined lab")
        self.decide(enrolment, "reject", note="not a surveillance site")
        self.assertFalse(Site.objects.filter(lab_code="NOPE01").exists())
        enrolment.refresh_from_db()
        self.assertEqual(enrolment.status, "rejected")
        self.assertEqual(enrolment.decision_note, "not a surveillance site")

    def test_a_request_cannot_be_decided_twice(self):
        """Two administrators opening the same queue must not create the site twice."""
        enrolment = self.request_for("ONCE01", name="Once only")
        self.decide(enrolment, "approve")
        response = self.decide(enrolment, "approve")
        self.assertRedirects(response, reverse("dashboard_site_requests"))
        self.assertEqual(Site.objects.filter(lab_code="ONCE01").count(), 1)

    def test_an_operator_without_manage_sites_cannot_reach_the_queue(self):
        RoleDefinition.objects.update_or_create(
            slug="onlooker", defaults={"label": "Onlooker", "scope_kind": "none",
                                       "capabilities": ["view_dashboard"], "is_active": True})
        onlooker = get_user_model().objects.create_user(username="onlooker", password="test-pass")
        UserProfile.objects.create(user=onlooker, role="onlooker")
        self.client.force_login(onlooker)
        self.assertNotEqual(self.client.get(reverse("dashboard_site_requests")).status_code, 200)

    @mock.patch.dict(os.environ, {"AMRIT_ENROLMENT_SECRET": SECRET, "AMRIT_ALLOW_UNAUTHENTICATED_ENROLMENT": ""})
    def test_a_waiting_laboratory_is_told_it_is_waiting_rather_than_that_it_is_wrong(self):
        """The desktop polls for its token; the answer has to say which of these it is."""
        self.request_for("PENDING01", name="Still waiting")
        response = self.client.post(
            reverse("fetch_site_token"), {"lab_code": "PENDING01"},
            content_type="application/json", HTTP_X_AMRIT_ENROLMENT_SECRET=SECRET)
        self.assertEqual(response.status_code, 202)
        body = response.json()
        self.assertEqual(body["status"], "pending")
        self.assertIsNone(body["new_token"])
        self.assertIn("awaiting approval", body["detail"].lower())

    @mock.patch.dict(os.environ, {"AMRIT_ENROLMENT_SECRET": SECRET, "AMRIT_ALLOW_UNAUTHENTICATED_ENROLMENT": ""})
    def test_a_declined_laboratory_is_told_it_was_declined(self):
        self.request_for("DECLINED01", name="Declined", status="rejected")
        response = self.client.post(
            reverse("fetch_site_token"), {"lab_code": "DECLINED01"},
            content_type="application/json", HTTP_X_AMRIT_ENROLMENT_SECRET=SECRET)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["status"], "rejected")

    @mock.patch.dict(os.environ, {"AMRIT_ENROLMENT_SECRET": SECRET, "AMRIT_ALLOW_UNAUTHENTICATED_ENROLMENT": ""})
    def test_an_unknown_laboratory_is_told_to_register_first(self):
        response = self.client.post(
            reverse("fetch_site_token"), {"lab_code": "GHOST01"},
            content_type="application/json", HTTP_X_AMRIT_ENROLMENT_SECRET=SECRET)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["status"], "unknown")


class ManualRegistrationTests(RegistryAdminTestCase):
    def test_a_site_can_be_added_by_hand(self):
        response = self.client.post(reverse("dashboard_site_create"), {
            "lab_code": "BYHAND01", "name": "Programme lab", "country": "Türkiye",
            "country_code": "tur", "admin_unit": self.sisli.pk, "status": "active",
            "timezone": "", "lab_domain": "", "contact_email": "", "notes": "",
        })
        self.assertRedirects(response, reverse("dashboard_site_token", args=["BYHAND01"]))
        site = Site.objects.get(lab_code="BYHAND01")
        self.assertEqual(site.country_code, "TUR")
        self.assertEqual(site.admin_path, "TUR/TR-34/TR-34-01")

    def test_a_duplicate_lab_code_is_refused(self):
        Site.objects.create(lab_code="TAKEN01", name="First")
        response = self.client.post(reverse("dashboard_site_create"), {
            "lab_code": "taken01", "name": "Second", "status": "active",
            "country": "", "country_code": "", "timezone": "", "lab_domain": "",
            "contact_email": "", "notes": "",
        })
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "already registered")
        self.assertEqual(Site.objects.filter(name="Second").count(), 0)

    def test_editing_a_site_cannot_change_its_code(self):
        """The edit form is for details. A code change is an event with its own screen."""
        Site.objects.create(lab_code="FIXED01", name="Before")
        response = self.client.post(reverse("dashboard_site_edit", args=["FIXED01"]), {
            "lab_code": "SOMETHINGELSE", "name": "After", "status": "active",
            "country": "", "country_code": "", "timezone": "", "lab_domain": "",
            "contact_email": "", "notes": "",
        })
        self.assertRedirects(response, reverse("dashboard_sites"))
        self.assertEqual(Site.objects.get(lab_code="FIXED01").name, "After")
        self.assertFalse(Site.objects.filter(lab_code="SOMETHINGELSE").exists())


class RemovalTests(RegistryAdminTestCase):
    def test_disabling_stops_the_sync_and_keeps_the_row(self):
        site = Site.objects.create(lab_code="OFF01", name="To disable", status="active")
        site.set_auth_token(Site.issue_token())
        site.save()
        response = self.client.post(reverse("dashboard_site_delete", args=["OFF01"]), {"action": "disable"})
        self.assertRedirects(response, reverse("dashboard_sites"))
        site.refresh_from_db()
        self.assertEqual(site.status, "disabled")

    def test_a_disabled_site_can_no_longer_authenticate(self):
        site = Site.objects.create(lab_code="OFF02", name="To disable", status="active")
        token = Site.issue_token()
        site.set_auth_token(token)
        site.save()
        self.assertIsNotNone(Site.authenticate_bearer(token))
        site.status = "disabled"
        site.save(update_fields=["status"])
        self.assertIsNone(Site.authenticate_bearer(token))

    def test_removing_states_what_goes_before_it_happens(self):
        Site.objects.create(lab_code="GONE01", name="To remove", status="active")
        response = self.client.get(reverse("dashboard_site_delete", args=["GONE01"]))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "GONE01")
        self.assertContains(response, "not")  # "…data already received is not deleted"

    def test_removing_deletes_the_registry_row(self):
        Site.objects.create(lab_code="GONE02", name="To remove", status="active")
        response = self.client.post(reverse("dashboard_site_delete", args=["GONE02"]), {"action": "delete"})
        self.assertRedirects(response, reverse("dashboard_sites"))
        self.assertFalse(Site.objects.filter(lab_code="GONE02").exists())

    def _site_with_a_reported_result(self, lab_code):
        site = Site.objects.create(lab_code=lab_code, name="Has reported", status="active")
        query = Query.objects.create(type="isolate_count", target_lab_codes=[lab_code])
        QueryResult.objects.create(query=query, site=site, ok=True, result_json={"count": 12})
        return site

    def test_the_page_says_reported_results_go_with_the_site(self):
        """QueryResult.site cascades. The page used to promise the opposite."""
        self._site_with_a_reported_result("HASDATA01")
        response = self.client.get(reverse("dashboard_site_delete", args=["HASDATA01"]))
        self.assertEqual(response.context["result_count"], 1)
        self.assertContains(response, "deleted with it")

    def test_removing_a_site_that_has_reported_needs_its_code_typed_back(self):
        self._site_with_a_reported_result("HASDATA02")
        response = self.client.post(reverse("dashboard_site_delete", args=["HASDATA02"]),
                                    {"action": "delete"})
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "aggregate result")
        self.assertTrue(Site.objects.filter(lab_code="HASDATA02").exists())
        self.assertEqual(QueryResult.objects.count(), 1)

    def test_a_typed_confirmation_removes_the_site_and_says_what_went(self):
        self._site_with_a_reported_result("HASDATA03")
        response = self.client.post(
            reverse("dashboard_site_delete", args=["HASDATA03"]),
            {"action": "delete", "confirm_lab_code": "HASDATA03"}, follow=True)
        self.assertFalse(Site.objects.filter(lab_code="HASDATA03").exists())
        self.assertEqual(QueryResult.objects.count(), 0)
        self.assertContains(response, "1 result it had reported")

    def test_disabling_a_site_that_has_reported_keeps_everything(self):
        """The path the page pushes towards, and the reason it does."""
        self._site_with_a_reported_result("HASDATA04")
        self.client.post(reverse("dashboard_site_delete", args=["HASDATA04"]), {"action": "disable"})
        self.assertEqual(Site.objects.get(lab_code="HASDATA04").status, "disabled")
        self.assertEqual(QueryResult.objects.count(), 1)


class RenameTests(RegistryAdminTestCase):
    """The fix for ``HTTP 403 {"error": "lab_code mismatch"}``."""

    def setUp(self):
        super().setUp()
        self.site = Site.objects.create(
            lab_code="INDIA01", name="AIIMS Delhi", country_code="IND", status="active")
        self.token = Site.issue_token()
        self.site.set_auth_token(self.token)
        self.site.save()

    def rename(self, new_code, confirm=None, note=""):
        return self.client.post(reverse("dashboard_site_rename", args=[self.site.lab_code]), {
            "new_lab_code": new_code,
            "confirm_lab_code": self.site.lab_code if confirm is None else confirm,
            "note": note,
        })

    def test_the_registry_can_be_renamed_to_the_code_the_desktop_uses(self):
        response = self.rename("IN-AIIMS-DEL", note="desktop was configured first")
        self.assertRedirects(response, reverse("dashboard_sites"))
        self.site.refresh_from_db()
        self.assertEqual(self.site.lab_code, "IN-AIIMS-DEL")

    def test_the_token_survives_the_rename(self):
        """The whole point: the laboratory reconfigures nothing and its sync resumes."""
        self.rename("IN-AIIMS-DEL")
        authenticated = Site.authenticate_bearer(self.token)
        self.assertIsNotNone(authenticated)
        self.assertEqual(authenticated.lab_code, "IN-AIIMS-DEL")

    def test_pending_queries_addressed_to_the_old_code_are_retargeted(self):
        mine = Query.objects.create(type="isolate_count", target_lab_codes=["INDIA01", "OTHER01"])
        broadcast = Query.objects.create(type="isolate_count", target_lab_codes=[])
        someone_else = Query.objects.create(type="isolate_count", target_lab_codes=["OTHER01"])

        self.rename("IN-AIIMS-DEL")

        mine.refresh_from_db()
        broadcast.refresh_from_db()
        someone_else.refresh_from_db()
        self.assertEqual(mine.target_lab_codes, ["IN-AIIMS-DEL", "OTHER01"])
        self.assertEqual(broadcast.target_lab_codes, [])
        self.assertEqual(someone_else.target_lab_codes, ["OTHER01"])

    def test_results_and_dispatches_follow_the_site(self):
        query = Query.objects.create(type="isolate_count", target_lab_codes=["INDIA01"])
        QueryDispatch.objects.create(query=query, site=self.site, status="pending")
        self.rename("IN-AIIMS-DEL")
        self.site.refresh_from_db()
        self.assertEqual(self.site.dispatches.count(), 1)

    def test_the_audit_trail_is_appended_to_rather_than_rewritten(self):
        PollAuditEntry.objects.create(site=self.site, lab_code="INDIA01", action="poll")
        self.rename("IN-AIIMS-DEL", note="registry was wrong")
        history = PollAuditEntry.objects.filter(site=self.site).order_by("created_at")
        # The earlier row still says what was sent under the name in use at the time.
        self.assertEqual(history.filter(action="poll").first().lab_code, "INDIA01")
        renamed = history.filter(action="site_renamed").first()
        self.assertIsNotNone(renamed)
        self.assertEqual(renamed.lab_code, "INDIA01")
        self.assertIn("IN-AIIMS-DEL", renamed.detail)
        self.assertIn("registrar", renamed.detail)
        self.assertIn("registry was wrong", renamed.detail)

    def test_a_rename_needs_the_old_code_typed_back(self):
        response = self.rename("IN-AIIMS-DEL", confirm="something else")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "confirmation box")
        self.site.refresh_from_db()
        self.assertEqual(self.site.lab_code, "INDIA01")

    def test_renaming_onto_another_registered_code_is_refused(self):
        Site.objects.create(lab_code="TAKEN02", name="Someone else", status="active")
        response = self.rename("taken02")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "already registered")
        self.site.refresh_from_db()
        self.assertEqual(self.site.lab_code, "INDIA01")

    def test_an_empty_or_overlong_code_is_refused(self):
        self.assertContains(self.rename(""), "required")
        self.assertContains(self.rename("X" * 33), "32 characters")
        self.site.refresh_from_db()
        self.assertEqual(self.site.lab_code, "INDIA01")

    def test_a_failed_rename_leaves_the_queries_alone(self):
        query = Query.objects.create(type="isolate_count", target_lab_codes=["INDIA01"])
        Site.objects.create(lab_code="TAKEN03", name="Someone else", status="active")
        self.rename("TAKEN03")
        query.refresh_from_db()
        self.assertEqual(query.target_lab_codes, ["INDIA01"])


@mock.patch.dict(os.environ, {"AMRIT_ENROLMENT_SECRET": SECRET, "AMRIT_ALLOW_UNAUTHENTICATED_ENROLMENT": ""})
class TokenBootstrapTests(RegistryAdminTestCase):
    """Request → approve → collect, and the two credentials that come out of it.

    The installation proves it is the one collecting with a pickup token returned once when it
    asked. The bearer token is minted at collection, so nothing is stored in plaintext waiting
    to be fetched. The site token is minted at approval and never travels this channel at all.
    """

    def register(self, lab_code="NEWLAB01", **extra):
        self.client.logout()
        payload = {"lab_code": lab_code, "name": "Newly asking lab", **extra}
        response = self.client.post(
            reverse("register_site"), payload, content_type="application/json",
            HTTP_X_AMRIT_ENROLMENT_SECRET=SECRET)
        self.client.force_login(self.operator)
        return response

    def collect(self, lab_code, pickup):
        self.client.logout()
        response = self.client.post(
            reverse("fetch_site_token"), {"lab_code": lab_code, "pickup_token": pickup},
            content_type="application/json")
        self.client.force_login(self.operator)
        return response

    def test_registering_returns_a_pickup_token_once(self):
        response = self.register()
        self.assertEqual(response.status_code, 202)
        pickup = response.json()["pickup_token"]
        self.assertTrue(pickup)
        # Only the hash is kept: the value cannot be read back out of the registry.
        enrolment = SiteEnrolmentRequest.objects.get(lab_code="NEWLAB01")
        self.assertNotIn(pickup, enrolment.pickup_token_hash)
        self.assertTrue(enrolment.check_pickup_token(pickup))

    def test_collecting_before_a_decision_says_it_is_waiting(self):
        pickup = self.register().json()["pickup_token"]
        response = self.collect("NEWLAB01", pickup)
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json()["status"], "pending")
        self.assertIsNone(response.json()["new_token"])

    def test_expired_pickup_proof_cannot_collect_after_approval(self):
        pickup = self.register().json()["pickup_token"]
        enrolment = SiteEnrolmentRequest.objects.get(lab_code="NEWLAB01")
        enrolment.pickup_expires_at = timezone.now() - timedelta(seconds=1)
        enrolment.save(update_fields=["pickup_expires_at"])
        self.decide(enrolment, "approve")

        response = self.collect("NEWLAB01", pickup)

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["status"], "expired_token")
        self.assertEqual(Site.objects.get(lab_code="NEWLAB01").auth_token_hash, "")

    def test_collecting_after_approval_yields_a_working_token(self):
        pickup = self.register().json()["pickup_token"]
        self.decide(SiteEnrolmentRequest.objects.get(lab_code="NEWLAB01"), "approve")

        response = self.collect("NEWLAB01", pickup)

        self.assertEqual(response.status_code, 200)
        token = response.json()["new_token"]
        self.assertTrue(token)
        authenticated = Site.authenticate_bearer(token)
        self.assertIsNotNone(authenticated)
        self.assertEqual(authenticated.lab_code, "NEWLAB01")
        # And it tells the laboratory the second factor is coming by another route.
        self.assertTrue(response.json()["site_token_required"])

    def test_a_declined_request_collects_nothing(self):
        pickup = self.register().json()["pickup_token"]
        self.decide(SiteEnrolmentRequest.objects.get(lab_code="NEWLAB01"), "reject")
        response = self.collect("NEWLAB01", pickup)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["status"], "rejected")
        self.assertFalse(Site.objects.filter(lab_code="NEWLAB01").exists())

    def test_collection_is_single_use(self):
        """A replayed pickup must not rotate the token and strand the real installation."""
        pickup = self.register().json()["pickup_token"]
        self.decide(SiteEnrolmentRequest.objects.get(lab_code="NEWLAB01"), "approve")
        first = self.collect("NEWLAB01", pickup).json()["new_token"]

        second = self.collect("NEWLAB01", pickup)

        self.assertEqual(second.status_code, 409)
        self.assertEqual(second.json()["status"], "already_collected")
        # The token handed over the first time still works.
        self.assertIsNotNone(Site.authenticate_bearer(first))

    def test_a_wrong_pickup_token_collects_nothing(self):
        self.register()
        self.decide(SiteEnrolmentRequest.objects.get(lab_code="NEWLAB01"), "approve")
        response = self.collect("NEWLAB01", "not-the-pickup-token")
        self.assertEqual(response.status_code, 403)
        self.assertIsNone(response.json()["new_token"])

    def test_knowing_only_the_lab_code_collects_nothing(self):
        """The old endpoint minted a token for any active site on the lab code alone."""
        self.register()
        self.decide(SiteEnrolmentRequest.objects.get(lab_code="NEWLAB01"), "approve")
        self.client.logout()
        response = self.client.post(
            reverse("fetch_site_token"), {"lab_code": "NEWLAB01"}, content_type="application/json")
        # No pickup token and no enrolment secret: refused, and no credential minted.
        self.assertIn(response.status_code, (401, 403))
        self.assertEqual(Site.objects.get(lab_code="NEWLAB01").auth_token_hash, "")

    def test_re_registering_invalidates_the_previous_pickup_token(self):
        first = self.register().json()["pickup_token"]
        second = self.register().json()["pickup_token"]
        self.assertNotEqual(first, second)
        self.decide(SiteEnrolmentRequest.objects.get(lab_code="NEWLAB01"), "approve")
        self.assertEqual(self.collect("NEWLAB01", first).status_code, 403)
        self.assertEqual(self.collect("NEWLAB01", second).status_code, 200)

    def test_approval_issues_a_site_token_and_shows_it_once(self):
        self.register()
        response = self.decide(SiteEnrolmentRequest.objects.get(lab_code="NEWLAB01"), "approve")
        site = Site.objects.get(lab_code="NEWLAB01")
        self.assertTrue(site.site_token_hash)

        shown = self.client.get(response["Location"])
        self.assertEqual(shown.status_code, 200)
        site_token = shown.context["new_site_token"]
        self.assertTrue(site_token)
        self.assertTrue(site.check_site_token(site_token))
        self.assertContains(shown, "send it to the site administrator")
        # Once. A second visit must not reprint a credential.
        self.assertIsNone(self.client.get(response["Location"]).context["new_site_token"])

    def test_approval_does_not_mint_the_bearer_token(self):
        """It is minted at collection, so no plaintext credential waits at rest."""
        self.register()
        self.decide(SiteEnrolmentRequest.objects.get(lab_code="NEWLAB01"), "approve")
        self.assertEqual(Site.objects.get(lab_code="NEWLAB01").auth_token_hash, "")


class SecondFactorTests(TestCase):
    """A site that has a site token must present it on every request."""

    def setUp(self):
        self.client = Client()
        self.site = Site.objects.create(lab_code="TWOFAC01", name="Two factor", status="active")
        self.token = Site.issue_token()
        self.site.set_auth_token(self.token)
        self.site_token = Site.issue_token(24)
        self.site.set_site_token(self.site_token)
        self.site.save()

    def poll(self, **headers):
        return self.client.get(reverse("amrit-poll"), {"lab_code": "TWOFAC01", "wait": "0"},
                               HTTP_AUTHORIZATION=f"Bearer {self.token}", **headers)

    def test_the_bearer_token_alone_is_not_enough(self):
        """This is the hole: the old check ran only when the client sent the header at all."""
        self.assertEqual(self.poll().status_code, 401)

    def test_the_right_site_token_is_accepted(self):
        self.assertEqual(self.poll(HTTP_X_AMRIT_SITE=self.site_token).status_code, 204)

    def test_a_wrong_site_token_is_refused(self):
        self.assertEqual(self.poll(HTTP_X_AMRIT_SITE="wrong").status_code, 401)

    def test_a_site_without_one_is_not_asked_for_it(self):
        """A deployment that has not adopted the second channel still works."""
        plain = Site.objects.create(lab_code="ONEFAC01", name="One factor", status="active")
        token = Site.issue_token()
        plain.set_auth_token(token)
        plain.save()
        response = self.client.get(reverse("amrit-poll"), {"lab_code": "ONEFAC01", "wait": "0"},
                                   HTTP_AUTHORIZATION=f"Bearer {token}")
        self.assertEqual(response.status_code, 204)

    def test_the_refusal_states_the_remedy_without_saying_which_factor_failed(self):
        """Naming the failing factor would confirm the other one to an unauthenticated caller."""
        missing_site_token = self.poll()
        wrong_site_token = self.poll(HTTP_X_AMRIT_SITE="wrong")
        bad_bearer = self.client.get(reverse("amrit-poll"), {"lab_code": "TWOFAC01", "wait": "0"},
                                     HTTP_AUTHORIZATION="Bearer not-a-real-token")

        bodies = [response.json() for response in (missing_site_token, wrong_site_token, bad_bearer)]
        for body in bodies:
            self.assertEqual(body["error"], "unauthorized")
            self.assertIn("Request access", body["detail"])
            self.assertIn("site token", body["detail"])
        # Byte-for-byte identical: no oracle for which credential was accepted.
        self.assertEqual(len({body["detail"] for body in bodies}), 1)

    def test_the_site_token_is_not_readable_from_the_registry(self):
        self.assertFalse(hasattr(self.site, "site_token"))
        self.assertNotIn(self.site_token, self.site.site_token_hash)


class TokenResetTests(RegistryAdminTestCase):
    """Superadmin resets either credential independently, and each is shown once."""

    def setUp(self):
        super().setUp()
        self.site = Site.objects.create(lab_code="RESET01", name="Resettable", status="active")
        self.bearer = Site.issue_token()
        self.site.set_auth_token(self.bearer)
        self.original_site_token = Site.issue_token(24)
        self.site.set_site_token(self.original_site_token)
        self.site.save()

    def test_resetting_the_bearer_token_invalidates_the_old_one(self):
        response = self.client.post(reverse("dashboard_site_token", args=["RESET01"]), {"reset": "auth"})
        self.assertEqual(response.status_code, 200)
        issued = response.context["new_token"]
        self.assertTrue(issued)
        self.assertIsNone(Site.authenticate_bearer(self.bearer))
        self.assertIsNotNone(Site.authenticate_bearer(issued))
        # The site token is untouched by a bearer reset: they fail independently.
        self.assertTrue(Site.objects.get(lab_code="RESET01").check_site_token(self.original_site_token))

    def test_resetting_the_site_token_invalidates_the_old_one(self):
        response = self.client.post(reverse("dashboard_site_token", args=["RESET01"]), {"reset": "site"})
        issued = response.context["new_site_token"]
        self.assertTrue(issued)
        site = Site.objects.get(lab_code="RESET01")
        self.assertTrue(site.check_site_token(issued))
        self.assertFalse(site.check_site_token(self.original_site_token))
        # And the bearer token still authenticates.
        self.assertIsNotNone(Site.authenticate_bearer(self.bearer))

    def test_each_reset_is_written_to_the_audit_trail(self):
        self.client.post(reverse("dashboard_site_token", args=["RESET01"]), {"reset": "auth"})
        self.client.post(reverse("dashboard_site_token", args=["RESET01"]), {"reset": "site"})
        actions = set(PollAuditEntry.objects.filter(site=self.site).values_list("action", flat=True))
        self.assertEqual(actions, {"auth_token_reset", "site_token_reset"})

    def test_an_operator_without_manage_sites_cannot_reset_anything(self):
        RoleDefinition.objects.update_or_create(
            slug="nobody", defaults={"label": "Nobody", "scope_kind": "none",
                                     "capabilities": ["view_dashboard"], "is_active": True})
        nobody = get_user_model().objects.create_user(username="nobody", password="test-pass")
        UserProfile.objects.create(user=nobody, role="nobody")
        self.client.force_login(nobody)
        self.client.post(reverse("dashboard_site_token", args=["RESET01"]), {"reset": "auth"})
        self.assertIsNotNone(Site.authenticate_bearer(self.bearer))


class MismatchResponseTests(TestCase):
    """What a laboratory is told when its code and the registry's disagree."""

    def setUp(self):
        self.client = Client()
        self.site = Site.objects.create(lab_code="INDIA01", name="AIIMS Delhi", status="active")
        self.token = Site.issue_token()
        self.site.set_auth_token(self.token)
        self.site.save()

    def test_the_refusal_names_the_registered_code_and_the_remedy(self):
        response = self.client.get(
            reverse("amrit-poll"), {"lab_code": "IN-AIIMS-DEL", "wait": "0"},
            HTTP_AUTHORIZATION=f"Bearer {self.token}")
        self.assertEqual(response.status_code, 403)
        body = response.json()
        self.assertEqual(body["error"], "lab_code mismatch")
        self.assertEqual(body["registered_lab_code"], "INDIA01")
        self.assertEqual(body["sent_lab_code"], "IN-AIIMS-DEL")
        # Both ways out are stated, because which one is right is not the server's call.
        self.assertIn("INDIA01", body["detail"])
        self.assertIn("IN-AIIMS-DEL", body["detail"])
        self.assertIn("rename", body["detail"])

    def test_the_mismatch_is_audited_under_the_code_that_was_sent(self):
        self.client.get(
            reverse("amrit-poll"), {"lab_code": "IN-AIIMS-DEL", "wait": "0"},
            HTTP_AUTHORIZATION=f"Bearer {self.token}")
        entry = PollAuditEntry.objects.get(action="lab_code_mismatch")
        self.assertEqual(entry.lab_code, "IN-AIIMS-DEL")
        self.assertIn("INDIA01", entry.error)

    def test_the_matching_code_is_not_a_mismatch(self):
        response = self.client.get(
            reverse("amrit-poll"), {"lab_code": "INDIA01", "wait": "0"},
            HTTP_AUTHORIZATION=f"Bearer {self.token}")
        self.assertEqual(response.status_code, 204)

    def test_after_the_rename_the_desktop_polls_clean(self):
        """End to end: the mismatch that started this, and the state after the fix."""
        self.site.rename_lab_code("IN-AIIMS-DEL", by="registrar")
        response = self.client.get(
            reverse("amrit-poll"), {"lab_code": "IN-AIIMS-DEL", "wait": "0"},
            HTTP_AUTHORIZATION=f"Bearer {self.token}")
        self.assertEqual(response.status_code, 204)
