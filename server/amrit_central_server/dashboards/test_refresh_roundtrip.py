"""The refresh button, end to end, over the wire a desktop actually uses.

The existing tests check the pieces: that a newer result replaces an older one, that a
strict snapshot write is atomic. None of them walk the path the operator's click takes —
dispatch to the sites, the desktop collecting its queries and answering them, the wait
returning complete, snapshots written. That is the thing being reported as slow, so it is
also the thing worth pinning as working.

It is written against the batched wire path because that is what a current desktop uses:
one poll collects the whole refresh, one post answers it.
"""

from __future__ import annotations

import json

from django.test import Client, TestCase

from dashboards.models import KPISnapshot
from dashboards.refresh import dispatch_live_pull, refresh_scope, wait_for_live_pull
from queries.models import QueryDispatch, QueryResult
from sites.models import Site


class RefreshRoundTripTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.token = Site.issue_token(24)
        self.site_token = Site.issue_token(16)
        self.site = Site(lab_code="DEMO-DEL-01", name="Delhi demo", status="active")
        self.site.set_auth_token(self.token)
        self.site.set_site_token(self.site_token)
        self.site.save()
        # A site is only pulled from if it has polled recently enough to count as online.
        self.site.touch_seen(polled=True)
        self.headers = {
            "HTTP_AUTHORIZATION": f"Bearer {self.token}",
            "HTTP_X_AMRIT_SITE": self.site_token,
        }

    def _answer_everything(self) -> int:
        """Play the desktop: collect the batch, answer it in one post."""
        response = self.client.get("/v1/poll?lab_code=DEMO-DEL-01&wait=0&batch=32", **self.headers)
        self.assertEqual(response.status_code, 200)
        queries = response.json()["queries"]
        results = []
        for query in queries:
            if query["type"] == "isolate_count":
                payload = {"count": 4200}
            elif query["type"] == "resistance_rate":
                payload = {"numerator": 46, "denominator": 100, "rate_percent": 46.0}
            elif query["type"] == "organism_distribution":
                payload = {"total": 2900, "buckets": {"Escherichia coli": 1800, "Klebsiella pneumoniae complex": 1100}}
            else:
                payload = {"total": 1400, "buckets": {"Urine": 900, "Blood / normally sterile fluid": 500}}
            results.append({"query_id": query["id"], "ok": True, "result": payload})
        posted = self.client.post(
            "/v1/respond", data=json.dumps({"results": results}),
            content_type="application/json", **self.headers,
        )
        self.assertEqual(posted.status_code, 200)
        self.assertEqual(posted.json()["accepted"], len(results))
        return len(queries)

    def test_a_refresh_dispatches_is_answered_and_becomes_snapshots(self):
        summary = dispatch_live_pull("country", "")
        self.assertEqual(summary["sites"], 1)
        self.assertGreater(summary["dispatched_queries"], 1)

        collected = self._answer_everything()
        # The whole refresh reached the desktop in one exchange rather than one per query.
        self.assertEqual(collected, summary["dispatched_queries"])

        counts = wait_for_live_pull(summary, timeout_seconds=5)
        self.assertTrue(counts["complete"])
        self.assertFalse(counts["timed_out"])
        self.assertEqual(counts["responded_sites"], 1)
        self.assertEqual(counts["records"], 4200)
        self.assertEqual(QueryResult.objects.count(), summary["dispatched_queries"])
        self.assertEqual(QueryDispatch.objects.filter(status="answered").count(), summary["dispatched_queries"])

        written = refresh_scope(
            "country", "", source="live",
            query_ids=summary["query_ids"], site_ids=summary["site_ids"], strict=True,
        )
        self.assertGreater(written, 0)
        self.assertEqual(KPISnapshot.objects.count(), written)
        # The isolate burden is the number the site actually reported, not a stale one.
        burden = KPISnapshot.objects.filter(metric_key="burden_isolates").first()
        self.assertIsNotNone(burden)
        self.assertEqual(burden.value_json["total"], 4200)

    def test_a_second_refresh_supersedes_the_first_batch(self):
        first = dispatch_live_pull("country", "")
        self._answer_everything()
        wait_for_live_pull(first, timeout_seconds=5)

        second = dispatch_live_pull("country", "")
        # Queries from the earlier batch are not handed out again.
        self.assertTrue(set(second["query_ids"]).isdisjoint(set(first["query_ids"])))
        collected = self._answer_everything()
        self.assertEqual(collected, second["dispatched_queries"])
        counts = wait_for_live_pull(second, timeout_seconds=5)
        self.assertTrue(counts["complete"])

    def test_a_site_that_never_answers_is_reported_incomplete_rather_than_guessed(self):
        summary = dispatch_live_pull("country", "")
        counts = wait_for_live_pull(summary, timeout_seconds=0.2)
        self.assertFalse(counts["complete"])
        self.assertTrue(counts["timed_out"])
        self.assertEqual(counts["records"], 0)
