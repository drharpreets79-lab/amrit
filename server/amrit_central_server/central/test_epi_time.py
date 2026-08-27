"""Phase 9 gate: the server's epi-time must agree with the desktop app's, date for date.

A federated count bucketed by one product and read by the other has to land in the same
week, so these assertions mirror app/tests/epi-time.test.ts.
"""

from __future__ import annotations

import os
from datetime import date, datetime, timedelta
from unittest import mock

from django.test import SimpleTestCase

from central import country_profile as cp
from central.epi_time import epi_week, local_date, reporting_year, resolve_time_zone


class IsoWeekTests(SimpleTestCase):
    def test_4_january_is_always_in_week_1(self):
        for year in range(2021, 2027):
            self.assertEqual(epi_week(date(year, 1, 4), "iso").week, 1)

    def test_runs_monday_to_sunday(self):
        week = epi_week("2026-03-04", "iso")  # a Wednesday
        self.assertEqual(week.start, date(2026, 3, 2))
        self.assertEqual(week.end, date(2026, 3, 8))
        self.assertEqual(week.start.weekday(), 0)

    def test_late_december_can_belong_to_the_next_iso_year(self):
        week = epi_week("2019-12-30", "iso")
        self.assertEqual((week.year, week.week), (2020, 1))

    def test_reports_a_53_week_year(self):
        week = epi_week("2020-12-31", "iso")
        self.assertEqual((week.year, week.week), (2020, 53))


class MmwrWeekTests(SimpleTestCase):
    def test_runs_sunday_to_saturday(self):
        week = epi_week("2026-03-04", "mmwr")
        self.assertEqual(week.start, date(2026, 3, 1))
        self.assertEqual(week.end, date(2026, 3, 7))
        self.assertEqual(week.start.weekday(), 6)

    def test_week_1_matches_the_published_calendar(self):
        self.assertEqual((epi_week("2026-01-04", "mmwr").year, epi_week("2026-01-04", "mmwr").week), (2026, 1))
        self.assertEqual((epi_week("2021-01-03", "mmwr").year, epi_week("2021-01-03", "mmwr").week), (2021, 1))


class SystemsDisagreeTests(SimpleTestCase):
    def test_the_same_date_buckets_differently(self):
        iso = epi_week("2026-03-01", "iso")
        mmwr = epi_week("2026-03-01", "mmwr")
        self.assertNotEqual(iso.start, mmwr.start)
        self.assertNotEqual(iso.end, mmwr.end)

    def test_some_dates_differ_in_week_number_too(self):
        disagreements = []
        cursor = date(2019, 1, 1)
        while cursor <= date(2026, 12, 31):
            iso = epi_week(cursor, "iso")
            mmwr = epi_week(cursor, "mmwr")
            if (iso.year, iso.week) != (mmwr.year, mmwr.week):
                disagreements.append(cursor)
            cursor += timedelta(days=1)
        self.assertGreater(len(disagreements), 0)


class ReportingYearTests(SimpleTestCase):
    def test_january_start_is_the_calendar_year(self):
        result = reporting_year("2026-03-04", 1)
        self.assertEqual((result.year, result.label), (2026, "2026"))
        self.assertEqual((result.start, result.end), (date(2026, 1, 1), date(2026, 12, 31)))

    def test_india_runs_april_to_march(self):
        self.assertEqual(reporting_year("2026-03-31", 4).label, "2025-26")
        self.assertEqual(reporting_year("2026-04-01", 4).label, "2026-27")
        self.assertEqual(reporting_year("2026-04-01", 4).end, date(2027, 3, 31))

    def test_a_us_federal_year_runs_october_to_september(self):
        self.assertEqual(reporting_year("2026-09-30", 10).label, "2025-26")
        self.assertEqual(reporting_year("2026-10-01", 10).label, "2026-27")

    def test_it_comes_from_the_profile_when_not_given(self):
        cp.clear_cache()
        with mock.patch.dict(os.environ, {"AMRIT_COUNTRY_PROFILE": "IN"}):
            cp.clear_cache()
            self.assertEqual(reporting_year("2026-03-31").label, "2025-26")
        with mock.patch.dict(os.environ, {"AMRIT_COUNTRY_PROFILE": "TESTLAND"}):
            cp.clear_cache()
            self.assertEqual(reporting_year("2026-09-30").label, "2025-26")
        cp.clear_cache()


class LocalDateTests(SimpleTestCase):
    def test_a_late_evening_observation_keeps_its_local_day(self):
        self.assertEqual(local_date("2026-03-04T18:00:00+00:00", "Asia/Kolkata"), date(2026, 3, 4))
        self.assertEqual(local_date("2026-03-04T18:30:00+00:00", "Asia/Kolkata"), date(2026, 3, 5))
        self.assertEqual(local_date("2026-03-04T23:30:00+05:30", "Asia/Kolkata"), date(2026, 3, 4))

    def test_the_same_instant_is_a_different_day_in_different_zones(self):
        instant = "2026-03-05T02:00:00+00:00"
        self.assertEqual(local_date(instant, "Pacific/Auckland"), date(2026, 3, 5))
        self.assertEqual(local_date(instant, "America/Los_Angeles"), date(2026, 3, 4))

    def test_an_unknown_zone_falls_back_rather_than_losing_the_observation(self):
        self.assertEqual(local_date("2026-03-04T18:30:00+00:00", "Not/AZone"), date(2026, 3, 4))
        self.assertEqual(local_date(datetime(2026, 3, 4, 18, 30), None), date(2026, 3, 4))


class TimeZoneResolutionTests(SimpleTestCase):
    def tearDown(self):
        cp.clear_cache()

    def test_the_sites_own_zone_wins(self):
        with mock.patch.dict(os.environ, {"AMRIT_COUNTRY_PROFILE": "IN"}):
            cp.clear_cache()
            self.assertEqual(resolve_time_zone("America/New_York"), "America/New_York")

    def test_the_country_default_applies_when_the_site_has_none(self):
        with mock.patch.dict(os.environ, {"AMRIT_COUNTRY_PROFILE": "IN"}):
            cp.clear_cache()
            self.assertEqual(resolve_time_zone(""), "Asia/Kolkata")

    def test_a_multi_zone_country_returns_none_rather_than_guessing(self):
        with mock.patch.dict(os.environ, {"AMRIT_COUNTRY_PROFILE": "USA"}):
            cp.clear_cache()
            # The United States spans 29 zones, so there is no honest country default.
            self.assertIsNone(resolve_time_zone(None))


class CrossProductAgreementTests(SimpleTestCase):
    """The values app/tests/epi-time.test.ts asserts, repeated here.

    If these two lists ever diverge, a count bucketed on the desktop and read on the server
    lands in a different week.
    """

    def test_matching_fixtures(self):
        cases = [
            ("2026-03-04", "iso", 2026, date(2026, 3, 2), date(2026, 3, 8)),
            ("2026-03-04", "mmwr", 2026, date(2026, 3, 1), date(2026, 3, 7)),
            ("2019-12-30", "iso", 2020, date(2019, 12, 30), date(2020, 1, 5)),
            ("2020-12-31", "iso", 2020, date(2020, 12, 28), date(2021, 1, 3)),
        ]
        for value, system, year, start, end in cases:
            with self.subTest(value=value, system=system):
                week = epi_week(value, system)
                self.assertEqual(week.year, year)
                self.assertEqual(week.start, start)
                self.assertEqual(week.end, end)
