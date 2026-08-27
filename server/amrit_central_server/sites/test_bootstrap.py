"""Phase 11 gate: a fresh installation reaches a working state without inventing secrets."""

from __future__ import annotations

import os
from io import StringIO
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.management import CommandError, call_command
from django.test import TestCase

from central import country_profile as cp
from geo.models import AdminUnit, CountryConfig

User = get_user_model()


class BootstrapTests(TestCase):
    def setUp(self):
        cp.clear_cache()

    def tearDown(self):
        cp.clear_cache()

    def _run(self, *args) -> str:
        output = StringIO()
        call_command("bootstrap", *args, stdout=output)
        return output.getvalue()

    def test_a_country_with_a_bundled_pack_gets_its_geography(self):
        report = self._run("--country", "IN")
        self.assertIn("India (IND)", report)
        self.assertIn("loaded 821 unit(s)", report)
        self.assertEqual(AdminUnit.objects.for_country("IND").count(), 821)
        self.assertTrue(CountryConfig.objects.filter(country_code="IND").exists())

    def test_a_country_with_no_curated_pack_still_gets_its_iso_subdivisions(self):
        """No country starts with an empty tree any more: ISO 3166-2 covers 200 of them."""
        report = self._run("--country", "NGA")
        self.assertIn("Nigeria (NGA)", report)
        self.assertIn("loaded 37 unit(s)", report)
        units = AdminUnit.objects.for_country("NGA")
        self.assertEqual(units.count(), 37)
        # The level is named after the subdivision type ISO records, not a placeholder.
        self.assertEqual(units.first().code_system, "ISO3166-2")
        self.assertTrue(CountryConfig.objects.filter(country_code="NGA").exists())

    def test_a_country_ISO_gives_no_subdivisions_reports_and_names_the_import_command(self):
        """Fifty territories have none in the standard; a message beats a silent empty tree."""
        report = self._run("--country", "BMU")  # Bermuda: no ISO 3166-2 subdivisions
        self.assertIn("no bundled pack", report)
        self.assertIn("import_admin_units", report)
        self.assertEqual(AdminUnit.objects.for_country("BMU").count(), 0)
        self.assertTrue(CountryConfig.objects.filter(country_code="BMU").exists())

    def test_it_is_idempotent(self):
        self._run("--country", "IN")
        report = self._run("--country", "IN")
        self.assertIn("already present", report)
        self.assertIn("already loaded", report)
        self.assertEqual(AdminUnit.objects.for_country("IND").count(), 821)

    def test_it_warns_when_a_country_spans_several_time_zones(self):
        report = self._run("--country", "USA")
        self.assertIn("several time zones", report)

    def test_no_administrator_is_created_without_a_password(self):
        """Refusing beats inventing: a default password is an open door."""
        report = self._run("--country", "IN", "--admin-username", "admin")
        self.assertIn("not created", report)
        self.assertFalse(User.objects.filter(username="admin").exists())

    def test_a_short_password_is_refused(self):
        with self.assertRaisesMessage(CommandError, "at least 12 characters"):
            self._run("--country", "IN", "--admin-username", "admin", "--admin-password", "short")
        self.assertFalse(User.objects.filter(username="admin").exists())

    def test_an_administrator_is_created_when_a_password_is_supplied(self):
        self._run("--country", "IN", "--admin-username", "admin", "--admin-password", "a-long-enough-password")
        user = User.objects.get(username="admin")
        self.assertTrue(user.is_superuser)
        # The password is hashed, never stored as given.
        self.assertNotEqual(user.password, "a-long-enough-password")

    def test_it_reports_that_enrolment_is_closed_when_no_secret_is_set(self):
        with mock.patch.dict(os.environ, {"AMRIT_ENROLMENT_SECRET": "", "AMRIT_ALLOW_UNAUTHENTICATED_ENROLMENT": ""}):
            report = self._run("--country", "IN")
        self.assertIn("no secret configured", report)

    def test_it_calls_out_an_unauthenticated_enrolment_configuration(self):
        with mock.patch.dict(os.environ, {"AMRIT_ENROLMENT_SECRET": "", "AMRIT_ALLOW_UNAUTHENTICATED_ENROLMENT": "1"}):
            report = self._run("--country", "IN")
        self.assertIn("UNAUTHENTICATED", report)

    def test_an_unknown_country_is_refused(self):
        with self.assertRaises(CommandError):
            self._run("--country", "NOT-A-COUNTRY")


class SqliteUrlTests(TestCase):
    """The sqlite path used to be discarded, so every URL resolved to BASE_DIR/db.sqlite3.

    A deployment pointing elsewhere silently shared the default database, and so did any
    test that thought it had a fresh one.
    """

    def test_the_path_in_a_sqlite_url_is_honoured(self):
        from central.settings import BASE_DIR, _database_from_url

        absolute = _database_from_url("sqlite:////tmp/amrit-example.db")
        self.assertEqual(absolute["NAME"], "/tmp/amrit-example.db")

        relative = _database_from_url("sqlite:///./local.db")
        self.assertEqual(relative["NAME"], str(BASE_DIR / "local.db"))

        default = _database_from_url("sqlite://")
        self.assertEqual(str(default["NAME"]), str(BASE_DIR / "db.sqlite3"))

    def test_a_postgres_url_is_unaffected(self):
        from central.settings import _database_from_url

        config = _database_from_url("postgres://user:pw@localhost:5432/amrit")
        self.assertEqual(config["ENGINE"], "django.db.backends.postgresql")
        self.assertEqual(config["NAME"], "amrit")
        self.assertEqual(config["HOST"], "localhost")
