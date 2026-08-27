"""Clearing settled registration paperwork, and refusing to clear anything else.

The requests queue accumulated every laboratory that had ever asked to join, including the
ones approved months ago whose desktops have long since collected their tokens. The pending
ones an administrator actually has to decide on were buried among them.

What must not happen is a "clear" that quietly drops an application nobody has decided, or
that takes a site down with its paperwork.
"""

from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from queries.models import PollAuditEntry
from sites.models import Site, SiteEnrolmentRequest


class SiteRequestsClearTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_superuser("registrar", "registrar@example.org", "pw-not-real")
        self.client.force_login(self.user)
        self.site = Site.objects.create(lab_code="LAB-APPROVED", name="Approved laboratory", status="active")
        self.collected = SiteEnrolmentRequest.objects.create(
            lab_code="LAB-APPROVED", status="approved", site=self.site,
            pickup_redeemed_at=timezone.now(),
        )
        self.approved_not_collected = SiteEnrolmentRequest.objects.create(
            lab_code="LAB-WAITING", status="approved", site=self.site,
        )
        self.rejected = SiteEnrolmentRequest.objects.create(lab_code="LAB-DECLINED", status="rejected")
        self.pending = SiteEnrolmentRequest.objects.create(lab_code="LAB-PENDING", status="pending")

    def test_clearing_collected_leaves_everything_else(self):
        response = self.client.post(reverse("dashboard_site_requests_clear"), {"scope": "collected"})
        self.assertEqual(response.status_code, 302)
        remaining = set(SiteEnrolmentRequest.objects.values_list("lab_code", flat=True))
        self.assertEqual(remaining, {"LAB-WAITING", "LAB-DECLINED", "LAB-PENDING"})
        # The registry itself is untouched: this is paperwork, not the site.
        self.assertTrue(Site.objects.filter(lab_code="LAB-APPROVED").exists())

    def test_clearing_settled_keeps_the_pending_one(self):
        self.client.post(reverse("dashboard_site_requests_clear"), {"scope": "settled"})
        remaining = list(SiteEnrolmentRequest.objects.values_list("lab_code", flat=True))
        self.assertEqual(remaining, ["LAB-PENDING"])

    def test_a_clear_is_written_to_the_audit_trail(self):
        self.client.post(reverse("dashboard_site_requests_clear"), {"scope": "collected"})
        entry = PollAuditEntry.objects.filter(action="enrolment_requests_cleared").first()
        self.assertIsNotNone(entry)
        self.assertIn("LAB-APPROVED", entry.detail)
        self.assertIn("registrar", entry.detail)

    def test_an_unknown_scope_changes_nothing(self):
        self.client.post(reverse("dashboard_site_requests_clear"), {"scope": "everything"})
        self.assertEqual(SiteEnrolmentRequest.objects.count(), 4)

    def test_a_get_cannot_clear(self):
        response = self.client.get(reverse("dashboard_site_requests_clear"))
        self.assertEqual(response.status_code, 405)
        self.assertEqual(SiteEnrolmentRequest.objects.count(), 4)

    def test_the_queue_page_offers_the_buttons_with_counts(self):
        response = self.client.get(reverse("dashboard_site_requests") + "?status=")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Clear collected (1)")
        self.assertContains(response, "Clear all settled (3)")
