from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import filters, viewsets
from rest_framework.decorators import action
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response
from django.views.decorators.csrf import csrf_exempt
from django.http import JsonResponse
from .enrolment import enrolment_denied
from .models import Site, SiteEnrolmentRequest
from .serializers import SiteSerializer

from rest_framework import status
from rest_framework.permissions import AllowAny
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema

# Distinct laboratories one caller may file requests for in an hour. Generous for a real
# deployment — a laboratory registers once — and low enough that the approval queue cannot be
# filled faster than a person can read it.
ENROLMENT_REQUESTS_PER_HOUR = 10


def _caller_ip(request) -> str:
    """Return the proxy-asserted address only in an explicitly proxied deployment."""
    from django.conf import settings

    if settings.AMRIT_TRUST_PROXY_HEADERS:
        forwarded = (request.META.get("HTTP_X_FORWARDED_FOR") or "").split(",")[0].strip()
        if forwarded:
            return forwarded
    return request.META.get("REMOTE_ADDR") or "unknown"


class SiteViewSet(viewsets.ModelViewSet):
    queryset = Site.objects.all()
    serializer_class = SiteSerializer
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ["lab_code", "country", "country_code", "admin_unit", "admin_path", "status", "lab_domain"]
    search_fields = ["lab_code", "name", "country", "admin_path"]
    ordering_fields = ["lab_code", "name", "last_seen_at", "created_at"]
    ordering = ["lab_code"]

    @action(detail=True, methods=["post"])
    def rotate_token(self, request, pk=None):
        site = self.get_object()
        token = Site.issue_token()
        site.set_auth_token(token)
        site.save(update_fields=["auth_token_hash", "auth_token_prefix"])
        return Response({"lab_code": site.lab_code, "auth_token": token})

def _register_site(request):
    """Shared body for the v1 and v2 registration endpoints.

    A client states where it reports from as ``admin_units`` — ``[{level, code}]`` at any
    depth — and where its building is as ``address``, a structured postal address. Neither
    names a level, so the same request shape works for a country with one sub-national
    level and a country with five.
    """
    from geo.address import AddressError, clean_address
    from geo.models import AdminUnit

    lab_code = str(request.data.get("lab_code") or "").strip()
    if not lab_code:
        return None, Response({"error": "lab_code is required."}, status=status.HTTP_400_BAD_REQUEST)

    name = str(request.data.get("laboratory_name") or request.data.get("name") or "").strip()
    country_code = str(request.data.get("country_code") or "").strip().upper()

    defaults = {"name": name, "country": str(request.data.get("country") or "").strip()}
    if country_code:
        defaults["country_code"] = country_code

    try:
        address = clean_address(request.data.get("address"), country_code=country_code)
    except AddressError as error:
        return None, Response({"error": str(error)}, status=status.HTTP_400_BAD_REQUEST)
    if address:
        defaults["address"] = address

    # The deepest level the tree recognises wins, so a client that sends its whole chain
    # and one that sends only its lowest unit land on the same place.
    deepest = None
    admin_units = request.data.get("admin_units") or []
    if isinstance(admin_units, list):
        for entry in sorted(admin_units, key=lambda item: int((item or {}).get("level", 0) or 0)):
            code = str((entry or {}).get("code") or "").strip()
            level = int((entry or {}).get("level") or 0)
            if not code or not level:
                continue
            match = AdminUnit.objects.filter(level=level, code=code)
            if country_code:
                match = match.filter(country_code=country_code)
            found = match.first()
            if found is not None:
                deepest = found
    if deepest is not None:
        defaults["admin_unit"] = deepest

    existing = Site.objects.filter(lab_code=lab_code).first()
    if existing is None:
        # An unrecognised laboratory does not get itself into the registry: it files a
        # request, and someone with manage_sites decides.
        #
        # Asking needs no enrolment secret, because asking achieves nothing on its own. The
        # row it creates grants no access, issues no credential and is visible only to
        # operators who could approve it — the human decision *is* the gate. Requiring a
        # shared secret here would mean handing the same secret to every laboratory in the
        # programme, which is a worse thing to protect than a queue entry. Throttled per
        # caller so an open door is not also a megaphone.
        throttled = _enrolment_throttled(request, lab_code)
        if throttled is not None:
            return None, throttled
        pending = _queue_enrolment(request, lab_code, defaults, admin_units)
        return (pending, None), None

    # Editing a registry row that already exists is a different act, and this is the path
    # that could overwrite a live site's name and geography. That one keeps the secret.
    denied = enrolment_denied(request)
    if denied is not None:
        return None, denied

    for field, value in defaults.items():
        setattr(existing, field, value)
    existing.save()
    return (existing, False), None


def _enrolment_throttled(request, lab_code: str):
    """Refuse a caller filing requests for many different laboratories in quick succession.

    A refreshed request for one lab code is normal — a desktop waiting for a decision retries,
    and refreshing is exactly what it should do. A single caller opening request after request
    under *new* codes is not, and would leave an administrator scrolling a queue of noise
    looking for the real laboratory. Counted per caller and per hour.
    """
    from django.core.cache import cache

    caller = _caller_ip(request)
    if SiteEnrolmentRequest.objects.filter(lab_code=lab_code, status="pending").exists():
        return None  # A refresh of a request that already exists costs nothing.
    key = f"amrit:enrolment-requests:{caller}"
    try:
        seen = int(cache.get(key) or 0)
    except (TypeError, ValueError):  # pragma: no cover - a corrupt cache entry must not block enrolment
        seen = 0
    if seen >= ENROLMENT_REQUESTS_PER_HOUR:
        return Response(
            {"error": "Too many registration requests from this address.",
             "detail": "Wait an hour, or ask the programme to register this laboratory directly."},
            status=status.HTTP_429_TOO_MANY_REQUESTS,
        )
    cache.set(key, seen + 1, 3600)
    return None


def _queue_enrolment(request, lab_code, defaults, admin_units):
    """Record, or refresh, this laboratory's request to be registered.

    Refreshed rather than duplicated: a desktop that retries — and one waiting for its
    token retries steadily — must not bury the queue under one row per attempt. A request
    already decided is left alone and a new pending one is opened, so a laboratory turned
    down once can ask again and the earlier decision stays on the record.

    Each filing mints a fresh pickup token, returned once to the caller and kept only as a
    hash. Refreshing therefore invalidates the previous one — the installation currently
    asking is the one that will be able to collect, and a stale copy of an old request cannot
    be replayed later to pick up a credential.
    """
    caller = _caller_ip(request)
    fields = {
        "name": defaults.get("name", ""),
        "country": defaults.get("country", ""),
        "country_code": defaults.get("country_code", ""),
        "address": defaults.get("address", {}) or {},
        "admin_units": admin_units if isinstance(admin_units, list) else [],
        "contact_email": str(request.data.get("contact_email") or "").strip(),
        "app_version": str(request.data.get("app_version") or "").strip()[:32],
        "source_ip": caller if caller != "unknown" else None,
    }
    pending = SiteEnrolmentRequest.objects.filter(lab_code=lab_code, status="pending").first()
    if pending is None:
        pending = SiteEnrolmentRequest(lab_code=lab_code, **fields)
    else:
        for field, value in fields.items():
            setattr(pending, field, value)
    # Held on the instance for this response only; the model stores the hash.
    pending.issued_pickup_token = pending.issue_pickup_token()
    pending.save()
    return pending


def _pickup_contract(pending):
    """Device-style polling instructions returned with the one-time pickup secret."""
    remaining = 0
    if pending.pickup_expires_at:
        remaining = max(0, int((pending.pickup_expires_at - pending.updated_at).total_seconds()))
    return {
        "pickup_token": pending.issued_pickup_token,
        "interval": 5,
        "expires_in": remaining,
        "pickup_expires_at": pending.pickup_expires_at.isoformat() if pending.pickup_expires_at else None,
    }


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT, 202: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes([AllowAny])
def create_labcode(request):
    """Ask to be registered, or update a site the registry already has.

    An unknown lab code files a request for approval and needs no credential to do so. An
    existing one is an edit to the registry and requires the enrolment secret. See
    ``_register_site`` and sites/enrolment.py.
    """
    result, error = _register_site(request)
    if error is not None:
        return error
    subject, created = result
    if isinstance(subject, SiteEnrolmentRequest):
        return Response(
            {
                "message": "Registration requested; awaiting approval.",
                "status": "pending",
                # Keep this. It is the only way this installation will be able to collect its
                # token once somebody approves the request, and it is not stored in
                # recoverable form here.
                **_pickup_contract(subject),
            },
            status=status.HTTP_202_ACCEPTED,
        )
    message = "Labcode created successfully" if created else "Labcode Updated"
    return Response({"message": message}, status=status.HTTP_200_OK)


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT, 202: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes([AllowAny])
def register_site(request):
    """Country-neutral registration for newer clients.

    Accepts country_code and admin_units [{level, code}] at any depth, and returns what
    the server actually stored so a client can confirm its geography was understood.

    This is the endpoint an installation's "Request access" reaches. Filing a request needs no
    secret — approval is the gate — and the response carries the one-time pickup token that
    collects the bearer token afterwards.
    """
    result, error = _register_site(request)
    if error is not None:
        return error
    subject, created = result
    if isinstance(subject, SiteEnrolmentRequest):
        # 202, not 201: nothing has been registered. The client should keep its
        # configuration and try for a token again once somebody has decided.
        return Response(
            {
                "lab_code": subject.lab_code,
                "status": "pending",
                "detail": "This laboratory is not registered. The request is awaiting approval by an administrator.",
                "requested_at": subject.created_at.isoformat(),
                # Store this: it is what collects the bearer token after approval, it is
                # returned only here, and filing the request again replaces it.
                **_pickup_contract(subject),
            },
            status=status.HTTP_202_ACCEPTED,
        )
    site = subject
    return Response(
        {
            "lab_code": site.lab_code,
            "created": created,
            "status": "registered",
            "country_code": site.country_code,
            "admin_unit": site.admin_unit_id,
            "admin_path": site.admin_path,
            "address": site.address,
        },
        status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
    )

