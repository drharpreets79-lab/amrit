"""AMRIT site-facing endpoints — `/v1/poll` and `/v1/respond`.

These endpoints implement the wire contract described in
``SYNC_PROTOCOL.md`` of the AMRIT desktop app. Auth is bearer-token
against ``Site.auth_token_hash``. PII guard middleware adds a hard layer
that rejects any response payload carrying patient identifiers.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from django.conf import settings
from django.db import transaction
from django.http import HttpResponse, JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from sites.models import Site

from .fhir_validation import validate_aggregate_fhir_bundle
from .models import PollAuditEntry, Query, QueryDispatch, QueryResult

LOG = logging.getLogger("amrit.poll")


def _bearer_token(request) -> str:
    raw = request.META.get("HTTP_AUTHORIZATION", "")
    if raw.lower().startswith("bearer "):
        return raw.split(" ", 1)[1].strip()
    return ""


def _authenticate(request, *, lab_code: str | None = None) -> Site | None:
    site = Site.authenticate_bearer(_bearer_token(request))
    if not site:
        return None
    if lab_code and site.lab_code != lab_code:
        return None
    # The second factor, when the site has one. This used to read
    # `if site.site_token and expected and site.site_token != expected`, so a caller that
    # simply omitted the header was waved through: the check ran only against clients that
    # volunteered it. A site with a site token issued must now present it on every request.
    if not site.check_site_token(request.META.get("HTTP_X_AMRIT_SITE", "").strip()):
        return None

    return site


def unauthorized():
    """The single answer to every rejected credential, and the reason it is single.

    A site presents two: the bearer token and, once it has one, the site token. Saying which
    of them failed would tell an unauthenticated caller that the *other* one was accepted —
    turning a two-factor check into an oracle for confirming a valid bearer token one guess at
    a time. So the reason is never disclosed and the remedy is stated in full instead, which
    costs a laboratory nothing: the actions are the same either way.

    The body used to be a bare ``{"error": "unauthorized"}``, which told a laboratory only
    that it had stopped working.
    """
    return JsonResponse(
        {
            "error": "unauthorized",
            "detail": (
                "This installation's credentials were not accepted. If the laboratory was "
                "re-approved, or either token was reset, use Request access and then Collect "
                "token. Check too that the site token from your administrator is entered "
                "exactly — a site that has one must send it on every request."
            ),
        },
        status=401,
    )


def _audit(site, action, *, lab_code="", query=None, detail="", error=""):
    try:
        PollAuditEntry.objects.create(
            site=site,
            lab_code=lab_code or (site.lab_code if site else ""),
            action=action,
            query=query,
            detail=detail[:2000],
            error=error[:2000],
        )
    except Exception:  # pragma: no cover
        LOG.exception("audit log write failed")


def _lab_code_mismatch(site: Site, requested_lab: str):
    """Reject a caller whose own code is not the one this token is registered under.

    Returns a response when the codes disagree, else None.

    The body says which code the registry holds and what to do about it. The bare
    ``{"error": "lab_code mismatch"}`` this used to return told a laboratory only that its
    sync had stopped: both codes were known to the server and neither was in the answer, so
    the desktop had nothing to show beyond the failure itself, and someone had to read
    server logs to find out which name was expected.

    Naming the registry's code is not a disclosure. The caller has already authenticated
    with this site's bearer token, so it is being told the code of the laboratory it has
    just proved it is — nothing it could not read off its own registration.
    """
    if not requested_lab or requested_lab == site.lab_code:
        return None
    _audit(
        site, "lab_code_mismatch", lab_code=requested_lab,
        error=f"Site sent {requested_lab}; registered as {site.lab_code}",
    )
    return JsonResponse(
        {
            "error": "lab_code mismatch",
            "registered_lab_code": site.lab_code,
            "sent_lab_code": requested_lab,
            "detail": (
                f"This token is registered to {site.lab_code}, but the request was sent as "
                f"{requested_lab}. Either set the laboratory code on the desktop to "
                f"{site.lab_code}, or have the central server rename the site to "
                f"{requested_lab} from Registry → Sites → rename."
            ),
        },
        status=403,
    )


def _pending_dispatches(site: Site, limit: int = 1):
    """Return up to ``limit`` deliverable dispatches for a site.

    Lazy-fans-out queries with empty ``target_lab_codes`` (broadcast to all
    sites) by creating a Dispatch row when none exists yet.

    The limit exists because a dashboard refresh enqueues sixteen queries at once. Handing
    them out one per long-poll made a refresh sixteen round trips deep per site, each one
    paying the full request latency before the next query was even visible to the desktop.
    """
    now = timezone.now()
    found = []
    # Already-pending rows, oldest query first.
    pending = list(
        QueryDispatch.objects.select_related("query")
        .filter(site=site, status="pending")
        .order_by("query__created_at")[: max(1, limit)]
    )
    for dispatch in pending:
        if dispatch.query.is_expired():
            dispatch.status = "expired"
            dispatch.save(update_fields=["status"])
            continue
        found.append(dispatch)
    if len(found) >= limit:
        return found[:limit]

    # Look for broadcast queries that have no dispatch row for this site yet.
    broadcast = (
        Query.objects.filter(status__in=("queued", "dispatched", "partial"))
        .filter(target_lab_codes__in=[[]])  # JSON exact-match for empty list
        .exclude(dispatches__site=site)
    )
    targeted = (
        Query.objects.filter(status__in=("queued", "dispatched", "partial"))
        .exclude(target_lab_codes__in=[[]])
        .exclude(dispatches__site=site)
    )
    candidates = list(broadcast) + [q for q in targeted if site.lab_code in (q.target_lab_codes or [])]
    for query in candidates:
        if query.expires_at and query.expires_at <= now:
            continue
        with transaction.atomic():
            dispatch, created = QueryDispatch.objects.get_or_create(
                query=query, site=site, defaults={"status": "pending"}
            )
            if created:
                found.append(dispatch)
                if len(found) >= limit:
                    break
    return found[:limit]


def _next_pending_dispatch(site: Site):
    """One deliverable dispatch, or None. Kept for callers that want a single query."""
    found = _pending_dispatches(site, limit=1)
    return found[0] if found else None


def _deliver(site: Site, dispatch):
    """Mark a dispatch delivered and return the payload the desktop reads."""
    now = timezone.now()
    dispatch.status = "delivered"
    dispatch.delivered_at = now
    dispatch.save(update_fields=["status", "delivered_at"])
    if dispatch.query.status == "queued":
        dispatch.query.status = "dispatched"
        dispatch.query.save(update_fields=["status"])
    _audit(
        site,
        "deliver",
        lab_code=site.lab_code,
        query=dispatch.query,
        detail=f"type={dispatch.query.type} id={dispatch.query.id}",
    )
    return dispatch.query.to_amrit_payload(site.lab_code)


#: How many queries one poll may carry. A refresh enqueues sixteen; the cap is above that
#: so a whole refresh reaches a site in a single request, and bounded so one site cannot
#: drain an arbitrarily large queue into one response.
MAX_POLL_BATCH = 32


@csrf_exempt
@require_http_methods(["GET"])
def poll(request):
    """Long-poll for pending queries for the calling site.

    ``?batch=N`` asks for up to N queries in one response, answered as
    ``{"queries": [...]}``. Without it the response is the single query object the
    original wire contract defines, so a desktop built before batching still works
    unchanged — the shape of the answer is the capability signal.
    """
    site = _authenticate(request)

    if site is None:
        return unauthorized()

    mismatch = _lab_code_mismatch(site, request.GET.get("lab_code", "").strip())
    if mismatch is not None:
        return mismatch

    try:
        wait = max(0, min(int(request.GET.get("wait", 60)), settings.AMRIT_LONGPOLL_MAX_WAIT))
    except (TypeError, ValueError):
        wait = 60
    try:
        batch = max(1, min(int(request.GET.get("batch", 1)), MAX_POLL_BATCH))
    except (TypeError, ValueError):
        batch = 1
    batched = "batch" in request.GET

    site.touch_seen(polled=True)
    deadline = time.monotonic() + wait
    tick = max(0.5, settings.AMRIT_LONGPOLL_TICK)

    while True:
        dispatches = _pending_dispatches(site, limit=batch)
        if dispatches:
            payloads = [_deliver(site, dispatch) for dispatch in dispatches]
            if batched:
                return JsonResponse({"queries": payloads}, status=200)
            return JsonResponse(payloads[0], status=200)
        if time.monotonic() >= deadline:
            return HttpResponse(status=204)
        time.sleep(tick)


@csrf_exempt
@require_http_methods(["POST"])
def respond(request):
    """Site posts the aggregate result of a previously delivered query.

    ``{"results": [...]}`` posts several at once — the answer to a whole dashboard refresh
    in one request rather than sixteen. Each entry is stored independently and reported
    independently, so one malformed result does not discard the fifteen good ones.
    """
    site = _authenticate(request)
    if site is None:
        return unauthorized()

    try:
        body = json.loads(request.body.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return JsonResponse({"error": "invalid_json", "detail": str(exc)}, status=400)

    if isinstance(body.get("results"), list):
        entries = body["results"]
        if len(entries) > MAX_POLL_BATCH:
            return JsonResponse(
                {"error": "too_many_results", "detail": f"At most {MAX_POLL_BATCH} results per request."},
                status=400,
            )
        stored = []
        for entry in entries:
            if not isinstance(entry, dict):
                stored.append({"error": "invalid_result", "detail": "Each result must be an object."})
                continue
            stored.append(_store_result(site, entry))
        site.touch_seen(responded=True)
        accepted = sum(1 for item in stored if item.get("status") == "stored")
        return JsonResponse(
            {"status": "stored" if accepted == len(stored) else "partial", "accepted": accepted, "results": stored},
            status=200 if accepted else 400,
        )

    outcome = _store_result(site, body)
    if outcome.get("status") != "stored":
        return JsonResponse(outcome, status=int(outcome.pop("http_status", 400)))
    site.touch_seen(responded=True)
    _audit(
        site,
        "respond",
        lab_code=site.lab_code,
        query=None,
        detail=f"bytes={len(request.body)}",
    )
    return JsonResponse({"status": "stored", "fhir_stored": outcome.get("fhir_stored", False)}, status=200)


def _store_result(site: Site, body: dict) -> dict:
    """Store one site's answer to one query. Returns what to tell the caller about it."""
    query_id = str(body.get("query_id", "")).strip()
    if not query_id:
        return {"error": "missing query_id", "http_status": 400}

    try:
        query_uuid = uuid.UUID(query_id)
    except ValueError:
        return {"error": "bad query_id", "query_id": query_id, "http_status": 400}

    dispatch = (
        QueryDispatch.objects.select_related("query", "site")
        .filter(query__id=query_uuid, site=site)
        .first()
    )
    if dispatch is None:
        return {"error": "unknown query for this site", "query_id": query_id, "http_status": 404}

    ok = bool(body.get("ok", True))
    error_text = str(body.get("error", "") or "").strip()
    result_payload = body.get("result", {}) if isinstance(body.get("result"), (dict, list)) else {}
    fhir_payload = body.get("fhir_bundle", {})
    if not fhir_payload and isinstance(result_payload, dict) and result_payload.get("resourceType") == "Bundle":
        fhir_payload = result_payload
    if fhir_payload:
        fhir_errors = validate_aggregate_fhir_bundle(fhir_payload)
        if fhir_errors:
            return {
                "error": "invalid_aggregate_fhir", "detail": fhir_errors[:5],
                "query_id": query_id, "http_status": 400,
            }

    with transaction.atomic():
        QueryResult.objects.create(
            query=dispatch.query,
            site=site,
            ok=ok and not error_text,
            result_json=result_payload,
            fhir_json=fhir_payload or {},
            error=error_text,
        )
        dispatch.status = "answered" if ok and not error_text else "error"
        dispatch.answered_at = timezone.now()
        dispatch.save(update_fields=["status", "answered_at"])

        # Update aggregate query status
        total = dispatch.query.dispatches.count()
        completed = dispatch.query.dispatches.filter(status__in=("answered", "error", "expired")).count()
        if completed >= total:
            dispatch.query.status = "completed"
            dispatch.query.completed_at = timezone.now()
            dispatch.query.save(update_fields=["status", "completed_at"])
        elif completed > 0:
            dispatch.query.status = "partial"
            dispatch.query.save(update_fields=["status"])

    _audit(
        site,
        "respond",
        lab_code=site.lab_code,
        query=dispatch.query,
        detail=f"ok={ok} type={dispatch.query.type}",
        error=error_text,
    )
    return {"status": "stored", "query_id": query_id, "fhir_stored": bool(fhir_payload)}


@csrf_exempt
@require_http_methods(["POST"])
def heartbeat(request):
    """Site posts a periodic heartbeat with status + (optional, consented) GPS.

    Body:
      {
        "lab_code":   "AIIMS-DEL",
        "app_version":"1.4.2",
        "gps_consent": true,
        "latitude":   28.5672,         # optional, only if consented
        "longitude":  77.2100,         # optional, only if consented
        "gps_source": "ip" | "manual" | "device",
        "next_heartbeat_at": "2026-05-02T17:00:00Z"
      }

    Server records last_seen_at, optionally updates Site.latitude/longitude,
    and writes an audit entry. Returns the next expected heartbeat interval.
    """
    site = _authenticate(request)
    if site is None:
        return unauthorized()

    try:
        body = json.loads(request.body.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return JsonResponse({"error": "invalid_json", "detail": str(exc)}, status=400)

    consent = bool(body.get("gps_consent", False))
   
    lat = body.get("latitude")
    lon = body.get("longitude")
    gps_source = str(body.get("gps_source", "") or "")[:32]
    app_version = str(body.get("app_version", "") or "")[:32]

    update_fields = ["last_seen_at", "last_poll_at"]
    if consent and lat is not None and lon is not None:
        try:
            lat_f = float(lat)
            lon_f = float(lon)
        except (TypeError, ValueError):
            return JsonResponse({"error": "bad coordinates"}, status=400)
        if not (-90.0 <= lat_f <= 90.0) or not (-180.0 <= lon_f <= 180.0):
            return JsonResponse({"error": "coordinates out of range"}, status=400)
        site.latitude = lat_f
        site.longitude = lon_f
        update_fields += ["latitude", "longitude"]

    now = timezone.now()
    site.last_seen_at = now
    site.last_poll_at = now
    site.save(update_fields=update_fields)

    interval = int(getattr(settings, "AMRIT_HEARTBEAT_INTERVAL_SECONDS", 4 * 3600))
    detail = f"version={app_version} gps_consent={consent} gps_source={gps_source}"
    if "latitude" in update_fields:
        detail += f" lat={site.latitude} lon={site.longitude}"
    _audit(site, "heartbeat", lab_code=site.lab_code, detail=detail)

    return JsonResponse(
        {
            "status": "ok",
            "lab_code": site.lab_code,
            "next_heartbeat_seconds": interval,
            "server_time": now.isoformat(),
        },
        status=200,
    )
