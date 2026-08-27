from datetime import timedelta
from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient
from sites.models import Site
from .models import DataProduct, Organization, ProgrammeMilestone
from .risk import calculate_risk


class EcosystemTests(TestCase):
    def setUp(self):
        self.token = Site.issue_token()
        self.site = Site(lab_code="TEST-001", name="Test laboratory", country="India", auth_token_hash="")
        self.site.set_auth_token(self.token); self.site.save()
        self.client = APIClient(); self.url = reverse("ecosystem_ingest")

    def post(self, payload):
        return self.client.post(self.url, payload, format="json", HTTP_AUTHORIZATION="Bearer " + self.token)

    def test_aggregate_product_ingest_is_idempotent(self):
        body = {"sector": "environment", "module": "environment", "payload": {
            "contract": "national-amr-data-product/1.0", "module": "environment", "record_count": 12,
            "metrics": {"samples": 12, "gene_positive": 2}, "quality": {"status": "provisional"}}}
        first = self.post(body); second = self.post(body)
        self.assertEqual(201, first.status_code); self.assertEqual(200, second.status_code)
        self.assertTrue(first.json()["created"]); self.assertFalse(second.json()["created"])
        self.assertEqual(1, DataProduct.objects.count())

    def test_ingest_rejects_direct_identifiers_and_bad_token(self):
        rejected = self.post({"module": "amc", "payload": {"patient_id": "P-1", "metrics": {"ddd": 2}}})
        self.assertEqual(400, rejected.status_code)
        self.client.credentials(HTTP_AUTHORIZATION="Bearer wrong")
        self.assertEqual(401, self.client.post(self.url, {"module": "amc"}, format="json").status_code)

    def test_programme_milestone_tracks_target_budget_and_evidence(self):
        org = Organization.objects.create(code="NCDC", name="NCDC", organization_type="national")
        milestone = ProgrammeMilestone.objects.create(
            objective_code="SO-3", title="Strengthen integrated surveillance", owner_organization=org,
            period="2026-27", target_json={"states": 10}, actual_json={"states": 3},
            budget_allocated="1000000.00", expenditure="250000.00", evidence_json=[{"url": "https://example.invalid/evidence"}])
        self.assertEqual(3, milestone.actual_json["states"]); self.assertEqual(1, len(milestone.evidence_json))

    def test_api_catalog_requires_user_authentication(self):
        response = self.client.get("/api/v1/ecosystem/products/")
        self.assertIn(response.status_code, (401, 403))
        user = get_user_model().objects.create_user("reviewer", password="test-password-123")
        self.client.force_authenticate(user=user)
        self.assertEqual(200, self.client.get("/api/v1/ecosystem/products/").status_code)
        self.client.force_login(user)
        self.assertEqual(200, self.client.get(reverse("ecosystem_workbench")).status_code)

    def test_risk_score_is_transparent_and_requires_complete_evidence(self):
        result = calculate_risk({"likelihood": 4, "impact": 5, "exposure": 3, "spread": 4, "control_gap": 2, "uncertainty": "medium"})
        self.assertEqual("critical", result["rating"]); self.assertIn("weights", result)
        incomplete = calculate_risk({"likelihood": 4})
        self.assertEqual("insufficient-evidence", incomplete["rating"]); self.assertIn("impact", incomplete["missing"])
