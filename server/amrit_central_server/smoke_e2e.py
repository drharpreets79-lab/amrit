"""End-to-end smoke test against the Django test client.

Exercises:
  1. Site creation + token issue.
  2. Long-poll happy path: dispatch query, site polls, gets payload.
  3. Site posts aggregate result, server stores it.
  4. PII guard rejects a payload containing patient_id.
  5. Aggregate analytics rolls up the stored result and emits FHIR.
"""

from __future__ import annotations

import json
import os
import sys

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "central.settings")
os.environ.setdefault("DJANGO_SECRET_KEY", "test")
os.environ.setdefault("DATABASE_URL", "sqlite:///./smoke.sqlite3")
os.environ.setdefault("AMRIT_COUNTRY_PROFILE", "TESTLAND")
django.setup()

from django.contrib.auth import get_user_model
from django.test.utils import setup_test_environment
from django.test import Client

from central.country_profile import get_profile
from queries.models import Query, QueryDispatch, QueryResult
from sites.models import Site

User = get_user_model()
setup_test_environment()


def _migrate_own_database() -> None:
    """Bring this script's own database up to date, rather than assuming someone else did.

    Phase 16 recorded that this script "talks to a real database rather than a Django test
    database", and that it only passed locally because a migrated `smoke.sqlite3` happened to
    be sitting in the tree. The fix at the time added `manage.py migrate` to the workflow —
    which migrates `db.sqlite3`, the settings default, and **not** the `smoke.sqlite3` this
    script points `DATABASE_URL` at. So the same failure survived the fix, and a clean checkout
    still died with `django.db.utils.OperationalError: no such table: amrit_sites_site`.

    Migrating here rather than in the workflow is the difference between a script that works
    and a script that works if you remember something. It is also idempotent: on an already
    migrated database it applies nothing.
    """
    from django.core.management import call_command

    call_command("migrate", run_syncdb=True, interactive=False, verbosity=0)


_migrate_own_database()


def _admin_login(client):
    User.objects.filter(username="admin").delete()
    user = User.objects.create_superuser("admin", "a@b.c", "admin-pass")
    client.force_login(user)
    return user


def main():
    profile = get_profile()
    lab_code = "SITE-001"
    Site.objects.all().delete()
    Query.objects.all().delete()

    api = Client()
    _admin_login(api)

    # 1. Register a site
    resp = api.post(
        "/api/v1/sites/",
        data=json.dumps(
            {
                "lab_code": lab_code,
                "name": "Reference Laboratory",
                "country": profile["country_name"],
                "country_code": profile["country_code"],
                # Structured on the universal field set; which of these a country uses,
                # requires and calls what comes from the address-format pack.
                "address": {
                    "country_code": profile["country_code"],
                    "address_lines": ["100 Reference Avenue"],
                    "locality": "Example City",
                    # Full Plus Codes are country-independent and resolve offline, including
                    # in deployments whose country has no postal-code system.
                    "plus_code": "8FVC9G8F+5W",
                },
                "lab_domain": "Human",
            }
        ),
        content_type="application/json",
    )
    assert resp.status_code == 201, (resp.status_code, resp.content)
    payload = resp.json()
    site_token = payload["issued_token"]
    print("[1] site registered", payload["lab_code"], "token-prefix=", payload["auth_token_prefix"])

    # 2. Dispatch a resistance-rate query
    resp = api.post(
        "/api/v1/analytics/dispatch/resistance-rate",
        data=json.dumps(
            {
                "antibiotic_code": "MEM",
                "lab_code": [lab_code],
                "organism": "Escherichia coli",
                "period_start": "2025-01-01",
                "period_end": "2026-04-30",
            }
        ),
        content_type="application/json",
    )
    assert resp.status_code == 201, (resp.status_code, resp.content)
    query_id = resp.json()["query_id"]
    print("[2] dispatched query", query_id)

    # 3. Simulate site long-poll (no auth = 401)
    raw = Client()
    resp = raw.get(f"/v1/poll?lab_code={lab_code}&wait=1")
    assert resp.status_code == 401, resp.status_code
    print("[3a] poll without auth -> 401 (expected)")

    # 3b. Site poll with bearer token
    resp = raw.get(
        f"/v1/poll?lab_code={lab_code}&wait=2",
        HTTP_AUTHORIZATION=f"Bearer {site_token}",
    )
    assert resp.status_code == 200, (resp.status_code, resp.content)
    body = resp.json()
    assert body["id"] == query_id and body["type"] == "resistance_rate"
    print("[3b] poll delivered query of type", body["type"], "filters=", body["filters"])

    # 4. PII guard: site tries to post a result with patient_id (must reject)
    bad = raw.post(
        "/v1/respond",
        data=json.dumps(
            {
                "query_id": query_id,
                "ok": True,
                "result": {"numerator": 5, "denominator": 12, "patient_id": "P123"},
            }
        ),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {site_token}",
    )
    assert bad.status_code == 422, (bad.status_code, bad.content)
    assert bad.json()["error"] == "pii_guard_rejected"
    print("[4] PII guard rejected patient_id ->", bad.json()["detail"])

    # 5. Site posts a clean aggregate
    good = raw.post(
        "/v1/respond",
        data=json.dumps(
            {
                "query_id": query_id,
                "ok": True,
                "result": {
                    "antibiotic_code": "MEM",
                    "numerator": 4,
                    "denominator": 20,
                    "rate_percent": 20.0,
                    "by_origin": {"HAI": {"numerator": 3, "denominator": 12}, "CAI": {"numerator": 1, "denominator": 8}},
                },
            }
        ),
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {site_token}",
    )
    assert good.status_code == 200, (good.status_code, good.content)
    print("[5] aggregate stored")

    # 6. Pull rolled-up FHIR Bundle
    resp = api.get(
        "/api/v1/analytics/aggregate/resistance-rate?antibiotic_code=MEM&output_format=fhir_bundle"
    )
    assert resp.status_code == 200
    bundle = resp.json()
    assert bundle["resourceType"] == "Bundle"
    types = [e["resource"]["resourceType"] for e in bundle["entry"]]
    assert "Organization" in types and "Measure" in types and "MeasureReport" in types
    print("[6] FHIR Bundle entries=", types)

    # 7. JSON aggregate
    resp = api.get("/api/v1/analytics/aggregate/resistance-rate?antibiotic_code=MEM")
    body = resp.json()
    assert body["denominator"] == 20 and body["numerator"] == 4
    print("[7] JSON rollup", "rate_percent=", body["rate_percent"], "ci=", body["ci"])

    # 8. Filter catalog reachable
    resp = api.get("/api/v1/analytics/filters")
    catalog = resp.json()
    print("[8] filter catalog count=", len(catalog["filters"]), "metrics=", catalog["metrics"])

    print("\nALL CHECKS PASSED")


if __name__ == "__main__":
    sys.exit(main() or 0)
