"""Phase 12: retention and disclosure control on the server.

The dangerous failure is not "kept too long". It is a purge that deletes current data, or a
disclosure floor that a settings edit quietly lowers to one. Both directions are pinned here.
"""

from __future__ import annotations

import os
from datetime import timedelta
from io import StringIO
from unittest import mock

from django.core.management import call_command
from django.test import TestCase, override_settings
from django.utils import timezone

from central import country_profile as cp
from central.privacy import DEFAULT_K_ANONYMITY_FLOOR, k_anonymity_floor, residency_note, retention_days
from central.retention import cutoff_for, purge_expired
from geo.models import CountryConfig
from queries.models import PollAuditEntry, Query


def _profile_with(privacy: dict) -> dict:
    profile = dict(cp.get_profile("IND"))
    profile["privacy"] = privacy
    return profile


class DisclosureFloorTests(TestCase):
    def setUp(self):
        # Profile-resolution tests must not inherit an operator override from the shell or
        # docker-compose environment. The dedicated override test below sets its own value.
        self.environment = mock.patch.dict(os.environ, {"AMRIT_K_ANONYMITY_FLOOR": ""})
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        cp.clear_cache()

    def test_an_unset_profile_value_keeps_the_built_in_floor(self):
        with mock.patch.object(cp, "get_profile", return_value=_profile_with({})):
            self.assertEqual(k_anonymity_floor(), DEFAULT_K_ANONYMITY_FLOOR)

    def test_a_profile_may_make_disclosure_stricter(self):
        with mock.patch.object(cp, "get_profile", return_value=_profile_with({"k_anonymity_floor": 20})):
            self.assertEqual(k_anonymity_floor(), 20)

    def test_a_profile_can_never_make_disclosure_weaker(self):
        # A mistake on the settings screen must not publish a cell of one.
        for attempted in (1, 0, -5, "nonsense", None):
            with self.subTest(value=attempted):
                with mock.patch.object(cp, "get_profile", return_value=_profile_with({"k_anonymity_floor": attempted})):
                    self.assertGreaterEqual(k_anonymity_floor(), DEFAULT_K_ANONYMITY_FLOOR)

    @override_settings(AMRIT_K_ANONYMITY_FLOOR=30)
    def test_an_operator_set_environment_value_wins_over_the_profile(self):
        with mock.patch.dict(os.environ, {"AMRIT_K_ANONYMITY_FLOOR": "30"}):
            with mock.patch.object(cp, "get_profile", return_value=_profile_with({"k_anonymity_floor": 6})):
                self.assertEqual(k_anonymity_floor(), 30)

    def test_an_unreadable_profile_does_not_remove_the_control(self):
        with mock.patch.object(cp, "get_profile", side_effect=cp.ProfileError("no profile")):
            self.assertGreaterEqual(k_anonymity_floor(), DEFAULT_K_ANONYMITY_FLOOR)


class RetentionPeriodTests(TestCase):
    def tearDown(self):
        cp.clear_cache()

    def test_unset_means_keep_indefinitely(self):
        with mock.patch.object(cp, "get_profile", return_value=_profile_with({})):
            self.assertIsNone(retention_days())
        self.assertIsNone(cutoff_for(None))

    def test_a_nonsense_period_is_treated_as_unset_rather_than_as_zero(self):
        # Reading a bad value as "expire everything" is unrecoverable; reading it as
        # "keep" is not.
        for attempted in ("soon", 0, -30, ""):
            with self.subTest(value=attempted):
                with mock.patch.object(cp, "get_profile", return_value=_profile_with({"retention_days": attempted})):
                    self.assertIsNone(retention_days())

    def test_a_valid_period_is_read_from_the_profile(self):
        with mock.patch.object(cp, "get_profile", return_value=_profile_with({"retention_days": 90})):
            self.assertEqual(retention_days(), 90)

    def test_residency_note_is_surfaced_when_set(self):
        with mock.patch.object(cp, "get_profile", return_value=_profile_with({"residency_note": "Held in-country."})):
            self.assertEqual(residency_note(), "Held in-country.")


class PurgeTests(TestCase):
    def setUp(self):
        cp.clear_cache()
        CountryConfig.objects.get_or_create(country_code="IND", defaults={"profile_id": "IN"})
        self.now = timezone.now()
        self.old = PollAuditEntry.objects.create(lab_code="LAB1", action="poll")
        self.recent = PollAuditEntry.objects.create(lab_code="LAB1", action="poll")
        # created_at is auto_now_add, so age is set after the fact.
        PollAuditEntry.objects.filter(pk=self.old.pk).update(created_at=self.now - timedelta(days=400))
        PollAuditEntry.objects.filter(pk=self.recent.pk).update(created_at=self.now - timedelta(days=2))

    def tearDown(self):
        cp.clear_cache()

    def test_no_retention_period_purges_nothing(self):
        with mock.patch.object(cp, "get_profile", return_value=_profile_with({})):
            result = purge_expired(dry_run=False)
        self.assertEqual(result["applied"], False)
        self.assertEqual(PollAuditEntry.objects.count(), 2)

    def test_a_dry_run_reports_without_deleting(self):
        result = purge_expired(days=365, dry_run=True)
        rows = {entry["label"]: entry["rows"] for entry in result["removed"]}
        self.assertEqual(rows["Poll audit entries"], 1)
        self.assertEqual(PollAuditEntry.objects.count(), 2)

    def test_applying_removes_expired_rows_and_keeps_current_ones(self):
        purge_expired(days=365, dry_run=False)
        remaining = list(PollAuditEntry.objects.values_list("pk", flat=True))
        self.assertEqual(remaining, [self.recent.pk])

    def test_aggregates_are_never_purged(self):
        # KPISnapshot is the surveillance record this system exists to produce.
        labels = {entry["label"] for entry in purge_expired(days=1, dry_run=True)["removed"]}
        self.assertNotIn("KPI snapshots", labels)

    def test_the_command_previews_unless_apply_is_given(self):
        Query.objects.all().delete()
        out = StringIO()
        call_command("purge_expired", "--days", "365", stdout=out)
        self.assertIn("Preview only", out.getvalue())
        self.assertEqual(PollAuditEntry.objects.count(), 2)

        out = StringIO()
        call_command("purge_expired", "--days", "365", "--apply", stdout=out)
        self.assertIn("rows deleted", out.getvalue())
        self.assertEqual(PollAuditEntry.objects.count(), 1)

    def test_the_command_says_so_when_nothing_is_configured(self):
        with mock.patch.object(cp, "get_profile", return_value=_profile_with({})):
            out = StringIO()
            call_command("purge_expired", stdout=out)
        self.assertIn("No retention period is configured", out.getvalue())
        self.assertEqual(PollAuditEntry.objects.count(), 2)
