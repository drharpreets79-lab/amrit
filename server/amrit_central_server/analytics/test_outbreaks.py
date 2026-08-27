from datetime import date, timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase

from queries.models import Query, QueryResult
from queries.pii_guard import assert_aggregate_only
from sites.models import Site

from .outbreak_detection import CaseEvent, ScanSettings, scan


class OutbreakEngineTests(TestCase):
    def test_injected_prospective_cluster_is_detected(self):
        start = date(2025, 1, 1)
        events = []
        for day in range(120):
            when = start + timedelta(days=day)
            events.extend([
                CaseEvent(when, ["A", "B", "ICU"][day % 3], "organism", "ORG:ECO", "Escherichia coli"),
                CaseEvent(when, ["B", "A", "ICU"][day % 3], "organism", "ORG:KPN", "Klebsiella pneumoniae"),
            ])
        for day in range(115, 120):
            events.append(CaseEvent(start + timedelta(days=day), "ICU", "organism", "ORG:KPN", "Klebsiella pneumoniae", count=5))
        result = scan(events, ScanSettings(
            baseline_days=120, max_cluster_days=14, permutations=99,
            recurrence_threshold_days=50,
        ))
        self.assertTrue(any(
            signal["organism"] == "Klebsiella pneumoniae"
            and signal["location"] == "ICU" and signal["status"] == "alert"
            for signal in result["signals"]
        ))

    def test_portal_wire_shape_passes_server_pii_guard(self):
        assert_aggregate_only({
            "schema_version": 1,
            "rows": [{
                "date": "2025-01-01", "signal_type": "resistance",
                "signal_code": "R:KPN:MEM", "organism_code": "KPN",
                "organism": "Klebsiella pneumoniae", "antibiotic_code": "MEM", "count": 3,
            }],
        })


class OutbreakPortalTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_superuser("epi", "epi@example.test", "password")
        self.site_a = Site.objects.create(lab_code="LAB-A", name="Lab A", status="active")
        self.site_b = Site.objects.create(lab_code="LAB-B", name="Lab B", status="active")
        self.client.force_login(self.user)

    def test_page_is_authenticated_and_dispatches_aggregate_query(self):
        response = self.client.get("/dashboard/outbreaks/")
        self.assertEqual(response.status_code, 200)
        response = self.client.post("/dashboard/outbreaks/", {
            "period_start": "2025-01-01", "period_end": "2025-12-31", "deduplication_days": "30",
        })
        self.assertEqual(response.status_code, 302)
        query = Query.objects.get(type="cluster_scan")
        self.assertEqual(query.dispatches.count(), 2)
        self.assertEqual(query.filters["deduplication_days"], 30)

    def test_portal_scans_aggregate_rows_without_patient_data(self):
        query = Query.objects.create(type="cluster_scan", title="test", target_lab_codes=["LAB-A", "LAB-B"])
        start = date(2025, 1, 1)
        for site in (self.site_a, self.site_b):
            rows = []
            for day in range(70):
                rows.extend([
                    {"date": (start + timedelta(days=day)).isoformat(), "signal_type": "organism", "signal_code": "ORG:ECO", "organism_code": "ECO", "organism": "Escherichia coli", "antibiotic_code": "", "count": 1},
                    {"date": (start + timedelta(days=day)).isoformat(), "signal_type": "organism", "signal_code": "ORG:KPN", "organism_code": "KPN", "organism": "Klebsiella pneumoniae", "antibiotic_code": "", "count": 1},
                ])
            QueryResult.objects.create(query=query, site=site, ok=True, result_json={"rows": rows})
        response = self.client.get("/dashboard/outbreaks/", {"query": query.pk, "permutations": 19})
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Kulldorff space-time permutation")
        self.assertNotContains(response, "patient_id")
