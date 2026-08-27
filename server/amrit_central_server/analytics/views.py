"""Analyst-facing aggregate analytics API.

Three flavors of endpoint:

1.  ``/api/v1/analytics/filters`` — return the exhaustive filter catalog.
2.  ``/api/v1/analytics/aggregate/<metric>`` — synchronously aggregate
    *already-stored* ``QueryResult`` rows. Used to roll up data that has
    been collected from the federated sites.
3.  ``/api/v1/analytics/dispatch/<metric>`` — enqueue a fresh query for
    every active site (or the ``lab_code`` set passed in filters) so the
    next long-poll picks it up. Returns the parent ``Query`` UUID.

All output respects ``output_format = fhir_bundle | json | csv``.
"""

from __future__ import annotations

import csv
import io
from collections import defaultdict
from typing import Any, Dict, List, Tuple

from django.conf import settings
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema

from central.privacy import k_anonymity_floor
from django.http import HttpResponse, JsonResponse
from django.utils import timezone
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from queries.models import Query, QueryDispatch, QueryResult
from sites.models import Site

from . import fhir
from .filters import (
    ANALYTICS_FILTERS,
    apply_filters_to_buckets,
    coerce_request_filters,
    filters_catalog,
    project_to_amrit_query,
)


METRIC_TO_QUERY_TYPE = {
    "isolate-count": "isolate_count",
    "organism-distribution": "organism_distribution",
    "specimen-distribution": "specimen_distribution",
    "resistance-rate": "resistance_rate",
    "measure-bundle": "measure_bundle",
}


def _request_filters(request) -> Dict[str, Any]:
    raw = request.data if request.method != "GET" else request.GET
    payload = {k: v for k, v in raw.items()} if hasattr(raw, "items") else dict(raw)
    return coerce_request_filters(payload)


def _site_for(qr: QueryResult) -> Dict[str, Any]:
    site = qr.site
    return {
        "lab_code": site.lab_code,
        "name": site.name,
        "country": site.country,
        "country_code": site.country_code,
        # Where it reports from, and where the building is. Kept apart because they are
        # different questions and frequently different places.
        "admin_path": site.admin_path,
        "address": site.address,
    }


from django.db.models import Q  # noqa: E402
from geo.models import AdminUnit  # noqa: E402
from central import identifiers  # noqa: E402


def _filter_results_by_site(qs, filters: Dict[str, Any]):
    lab_codes = filters.get("lab_code") or []
    countries = filters.get("country") or []
    admin_paths = filters.get("admin_path") or []
    domains = filters.get("lab_domain") or []
    country_codes = filters.get("country_code") or []
    admin_codes = filters.get("admin_code") or []
    if lab_codes:
        qs = qs.filter(site__lab_code__in=lab_codes)
    if countries:
        qs = qs.filter(site__country__in=countries)
    if country_codes:
        qs = qs.filter(site__country_code__in=[code.upper() for code in country_codes])
    if admin_paths:
        # A unit's path is a prefix of every path beneath it, so one filter selects a
        # level and everything under it, at any depth.
        condition = Q()
        for path in admin_paths:
            condition |= Q(site__admin_path=path) | Q(site__admin_path__startswith=f"{path}/")
        qs = qs.filter(condition)
    if admin_codes:
        # Country-neutral: match any level by administrative code.
        condition = Q()
        for code in admin_codes:
            for unit in AdminUnit.objects.filter(code=code):
                condition |= Q(site__admin_path__startswith=f"{unit.admin_path}/") | Q(site__admin_unit=unit.pk)
        qs = qs.filter(condition) if condition else qs.none()
    if domains:
        qs = qs.filter(site__lab_domain__in=domains)
    return qs


# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------
@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def filters_index(request):
    return Response(
        {
            "filters": filters_catalog(),
            "metrics": list(METRIC_TO_QUERY_TYPE.keys()),
            "output_formats": ["fhir_bundle", "json", "csv"],
            "k_anonymity_floor": k_anonymity_floor(),
        }
    )


# ---------------------------------------------------------------------------
# Synchronous rollup of already-stored aggregate results
# ---------------------------------------------------------------------------
@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def aggregate_isolate_count(request):
    filters = _request_filters(request)
    qs = _filter_results_by_site(
        QueryResult.objects.filter(query__type="isolate_count", ok=True).select_related("site"),
        filters,
    )
    by_site: Dict[str, int] = {}
    total = 0
    for qr in qs:
        n = int(qr.result_json.get("count", 0) or 0)
        by_site[qr.site.lab_code] = by_site.get(qr.site.lab_code, 0) + n
        total += n
    payload = {"metric": "isolate-count", "total": total, "by_site": by_site, "filters": filters}
    return _shape_response(request, filters, payload, _build_isolate_count_fhir)


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def aggregate_organism_distribution(request):
    filters = _request_filters(request)
    qs = _filter_results_by_site(
        QueryResult.objects.filter(query__type="organism_distribution", ok=True).select_related("site"),
        filters,
    )
    merged: Dict[str, int] = defaultdict(int)
    per_site: Dict[str, Dict[str, int]] = {}
    for qr in qs:
        buckets = qr.result_json.get("buckets") or {}
        per_site_buckets: Dict[str, int] = {}
        for label, count in buckets.items():
            merged[label] += int(count or 0)
            per_site_buckets[label] = int(count or 0)
        per_site[qr.site.lab_code] = per_site_buckets
    merged = apply_filters_to_buckets(dict(merged), filters)
    floor = max(int(filters.get("min_isolates") or 0), k_anonymity_floor())
    merged = {k: v for k, v in merged.items() if v >= floor}
    payload = {
        "metric": "organism-distribution",
        "total": sum(merged.values()),
        "buckets": merged,
        "by_site": per_site,
        "filters": filters,
    }
    return _shape_response(request, filters, payload, _build_distribution_fhir)


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def aggregate_specimen_distribution(request):
    filters = _request_filters(request)
    qs = _filter_results_by_site(
        QueryResult.objects.filter(query__type="specimen_distribution", ok=True).select_related("site"),
        filters,
    )
    merged: Dict[str, int] = defaultdict(int)
    per_site: Dict[str, Dict[str, int]] = {}
    for qr in qs:
        buckets = qr.result_json.get("buckets") or {}
        per_site_buckets: Dict[str, int] = {}
        for label, count in buckets.items():
            merged[label] += int(count or 0)
            per_site_buckets[label] = int(count or 0)
        per_site[qr.site.lab_code] = per_site_buckets
    floor = max(int(filters.get("min_isolates") or 0), k_anonymity_floor())
    merged = {k: v for k, v in merged.items() if v >= floor}
    payload = {
        "metric": "specimen-distribution",
        "total": sum(merged.values()),
        "buckets": merged,
        "by_site": per_site,
        "filters": filters,
    }
    return _shape_response(request, filters, payload, _build_distribution_fhir)


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def aggregate_resistance_rate(request):
    filters = _request_filters(request)
    abx_filter = filters.get("antibiotic_code") or []
    qs = _filter_results_by_site(
        QueryResult.objects.filter(query__type="resistance_rate", ok=True).select_related("site", "query"),
        filters,
    )
    if abx_filter:
        qs = qs.filter(query__antibiotic_code__in=abx_filter)

    overall_num = overall_den = 0
    by_site: List[Dict[str, Any]] = []
    by_antibiotic: Dict[str, Dict[str, int]] = defaultdict(lambda: {"num": 0, "den": 0})

    for qr in qs:
        result = qr.result_json or {}
        num = int(result.get("numerator", 0) or 0)
        den = int(result.get("denominator", 0) or 0)
        abx = str(result.get("antibiotic_code", qr.query.antibiotic_code or "")).upper()
        overall_num += num
        overall_den += den
        by_antibiotic[abx]["num"] += num
        by_antibiotic[abx]["den"] += den
        by_site.append(
            {
                "site": _site_for(qr),
                "antibiotic_code": abx,
                "numerator": num,
                "denominator": den,
                "rate_percent": round((num / den * 100), 2) if den else 0.0,
                "by_origin": result.get("by_origin", {}),
            }
        )

    min_den = int(filters.get("min_denominator") or 0)
    by_site = [item for item in by_site if item["denominator"] >= min_den]
    by_antibiotic_out = {
        abx: {
            "numerator": v["num"],
            "denominator": v["den"],
            "rate_percent": round((v["num"] / v["den"] * 100), 2) if v["den"] else 0.0,
        }
        for abx, v in by_antibiotic.items()
        if v["den"] >= min_den
    }

    ci_method = filters.get("ci_method", "wilson")
    ci_level = float(filters.get("ci_level") or 95) / 100.0
    ci = fhir.wilson_ci(overall_num, overall_den, level=ci_level) if ci_method == "wilson" else None

    payload = {
        "metric": "resistance-rate",
        "antibiotic_codes": abx_filter or sorted(by_antibiotic_out.keys()),
        "numerator": overall_num,
        "denominator": overall_den,
        "rate_percent": round((overall_num / overall_den * 100), 2) if overall_den else 0.0,
        "ci": ci,
        "by_site": by_site,
        "by_antibiotic": by_antibiotic_out,
        "filters": filters,
    }
    return _shape_response(request, filters, payload, _build_resistance_rate_fhir)


# ---------------------------------------------------------------------------
# Dispatcher — enqueue fresh queries to all matching sites
# ---------------------------------------------------------------------------
@extend_schema(request=OpenApiTypes.OBJECT, responses={201: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def dispatch_query(request, metric: str):
    qtype = METRIC_TO_QUERY_TYPE.get(metric)
    if not qtype:
        return Response({"error": f"unknown metric '{metric}'"}, status=status.HTTP_400_BAD_REQUEST)
    filters = _request_filters(request)

    target_lab_codes = filters.get("lab_code") or []
    abx = (request.data.get("antibiotic_code") or filters.get("antibiotic_code") or "")
    if isinstance(abx, list):
        abx = abx[0] if abx else ""
    if qtype in {"resistance_rate", "measure_bundle"} and not abx:
        return Response(
            {"error": "antibiotic_code required for resistance metrics"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    expires_at = timezone.now() + timezone.timedelta(seconds=settings.AMRIT_QUERY_TTL_SECONDS)
    site_payload_filters = project_to_amrit_query(filters)
    query = Query.objects.create(
        type=qtype,
        title=request.data.get("title", "") or f"{metric} dispatch",
        notes=request.data.get("notes", ""),
        target_lab_codes=target_lab_codes,
        antibiotic_code=str(abx).upper(),
        filters=site_payload_filters,
        expires_at=expires_at,
        created_by=request.user if request.user.is_authenticated else None,
    )
    if target_lab_codes:
        sites = Site.objects.filter(lab_code__in=target_lab_codes, status="active")
        QueryDispatch.objects.bulk_create(
            [QueryDispatch(query=query, site=site) for site in sites], ignore_conflicts=True
        )
        dispatched_count = sites.count()
    else:
        dispatched_count = Site.objects.filter(status="active").count()

    return Response(
        {
            "query_id": str(query.id),
            "type": qtype,
            "dispatched_to": dispatched_count,
            "expires_at": expires_at,
            "status": query.status,
        },
        status=status.HTTP_201_CREATED,
    )


# ---------------------------------------------------------------------------
# Output shaping (FHIR | JSON | CSV)
# ---------------------------------------------------------------------------
def _shape_response(request, filters, payload, fhir_builder):
    output = (filters.get("output_format") or request.GET.get("output_format") or "json").lower()
    if output == "csv":
        return _csv_response(payload)
    if output == "fhir_bundle":
        return JsonResponse(fhir_builder(payload), status=200, json_dumps_params={"indent": 2})
    return Response(payload)


def _csv_response(payload):
    buf = io.StringIO()
    writer = csv.writer(buf)
    metric = payload.get("metric", "metric")
    if metric in {"organism-distribution", "specimen-distribution"}:
        writer.writerow(["bucket", "count"])
        for label, count in payload.get("buckets", {}).items():
            writer.writerow([label, count])
    elif metric == "isolate-count":
        writer.writerow(["lab_code", "count"])
        for lab, count in payload.get("by_site", {}).items():
            writer.writerow([lab, count])
        writer.writerow(["TOTAL", payload.get("total", 0)])
    elif metric == "resistance-rate":
        writer.writerow(["lab_code", "antibiotic", "numerator", "denominator", "rate_percent"])
        for row in payload.get("by_site", []):
            writer.writerow(
                [
                    row["site"]["lab_code"],
                    row.get("antibiotic_code", ""),
                    row["numerator"],
                    row["denominator"],
                    row["rate_percent"],
                ]
            )
    else:
        writer.writerow(["payload"])
        writer.writerow([str(payload)])
    return HttpResponse(buf.getvalue(), content_type="text/csv")


def _build_isolate_count_fhir(payload):
    entries = []
    for lab_code, count in payload.get("by_site", {}).items():
        site = Site.objects.filter(lab_code=lab_code).first()
        org = fhir.organization_resource(
            {"lab_code": lab_code, "name": site.name if site else lab_code,
             "country": site.country if site else "",
             "address": site.address if site else {}}
        )
        obs = fhir.observation_count(
            code="isolate-count",
            display="Total isolates",
            count=count,
            organization_ref=f"urn:uuid:{org['id']}",
        )
        entries.extend([org, obs])
    return fhir.bundle(entries, identifier="amrit-isolate-count")


def _build_distribution_fhir(payload):
    entries = []
    for lab_code, buckets in payload.get("by_site", {}).items():
        site = Site.objects.filter(lab_code=lab_code).first()
        org = fhir.organization_resource(
            {"lab_code": lab_code, "name": site.name if site else lab_code,
             "country": site.country if site else "",
             "address": site.address if site else {}}
        )
        entries.append(org)
        for label, count in buckets.items():
            entries.append(
                fhir.observation_count(
                    code=payload["metric"],
                    display=label,
                    count=count,
                    organization_ref=f"urn:uuid:{org['id']}",
                )
            )
    return fhir.bundle(entries, identifier=f"amrit-{payload.get('metric')}")


def _build_resistance_rate_fhir(payload):
    entries = []
    measure_url = identifiers.measure_url((payload.get("antibiotic_codes") or ["ANY"])[0])
    for row in payload.get("by_site", []):
        site_dict = row["site"]
        org = fhir.organization_resource(site_dict)
        measure = fhir.measure_resource(antibiotic_code=row.get("antibiotic_code", "ANY"))
        ci = fhir.wilson_ci(row["numerator"], row["denominator"]) if row["denominator"] else None
        report = fhir.measure_report_resource(
            measure_url=measure["url"],
            organization_ref=f"urn:uuid:{org['id']}",
            period_start=str(payload.get("filters", {}).get("period_start", "")),
            period_end=str(payload.get("filters", {}).get("period_end", "")),
            numerator=row["numerator"],
            denominator=row["denominator"],
            ci=ci,
            extra_strata=[
                fhir.stratifier_from_buckets(
                    "by_origin",
                    {origin: bucket.get("denominator", 0) for origin, bucket in (row.get("by_origin") or {}).items()},
                )
            ],
        )
        entries.extend([org, measure, report])
    return fhir.bundle(entries, identifier="amrit-resistance-rate")
