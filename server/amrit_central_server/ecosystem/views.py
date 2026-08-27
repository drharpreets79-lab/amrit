import hashlib
import json
from django.contrib.auth.decorators import login_required
from django.db.models import Count, Sum
from django.shortcuts import render
from rest_framework import filters, status, viewsets
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from queries.poll_views import _authenticate
from .models import *
from .serializers import *


def profile_banned_identifier_keys() -> set[str]:
    """National identifier field names to reject, from the active country profile.

    India contributes aadhaar/abha/uhid; another country contributes its own. The generic
    entries below always apply.
    """
    try:
        from central.country_profile import get_profile

        return {str(key).lower() for key in (get_profile().get("banned_identifier_keys") or [])}
    except Exception:  # noqa: BLE001 - never let a profile problem disable the guard
        return set()


FORBIDDEN_KEYS = {"patient_name", "patient_id", "phone", "email", "address", "owner_name"}


def _contains_identifier(value):
    if isinstance(value, dict):
        banned = FORBIDDEN_KEYS | profile_banned_identifier_keys()
        return any(str(k).lower() in banned or _contains_identifier(v) for k, v in value.items())
    if isinstance(value, list): return any(_contains_identifier(v) for v in value)
    return False


def viewset_for(model, serializer, search=()):
    attrs = {"queryset": model.objects.all(), "serializer_class": serializer,
             "permission_classes": [IsAuthenticated], "filter_backends": [filters.SearchFilter, filters.OrderingFilter],
             "search_fields": list(search), "ordering_fields": "__all__"}
    return type(model.__name__ + "ViewSet", (viewsets.ModelViewSet,), attrs)


OrganizationViewSet = viewset_for(Organization, OrganizationSerializer, ("code", "name"))
DeviceRegistrationViewSet = viewset_for(DeviceRegistration, DeviceRegistrationSerializer, ("device_key", "site__lab_code"))
DataProductViewSet = viewset_for(DataProduct, DataProductSerializer, ("module_key", "site__lab_code", "contract"))
TerminologyReleaseViewSet = viewset_for(TerminologyRelease, TerminologyReleaseSerializer, ("package_type", "version"))
AlertCaseViewSet = viewset_for(AlertCase, AlertCaseSerializer, ("code", "title", "scope_value"))
JointRiskAssessmentViewSet = viewset_for(JointRiskAssessment, JointRiskAssessmentSerializer, ("title", "hazard", "geography"))
ProgrammeMilestoneViewSet = viewset_for(ProgrammeMilestone, ProgrammeMilestoneSerializer, ("objective_code", "title", "admin_path"))
AccessRequestViewSet = viewset_for(AccessRequest, AccessRequestSerializer, ("purpose", "legal_basis"))
ReportingRunViewSet = viewset_for(ReportingRun, ReportingRunSerializer, ("report_type", "period"))


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT, 201: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes([AllowAny])
def ingest_product(request):
    site = _authenticate(request)
    if site is None: return Response({"error": "unauthorized"}, status=status.HTTP_401_UNAUTHORIZED)
    payload = request.data.get("payload") or request.data
    if _contains_identifier(payload): return Response({"error": "direct identifiers are prohibited in national data products"}, status=400)
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(encoded.encode()).hexdigest()
    product, created = DataProduct.objects.get_or_create(
        site=site, module_key=request.data.get("module") or payload.get("module", "unknown"), payload_sha256=digest,
        defaults={"sector": request.data.get("sector", "cross_sector"), "contract": payload.get("contract", "national-amr-data-product/1.0"),
                  "payload_json": payload, "record_count": payload.get("record_count", 0), "quality_json": payload.get("quality", {}),
                  "lineage_json": request.data.get("lineage", {})})
    return Response({"id": str(product.id), "created": created, "sha256": digest}, status=201 if created else 200)


@login_required
def workbench(request):
    context = {
        "product_count": DataProduct.objects.count(), "site_count": DataProduct.objects.values("site_id").distinct().count(),
        "open_alerts": AlertCase.objects.exclude(state__in=("closed", "dismissed")).count(),
        "milestone_count": ProgrammeMilestone.objects.count(), "pending_access": AccessRequest.objects.filter(status="submitted").count(),
        "sector_counts": DataProduct.objects.values("sector").annotate(total=Count("id")).order_by("sector"),
        "recent_products": DataProduct.objects.select_related("site")[:10],
        "recent_alerts": AlertCase.objects.exclude(state__in=("closed", "dismissed")).order_by("-created_at")[:8],
        "milestones": ProgrammeMilestone.objects.select_related("owner_organization").order_by("due_at")[:8],
    }
    return render(request, "ecosystem/workbench.html", context)


def transparency_portal(request):
    published = DataProduct.objects.filter(status="published")
    return render(request, "ecosystem/public.html", {
        "product_count": published.count(), "sector_counts": published.values("sector").annotate(total=Count("id")).order_by("sector"),
        "products": published.select_related("site").order_by("-received_at")[:50],
    })
