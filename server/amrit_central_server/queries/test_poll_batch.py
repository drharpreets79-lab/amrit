"""One exchange per refresh, instead of one exchange per query.

A dashboard refresh enqueues sixteen queries for every site. Handed out one per long-poll
and answered one per post, that is thirty-two round trips deep before a single number
reaches the portal, and it is why a refresh felt slow on anything but a local network.

These pin the batched wire path and, just as importantly, that the unbatched one still
works: a desktop built before batching sends no ``batch`` parameter and must keep getting
the single query object the original contract promised.
"""

from __future__ import annotations

import json

from django.test import Client, TestCase

from sites.models import Site

from .models import Query, QueryDispatch, QueryResult


class PollBatchTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.token = Site.issue_token(24)
        self.site_token = Site.issue_token(16)
        self.site = Site(lab_code="LAB01", name="Test laboratory", status="active")
        self.site.set_auth_token(self.token)
        self.site.set_site_token(self.site_token)
        self.site.save()
        self.headers = {
            "HTTP_AUTHORIZATION": f"Bearer {self.token}",
            "HTTP_X_AMRIT_SITE": self.site_token,
        }

    def _queue(self, count: int) -> list[Query]:
        queries = []
        for index in range(count):
            query = Query.objects.create(
                type="isolate_count", title=f"Live refresh · {index}",
                target_lab_codes=["LAB01"], status="queued",
            )
            QueryDispatch.objects.create(query=query, site=self.site, status="pending")
            queries.append(query)
        return queries

    def test_a_batch_poll_returns_every_pending_query_at_once(self):
        self._queue(5)
        response = self.client.get("/v1/poll?lab_code=LAB01&wait=0&batch=25", **self.headers)
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload["queries"]), 5)
        self.assertEqual({item["type"] for item in payload["queries"]}, {"isolate_count"})
        # Every one is delivered, so the next poll does not hand them out twice.
        self.assertEqual(QueryDispatch.objects.filter(status="delivered").count(), 5)

    def test_batch_is_capped_and_the_rest_stay_pending(self):
        self._queue(4)
        response = self.client.get("/v1/poll?lab_code=LAB01&wait=0&batch=2", **self.headers)
        self.assertEqual(len(response.json()["queries"]), 2)
        self.assertEqual(QueryDispatch.objects.filter(status="pending").count(), 2)

    def test_a_desktop_that_asks_for_no_batch_still_gets_one_query_object(self):
        self._queue(3)
        response = self.client.get("/v1/poll?lab_code=LAB01&wait=0", **self.headers)
        payload = response.json()
        self.assertNotIn("queries", payload)
        self.assertEqual(payload["type"], "isolate_count")
        self.assertEqual(QueryDispatch.objects.filter(status="pending").count(), 2)

    def test_an_empty_queue_still_answers_204(self):
        response = self.client.get("/v1/poll?lab_code=LAB01&wait=0&batch=25", **self.headers)
        self.assertEqual(response.status_code, 204)

    def test_a_batched_response_stores_every_result(self):
        queries = self._queue(3)
        body = {"results": [
            {"query_id": str(query.id), "ok": True, "result": {"count": 10 + index}}
            for index, query in enumerate(queries)
        ]}
        response = self.client.post(
            "/v1/respond", data=json.dumps(body), content_type="application/json", **self.headers
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["accepted"], 3)
        self.assertEqual(QueryResult.objects.count(), 3)
        self.assertEqual(QueryDispatch.objects.filter(status="answered").count(), 3)

    def test_one_bad_entry_does_not_discard_the_good_ones(self):
        queries = self._queue(2)
        body = {"results": [
            {"query_id": str(queries[0].id), "ok": True, "result": {"count": 4}},
            {"query_id": "not-a-uuid", "ok": True, "result": {"count": 9}},
        ]}
        response = self.client.post(
            "/v1/respond", data=json.dumps(body), content_type="application/json", **self.headers
        )
        payload = response.json()
        self.assertEqual(payload["status"], "partial")
        self.assertEqual(payload["accepted"], 1)
        self.assertEqual(QueryResult.objects.count(), 1)
        # The untouched query is still open, so the site can answer it again.
        self.assertEqual(QueryDispatch.objects.filter(query=queries[1], status="pending").count(), 1)

    def test_a_single_result_body_is_still_accepted(self):
        query = self._queue(1)[0]
        response = self.client.post(
            "/v1/respond",
            data=json.dumps({"query_id": str(query.id), "ok": True, "result": {"count": 7}}),
            content_type="application/json", **self.headers,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "stored")
        self.assertEqual(QueryResult.objects.get().result_json, {"count": 7})

    def test_an_unauthenticated_batch_is_refused_like_any_other_request(self):
        self._queue(1)
        response = self.client.get("/v1/poll?lab_code=LAB01&wait=0&batch=25")
        self.assertEqual(response.status_code, 401)
