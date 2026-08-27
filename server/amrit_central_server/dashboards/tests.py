from datetime import timedelta
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone

from metrics import registry
from metrics.compute import compute_metric
from queries.models import Query, QueryResult
from sites.models import Site

from .models import DashboardRefreshRun, KPISnapshot
from .refresh import refresh_scope
from . import refresh as refresh_module


class RefreshBatchIsolationTests(TestCase):
    def setUp(self):
        self.site = Site.objects.create(
            lab_code="TEST-LAB",
            name="Test Lab",
            status="active",
            auth_token_hash="test",
        )

    def _result(self, count):
        query = Query.objects.create(
            type="isolate_count",
            title="batch isolation test",
            target_lab_codes=[self.site.lab_code],
        )
        QueryResult.objects.create(
            query=query,
            site=self.site,
            ok=True,
            result_json={"count": count},
        )
        return query

    def test_newest_result_replaces_older_count_instead_of_accumulating(self):
        self._result(1000)
        self._result(800)

        value = compute_metric(registry.get("burden_isolates"), "national", "")

        self.assertEqual(value["total"], 800)
        self.assertEqual(value["by_site"], {"TEST-LAB": 800})

    def test_successful_batches_keep_timestamped_decreasing_snapshots(self):
        started = timezone.now()
        totals = []
        for offset, count in enumerate((1000, 800)):
            query = self._result(count)
            clicked_at = started + timedelta(seconds=offset)
            run = DashboardRefreshRun.objects.create(
                scope_type="national",
                status="success",
                clicked_at=clicked_at,
                completed_at=clicked_at,
                expected_sites=1,
                responded_sites=1,
                records_represented=count,
                site_lab_codes=[self.site.lab_code],
                query_ids=[str(query.id)],
            )
            refresh_scope(
                "national",
                "",
                metric_keys=["burden_isolates"],
                source="live",
                query_ids=[str(query.id)],
                site_ids=[self.site.id],
                refresh_run=run,
                computed_at=clicked_at,
            )
            snapshot = run.snapshots.get(metric_key="burden_isolates")
            totals.append(snapshot.value_json["total"])
            self.assertEqual(snapshot.computed_at, clicked_at)

        self.assertEqual(totals, [1000, 800])
        self.assertEqual(
            KPISnapshot.latest("burden_isolates", "national", "").value_json["total"],
            800,
        )

    def test_strict_live_snapshot_write_is_atomic(self):
        query = self._result(1000)
        run = DashboardRefreshRun.objects.create(
            scope_type="national",
            status="pending",
            expected_sites=1,
            responded_sites=1,
            query_ids=[str(query.id)],
        )
        original = refresh_module.refresh_metric

        def fail_second(metric, *args, **kwargs):
            if metric.key == "cov_ast_completeness":
                raise RuntimeError("synthetic snapshot failure")
            return original(metric, *args, **kwargs)

        with patch("dashboards.refresh.refresh_metric", side_effect=fail_second):
            with self.assertRaises(RuntimeError):
                refresh_scope(
                    "national",
                    "",
                    metric_keys=["burden_isolates", "cov_ast_completeness"],
                    source="live",
                    query_ids=[str(query.id)],
                    site_ids=[self.site.id],
                    refresh_run=run,
                    strict=True,
                )

        self.assertEqual(run.snapshots.count(), 0)


class DashboardKindTests(TestCase):
    """One administrative dashboard, at whatever level the viewer's unit sits."""

    def setUp(self):
        from django.contrib.auth import get_user_model

        from geo.models import AdminUnit
        from sites.models import RoleDefinition, UserProfile

        self.province = AdminUnit.objects.create(
            id="TUR:1:TR-34", country_code="TUR", level=1, code="TR-34",
            name="İstanbul", admin_path="TUR/TR-34")
        self.district = AdminUnit.objects.create(
            id="TUR:2:TR-34-01", country_code="TUR", level=2, code="TR-34-01", parent=self.province,
            name="Şişli", admin_path="TUR/TR-34/TR-34-01")
        RoleDefinition.objects.update_or_create(
            slug="admin_officer",
            defaults={"label": "Administrative officer", "scope_kind": "admin", "dashboard_kind": "admin",
                      "capabilities": ["view_dashboard", "view_scoped_sites", "view_basic_dashboard"],
                      "is_active": True},
        )
        self.user = get_user_model().objects.create_user(username="officer", password="test-pass")
        self.profile = UserProfile.objects.create(user=self.user, role="admin_officer", admin_unit=self.province)
        self.client.force_login(self.user)

    def test_the_scope_level_comes_from_the_viewers_unit(self):
        response = self.client.get("/dashboard/roles/admin/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.context["scope_type"], "admin:1")
        self.assertEqual(response.context["scope_value"], "TR-34")

        self.profile.admin_unit = self.district
        self.profile.save(update_fields=["admin_unit"])
        response = self.client.get("/dashboard/roles/admin/")
        self.assertEqual(response.context["scope_type"], "admin:2")
        self.assertEqual(response.context["scope_value"], "TR-34-01")

    def test_an_officer_with_no_unit_is_told_rather_than_shown_the_country(self):
        self.profile.admin_unit = None
        self.profile.save(update_fields=["admin_unit"])
        response = self.client.get("/dashboard/roles/admin/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("administrative unit", response.context["blocked"])
        self.assertEqual(response.context["scope_value"], "")

    def test_withdrawn_dashboard_names_redirect_rather_than_404(self):
        """A bookmark to /dashboard/roles/state/ must still land somewhere."""
        for old, new in (("state", "admin"), ("district", "admin"), ("national", "country")):
            with self.subTest(kind=old):
                response = self.client.get(f"/dashboard/roles/{old}/")
                self.assertRedirects(response, f"/dashboard/roles/{new}/", target_status_code=200 if new == "admin" else 403)
