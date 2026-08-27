import time
import uuid
import secrets
import string
from django.core.cache import cache
from django.http import JsonResponse
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync

from django.conf import settings
from django.db.models import Q
from django.utils import timezone
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import filters, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from sites.models import Site
from central.scopes import scope_for_level, site_scope_q
from central.roles import CAP_RUN_QUERY, get_role, require_cap, scope_sites
from queries.poll_views import _authenticate, _lab_code_mismatch, unauthorized
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from .models import PollAuditEntry, Query, QueryDispatch
from .serializers import (
    PollAuditEntrySerializer,
    QueryDispatchSerializer,
    QueryResultSerializer,
    QuerySerializer,
)

import zlib
import json
import logging
from django.contrib.auth import get_user_model


User = get_user_model()
logger = logging.getLogger(__name__)

class QueryViewSet(viewsets.ModelViewSet):
    queryset = Query.objects.all().prefetch_related("dispatches", "results", "results__site")
    serializer_class = QuerySerializer
    filter_backends = [DjangoFilterBackend, filters.OrderingFilter, filters.SearchFilter]
    filterset_fields = ["type", "status", "antibiotic_code", "created_by"]
    search_fields = ["title", "notes", "antibiotic_code"]
    ordering_fields = ["created_at", "completed_at"]
    ordering = ["-created_at"]

    def perform_create(self, serializer):
        ttl = self.request.data.get("ttl_seconds")
        try:
            ttl = int(ttl) if ttl is not None else settings.AMRIT_QUERY_TTL_SECONDS
        except (TypeError, ValueError):
            ttl = settings.AMRIT_QUERY_TTL_SECONDS
        expires_at = timezone.now() + timezone.timedelta(seconds=max(60, ttl))
        instance = serializer.save(created_by=self.request.user, expires_at=expires_at)

        target_codes = instance.target_lab_codes or []
        if target_codes:
            sites = Site.objects.filter(status="active", lab_code__in=target_codes)
            QueryDispatch.objects.bulk_create(
                [QueryDispatch(query=instance, site=site) for site in sites],
                ignore_conflicts=True,
            )

    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        query = self.get_object()
        query.status = "cancelled"
        query.save(update_fields=["status"])
        QueryDispatch.objects.filter(query=query, status="pending").update(status="expired")
        return Response({"status": "cancelled"})

    @action(detail=True, methods=["get"])
    def results(self, request, pk=None):
        query = self.get_object()
        serializer = QueryResultSerializer(query.results.all(), many=True)
        return Response(serializer.data)

    @action(detail=True, methods=["get"])
    def dispatches(self, request, pk=None):
        query = self.get_object()
        serializer = QueryDispatchSerializer(query.dispatches.select_related("site").all(), many=True)
        return Response(serializer.data)


class PollAuditViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = PollAuditEntry.objects.select_related("site", "query").all()
    serializer_class = PollAuditEntrySerializer
    filter_backends = [DjangoFilterBackend, filters.OrderingFilter, filters.SearchFilter]
    filterset_fields = ["lab_code", "action", "site"]
    search_fields = ["lab_code", "action", "detail", "error"]
    ordering_fields = ["created_at"]
    ordering = ["-created_at"]


# @csrf_exempt
# @require_http_methods(["GET"])
def token_code_verify(request):
    print("token_code_verify calling")
    site = _authenticate(request)
    
    if site is None:
        return unauthorized()

    mismatch = _lab_code_mismatch(site, request.GET.get("lab_code", "").strip())
    if mismatch is not None:
        return mismatch

    return JsonResponse({"error": "Ready device to connect."},status=204)

# @api_view(['GET'])
# @permission_classes([IsAuthenticated])
@require_cap(CAP_RUN_QUERY)
def trigger_desktop_filter(request):
    lab_code_filter = request.GET.getlist('target_lab_codes', '') 
    visible_sites = scope_sites(request.user, Site.objects.filter(status="active"))
    # Narrowing is by place in the tree, never by a level's name: an ``admin_path`` prefix
    # selects a unit and everything under it at any depth, and matching codes rather than
    # names is what makes it work for units whose names are not ASCII.
    admin_path = request.GET.get("admin_path", "").strip()
    if admin_path:
        visible_sites = visible_sites.filter(
            Q(admin_path=admin_path) | Q(admin_path__startswith=f"{admin_path}/")
        )
    admin_code = request.GET.get("admin_code", "").strip()
    admin_level_param = request.GET.get("admin_level", "").strip()
    if admin_code and admin_level_param.isdigit():
        visible_sites = visible_sites.filter(site_scope_q(scope_for_level(int(admin_level_param)), admin_code))
    allowed_codes = set(visible_sites.values_list("lab_code", flat=True))
    requested_codes = {code.strip() for code in lab_code_filter if code.strip()}
    if requested_codes - allowed_codes:
        return JsonResponse({"error": "One or more labs are outside your role scope."}, status=403)
    selected_codes = sorted(requested_codes or allowed_codes)
    if not selected_codes:
        return JsonResponse({"error": "No active sites are available in your role scope."}, status=400)
        
    channel_layer = get_channel_layer()


    # 2. Parallel Connection Filter Checklist
    online_labs = []
    offline_labs = []
    
    for clean_lab in selected_codes:
        group_name = f"desktop_user_{clean_lab}"
        is_online = Site.objects.filter(lab_code=clean_lab, is_online=True).exists()
        try:
            if not is_online and "groups" in channel_layer.extensions:
                # active_channels = async_to_sync(channel_layer.extensions["groups"].get_channels)(group_name)
                active_channels = async_to_sync(channel_layer.groups.get_channels)(group_name)
                if active_channels and len(active_channels) > 0:
                    is_online = True
            elif not is_online:
                # Fallback to cache lookup if "groups" isn't an active extension
                is_online = cache.get(f"status_lab_{clean_lab}") == "online"
        except AttributeError:
            is_online = is_online or cache.get(f"status_lab_{clean_lab}") == "online"
        (online_labs if is_online else offline_labs).append(clean_lab)
            
    # 3. Setup a single global cache tracking bucket for this web request transaction
    tx_id = f"tx_multi_{uuid.uuid4().hex[:8]}"
    cache.set(tx_id, {"expected_count": len(online_labs), "responses": {}}, timeout=30)

    # 4. SIMULTANEOUS BROADCAST: Trigger all online clients in parallel
    allowed_filter_names = {
        "organism_code", "specimen_type", "year", "period_start", "period_end",
        "antibiotic_code", "result", "sex", "age_band", "location_type",
        "ward_type", "patient_type",
    }
    filter_criteria = {name: request.GET.get(name, "").strip() for name in allowed_filter_names}
    filter_criteria["lab_code"] = online_labs
    
    # Create the filter structured command
    
    for lab in online_labs:
        async_to_sync(channel_layer.group_send)(
            f"desktop_user_{lab}",
            {
                "type": "forward_filter_request",
                "criteria": filter_criteria,
                "tx_id": tx_id
            }
        )

    aggregated_records = []
    max_wait = 4.0  # Seconds max execution limit
    interval = 0.2

    for _ in range(int(max_wait / interval)):
        tx_data = cache.get(tx_id)
        # duration = time.time() - start_time
        if tx_data:
            responses = tx_data.get("responses", {})
            
            # Check if every single online lab has delivered its records
            if len(responses) == len(online_labs):
                break
        time.sleep(interval)

    # 6. Read the final results map and merge array entries together
    final_tx_data = cache.get(tx_id)
    if final_tx_data:
        for lab, records in final_tx_data.get("responses", {}).items():
            for row in records:
                row["origin_lab"] = lab  # Append source tracking variable metadata tag
                aggregated_records.append(row)

    # Clean up memory layer
    cache.delete(tx_id)

    return JsonResponse({
        "success": True,
        "role": get_role(request.user),
        "scope_lab_count": len(allowed_codes),
        "total_records_fetched": len(aggregated_records),
        "data": aggregated_records,
        "offline_labs_skipped": offline_labs
    })
