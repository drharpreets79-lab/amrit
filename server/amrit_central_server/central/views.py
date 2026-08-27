"""Operator-facing dashboard for the AMRIT Central Aggregation Server."""

from __future__ import annotations

import time
from datetime import timedelta

from django.core.cache import cache
from django.contrib.auth.decorators import login_required
from django.db.models import Count, Max, Q
from django.http import JsonResponse, Http404
from django.contrib import messages
from django.db import transaction
from django.shortcuts import get_object_or_404, redirect, render

from sites.enrolment import enrolment_denied
from django.utils import timezone
from django.views.decorators.http import require_http_methods
from rest_framework.decorators import api_view, permission_classes
from django.views.decorators.csrf import csrf_exempt
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework import status
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema

from queries.models import (
    PollAuditEntry,
    Query,
    QueryDispatch,
    QueryResult,
    SUPPORTED_QUERY_TYPES,
)
from sites.models import ROLE_CHOICES, Site, SiteEnrolmentRequest, _hash_token

from .roles import (
    CAP_MANAGE_SITES,
    CAP_RUN_QUERY,
    CAP_VIEW_ALL_SITES,
    CAP_VIEW_AUDIT,
    CAP_VIEW_MAP,
    CAP_VIEW_PUBLIC_SUMMARY,
    CAP_VIEW_QUERIES,
    get_profile,
    get_role,
    has_cap,
    require_cap,
    scope_sites,
)
from .site_ordering import online_first_sites


ONLINE_WINDOW = timedelta(minutes=5)
RECENT_WINDOW = timedelta(hours=24)


COMMON_ANTIBIOTICS = [
    ("AMK", "Amikacin"),
    ("CIP", "Ciprofloxacin"),
    ("CRO", "Ceftriaxone"),
    ("MEM", "Meropenem"),
    ("VAN", "Vancomycin"),
    ("GEN", "Gentamicin"),
    ("AMP", "Ampicillin"),
    ("TZP", "Piperacillin-Tazobactam"),
    ("FEP", "Cefepime"),
    ("LVX", "Levofloxacin"),
    ("CTX", "Cefotaxime"),
    ("IPM", "Imipenem"),
    ("LZD", "Linezolid"),
    ("COL", "Colistin"),
]

COMMON_ORGANISMS = [
    ("eco", "Escherichia coli"),
    ("kpn", "Klebsiella pneumoniae"),
    ("sau", "Staphylococcus aureus"),
    ("pae", "Pseudomonas aeruginosa"),
    ("aba", "Acinetobacter baumannii"),
    ("ent", "Enterococcus spp."),
    ("sty", "Salmonella Typhi"),
    ("spn", "Streptococcus pneumoniae"),
]


ORGANISMS_NAME = [
    ("ABA", "Acinetobacter baumannii"),
    ("PCE", "Burkholderia cepacia"),
    ("CFR ", "Citrobacter freundii"),
    ("ECL", "Enterobacter cloacae"),
    ("EFA", "Enterococcus faecalis"),
    ("EFM", "Enterococcus faecium"),
    ("ECO", "Escherichia coli"),
    ("KOX", "Klebsiella oxytoca"),
    ("KPN", "Klebsiella pneumoniae"),
    ("NMO", "Morganella morganii"),
    ("NGO", "Neisseria gonorrhoeae"),
    ("PMI", "Proteus mirabilis"),
    ("PAE", "Pseudomonas aeruginosa"),
    ("SAT", "Salmonella Typhi"),
    ("SMA", "Serratia marcescens"),
    ("SHB", "Shigella flexneri"),
    ("SAU", "Staphylococcus aureus"),
    ("SGC", "Streptococcus agalactiae"),
    ("SPN", "Streptococcus pneumoniae"),
    ("SPY", "Streptococcus pyogenes"),
    ("91288006", "Acinetobacter baumannii (organism)"),
    ("90272000", "Enterococcus faecium (organism)"),
    ("78065002", "Enterococcus faecalis (organism)"),
    ("56415008", "Klebsiella pneumoniae (organism)"),
    ("112283007", "Escherichia coli (organism)"),
    ("52499004", "Pseudomonas aeruginosa (organism)"),
    ("3092008", "Staphylococcus aureus (organism)"),
    ("9861002", "Streptococcus pneumoniae (organism)"),
]

COMMON_SPECIMENS = [
    ("blood", "Blood"),
    ("urine", "Urine"),
    ("sputum", "Sputum / respiratory"),
    ("wound", "Wound / pus"),
    ("csf", "CSF"),
    ("stool", "Stool"),
    ("swap", "Swap"),
    ("fluid", "Fluid"),
]


SPECIMEN_NAME = [
    ("HSP001","Blood culture bottle"),
    ("HSP002","Clean-catch urine"),
    ("HSP003","Catheter urine"),
    ("HSP004","Stool sample"),
    ("HSP005","Sputum sample"),
    ("HSP006","Endotracheal aspirate"),
    ("HSP007","Bronchoalveolar lavage"),
    ("HSP008","Wound swab"),
    ("HSP009","Pus aspirate"),
    ("HSP010","Cerebrospinal fluid"),
    ("HSP011","Pleural fluid"),
    ("HSP012","Ascitic fluid"),
    ("HSP013","Synovial fluid"),
    ("HSP014","Catheter tip"),
    ("HSP015","Tissue biopsy"),
    ("HSP016","Vaginal swab"),
    ("HSP017","Urethral swab"),
    ("HSP018","Eye swab"),
    ("HSP019","Ear swab"),
    ("HSP020","Throat swab"),
    ("119297000","Blood specimen"),
]




# --------------------------------------------------------------------------- #
# Landing / dashboard                                                         #
# --------------------------------------------------------------------------- #

@login_required
def dashboard(request):
    user = request.user
    role = get_role(user)
    now = timezone.now()
    online_threshold = now - ONLINE_WINDOW
    recent_threshold = now - RECENT_WINDOW

    visible_sites = scope_sites(user, Site.objects.all())

    site_totals = {
        "total": visible_sites.count(),
        "active": visible_sites.filter(status="active").count(),
        "online": visible_sites.filter(last_seen_at__gte=online_threshold).count(),
        "disabled": visible_sites.filter(status="disabled").count(),
        "provisioning": visible_sites.filter(status="provisioning").count(),
    }
    site_totals["offline"] = max(0, site_totals["active"] - site_totals["online"])

    # Queries — scoped by visible_sites for non-admins via dispatches.
    if has_cap(user, CAP_VIEW_QUERIES):
        # Whoever may see every site may see every query. Derived from the capability
        # rather than from a list of role names, so a deployment's own roles behave the
        # same way as the seeded ones.
        if has_cap(user, CAP_VIEW_ALL_SITES):
            query_qs = Query.objects.all()
        else:
            visible_ids = list(visible_sites.values_list("id", flat=True))
            query_qs = Query.objects.filter(dispatches__site_id__in=visible_ids).distinct()
    else:
        query_qs = Query.objects.none()

    query_totals = {
        "total": query_qs.count(),
        "queued": query_qs.filter(status="queued").count(),
        "dispatched": query_qs.filter(status="dispatched").count(),
        "partial": query_qs.filter(status="partial").count(),
        "completed": query_qs.filter(status="completed").count(),
        "expired": query_qs.filter(status="expired").count(),
        "error": query_qs.filter(status="error").count(),
        "recent": query_qs.filter(created_at__gte=recent_threshold).count(),
    }

    dispatch_qs = QueryDispatch.objects.filter(site__in=visible_sites)
    dispatch_totals = {
        s: dispatch_qs.filter(status=s).count()
        for s in ("pending", "delivered", "answered", "expired", "error")
    }

    results_24h = QueryResult.objects.filter(
        site__in=visible_sites, received_at__gte=recent_threshold
    )
    result_totals = {
        "total_24h": results_24h.count(),
        "ok_24h": results_24h.filter(ok=True).count(),
        "err_24h": results_24h.filter(ok=False).count(),
    }

    sites = list(visible_sites.order_by("-last_seen_at", "lab_code")[:10])
    for s in sites:
        s.is_online = bool(s.last_seen_at and s.last_seen_at >= online_threshold)

    recent_queries = list(
        query_qs.select_related("created_by")
        .annotate(
            dispatch_count=Count("dispatches", distinct=True),
            result_count=Count("results", distinct=True),
        )
        .order_by("-created_at")[:8]
    )

    if has_cap(user, CAP_VIEW_AUDIT):
        audit_entries = list(
            PollAuditEntry.objects.select_related("site", "query")
            .filter(Q(site__in=visible_sites) | Q(site__isnull=True))
            .order_by("-created_at")[:15]
        )
    else:
        audit_entries = []

    type_breakdown = list(
        query_qs.values("type").annotate(n=Count("id")).order_by("-n")[:8]
    )

    context = {
        "now": now,
        "site_totals": site_totals,
        "query_totals": query_totals,
        "dispatch_totals": dispatch_totals,
        "result_totals": result_totals,
        "sites": sites,
        "recent_queries": recent_queries,
        "audit_entries": audit_entries,
        "type_breakdown": type_breakdown,
        "online_window_minutes": int(ONLINE_WINDOW.total_seconds() // 60),
    }
    return render(request, "dashboard/index.html", context)


# --------------------------------------------------------------------------- #
# Sites                                                                       #
# --------------------------------------------------------------------------- #

@login_required
def sites_list(request):
    user = request.user
    role = get_role(user)
    if role == "citizen":
        return redirect("dashboard")

    now = timezone.now()
    online_threshold = now - ONLINE_WINDOW
    q = request.GET.get("q", "").strip()
    status = request.GET.get("status", "").strip()

    qs = scope_sites(user, Site.objects.all())
    if q:
        qs = qs.filter(
            Q(lab_code__icontains=q)
            | Q(name__icontains=q)
            | Q(country__icontains=q)
            # The unit's own name, and the path of codes it sits on. Searching the tree
            # rather than two columns means a site is findable by any level of its
            # hierarchy, not only by the two a single country happens to have.
            | Q(admin_unit__name__icontains=q)
            | Q(admin_path__icontains=q)
        )
    if status:
        qs = qs.filter(status=status)

    sites = list(qs.order_by("-last_seen_at", "lab_code")[:300])
    for s in sites:
        s.is_online = bool(s.last_seen_at and s.last_seen_at >= online_threshold)

    pending_requests = (
        SiteEnrolmentRequest.objects.filter(status="pending")
        if has_cap(user, CAP_MANAGE_SITES) else None
    )

    return render(
        request,
        "dashboard/sites.html",
        {
            "sites": sites,
            "q": q,
            "status": status,
            "status_choices": Site.STATUS_CHOICES,
            "now": now,
            # Decided on the registry itself, not merely announced here: a laboratory waiting
            # for approval is a laboratory whose data is not arriving, and a queue you have to
            # navigate to is a queue nobody empties. Only for operators who can act on it —
            # everyone else has no business reading a stranger's contact details and IP.
            "pending_requests": pending_requests.count() if pending_requests is not None else 0,
            # Capped: the registry is the registry, and a hundred requests belong on the
            # queue's own page. The count above still tells the truth about how many there are.
            "pending_request_list": list(pending_requests[:5]) if pending_requests is not None else [],
        },
    )
def _collect_with_pickup_token(lab_code: str, pickup: str):
    """Answer an installation collecting the token for its own approved request.

    Returns a response, or None when the pickup token matches no request for this lab code —
    which the caller reports as a flat refusal rather than saying which half was wrong.

    The four answers a waiting desktop can act on are all distinct: still waiting, declined,
    here is your token, and already collected. Told apart, the sync screen can say something
    true; the old endpoint answered every one of them with ``new_token: null``.
    """
    from sites.models import SiteEnrolmentRequest

    # The proof is one-time, so checking and redeeming it must be one locked operation.
    # Without the row lock, two requests arriving together could both see `redeemed_at=None`,
    # mint two bearer tokens, and strand whichever desktop received the first one.
    with transaction.atomic():
        enrolment = SiteEnrolmentRequest.objects.select_for_update().filter(
            lab_code=lab_code, pickup_token_hash=_hash_token(pickup)
        ).order_by("-created_at").first()
        if enrolment is None:
            return None

        if enrolment.pickup_expired():
            return Response(
                {"new_token": None, "status": "expired_token",
                 "detail": "This access request expired. Use Request access to file a fresh request."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if enrolment.status == "pending":
            return Response(
                {"new_token": None, "status": "pending",
                 "detail": "This laboratory is awaiting approval by an administrator."},
                status=status.HTTP_202_ACCEPTED,
            )
        if enrolment.status == "rejected":
            return Response(
                {"new_token": None, "status": "rejected",
                 "detail": "This laboratory's registration request was declined."},
                status=status.HTTP_403_FORBIDDEN,
            )
        if enrolment.pickup_redeemed_at is not None:
            return Response(
                {"new_token": None, "status": "already_collected",
                 "detail": "This token was already collected. Ask an administrator to reset it if "
                           "this installation still needs one."},
                status=status.HTTP_409_CONFLICT,
            )

        site = Site.objects.select_for_update().filter(
            pk=enrolment.site_id
        ).first() if enrolment.site_id else Site.objects.select_for_update().filter(
            lab_code=enrolment.lab_code
        ).first()
        if site is None or site.status != "active":
            return Response(
                {"new_token": None, "status": "unknown",
                 "detail": "This laboratory was approved but is not currently active."},
                status=status.HTTP_404_NOT_FOUND,
            )

        token = Site.issue_token()
        site.set_auth_token(token)
        site.save(update_fields=["auth_token_hash", "auth_token_prefix"])
        enrolment.pickup_redeemed_at = timezone.now()
        enrolment.save(update_fields=["pickup_redeemed_at"])
        PollAuditEntry.objects.create(
            site=site, lab_code=site.lab_code, action="token_collected",
            detail="Bearer token collected by the installation that filed the enrolment request",
        )
    return Response(
        {
            "new_token": token,
            "status": "registered",
            "lab_code": site.lab_code,
            # Said plainly, because the desktop cannot sync on the bearer token alone once a
            # site token exists, and the operator has to be told to go and get it.
            "site_token_required": bool(site.site_token_hash),
            "detail": ("Approved. A site token was also issued and is being sent to your site "
                       "administrator separately — enter it here as well before syncing."
                       if site.site_token_hash else "Approved."),
        },
        status=status.HTTP_200_OK,
    )


# @require_cap(CAP_MANAGE_SITES)
@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes([AllowAny])
def fetch_site_token(request):
    """Collect the bearer token for a site. Returned once.

    Two ways to be allowed here, and a caller needs one of them:

    * a ``pickup_token`` — the secret handed to whoever filed this laboratory's registration
      request, returned once in that response. This is the route an installation takes: it
      asks, an administrator approves, and the desktop collects with the secret it already
      holds. No enrolment secret has to be distributed to every laboratory for that to work,
      and knowing a lab code gets nobody anything.
    * the enrolment secret — the operator-side route, for a site the programme registered by
      hand rather than one that asked.

    Unauthenticated, this endpoint used to mint a *new* token for any active site and return
    it, so knowing a lab code was enough both to impersonate a laboratory and, because
    issuing rotates, to cut off the real one in the same request.

    The token is minted here rather than at approval, so no plaintext credential is ever at
    rest waiting to be collected. Pickup is single-use for the same reason a rotation is not
    idle: handing it out twice would strand whichever installation collected first.
    """
    from sites.models import SiteEnrolmentRequest

    lab_code = str(request.data.get("lab_code") or "").strip()
    pickup = str(request.data.get("pickup_token") or "").strip()

    if pickup:
        collected = _collect_with_pickup_token(lab_code, pickup)
        if collected is not None:
            return collected
        # A pickup token that matches nothing is not told which part was wrong.
        return Response(
            {"new_token": None, "status": "unknown",
             "detail": "That pickup token is not valid for this laboratory. Register again to "
                       "obtain a new one."},
            status=status.HTTP_403_FORBIDDEN,
        )

    denied = enrolment_denied(request)
    if denied is not None:
        return denied
    site = Site.objects.filter(lab_code=lab_code, status="active").first()
    if site is None:
        # Previously this returned 200 with new_token: null for every failure, so a site
        # that was awaiting approval, one that had been disabled and one whose lab code was
        # simply wrong were indistinguishable — and the desktop showed no reason at all.
        pending = SiteEnrolmentRequest.objects.filter(lab_code=lab_code, status="pending").first()
        if pending is not None:
            return Response(
                {"new_token": None, "status": "pending",
                 "detail": "This laboratory is awaiting approval by an administrator."},
                status=status.HTTP_202_ACCEPTED,
            )
        rejected = SiteEnrolmentRequest.objects.filter(lab_code=lab_code, status="rejected").first()
        if rejected is not None:
            return Response(
                {"new_token": None, "status": "rejected",
                 "detail": "This laboratory's registration request was declined."},
                status=status.HTTP_403_FORBIDDEN,
            )
        disabled = Site.objects.filter(lab_code=lab_code).first()
        detail = ("This laboratory is registered but disabled." if disabled is not None
                  else "No laboratory is registered with that code. Register it first.")
        return Response({"new_token": None, "status": "unknown", "detail": detail},
                        status=status.HTTP_404_NOT_FOUND)

    token = Site.issue_token()
    site.set_auth_token(token)
    site.save(update_fields=["auth_token_hash", "auth_token_prefix"])
    return Response({"new_token": token, "status": "registered"}, status=status.HTTP_200_OK)

# --------------------------------------------------------------------------- #
# Site registry administration                                                #
# --------------------------------------------------------------------------- #

@require_cap(CAP_MANAGE_SITES)
@require_http_methods(["GET", "POST"])
def site_create(request):
    """Register a site by hand.

    The route for a laboratory that is being set up by the programme rather than one that
    asked to join — a site added here is active immediately and still has no token until
    somebody issues one, which is a separate, deliberate act.
    """
    from .admin_forms import SiteForm

    form = SiteForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        site = form.save()
        messages.success(request, f"Registered {site.lab_code}. Issue its token to let it sync.")
        return redirect("dashboard_site_token", lab_code=site.lab_code)
    return render(request, "dashboard/site_form.html", {"form": form, "site": None})


@require_cap(CAP_MANAGE_SITES)
@require_http_methods(["GET", "POST"])
def site_edit(request, lab_code):
    from .admin_forms import SiteForm

    site = get_object_or_404(Site, lab_code=lab_code)
    form = SiteForm(request.POST or None, instance=site)
    if request.method == "POST" and form.is_valid():
        form.save()
        messages.success(request, f"Updated {site.lab_code}.")
        return redirect("dashboard_sites")
    return render(request, "dashboard/site_form.html", {"form": form, "site": site})


@require_cap(CAP_MANAGE_SITES)
@require_http_methods(["GET", "POST"])
def site_rename(request, lab_code):
    """Change the code a registered site is known by.

    Its own screen rather than a field on the edit form, for the same reason the token has
    one: this is an event, not an edit, and it should not be possible to do it by tabbing
    past a text box while changing a contact address. The new code has to be typed and the
    old one confirmed.

    This is the fix for a registry and a desktop that disagree — the case that shows up as
    ``HTTP 403 lab_code mismatch`` on the laboratory's sync screen. See
    ``Site.rename_lab_code`` for why this side moves and not the desktop.
    """
    site = get_object_or_404(Site, lab_code=lab_code)
    error = None
    if request.method == "POST":
        new_code = (request.POST.get("new_lab_code") or "").strip()
        if (request.POST.get("confirm_lab_code") or "").strip() != site.lab_code:
            error = f"Type {site.lab_code} in the confirmation box to rename it."
        else:
            try:
                site.rename_lab_code(new_code, by=request.user.get_username(),
                                     note=(request.POST.get("note") or "").strip())
            except ValueError as exc:
                error = str(exc)
            else:
                messages.success(
                    request,
                    f"Renamed {lab_code} to {site.lab_code}. Its token is unchanged, so the "
                    f"laboratory syncs as soon as its own code reads {site.lab_code}.",
                )
                return redirect("dashboard_sites")
    return render(request, "dashboard/site_rename.html", {
        "site": site,
        "error": error,
        # What a rename will carry, stated before it happens. Counted in Python because
        # JSONField __contains is unavailable on SQLite; see Site.rename_lab_code.
        "targeted_queries": sum(
            1 for q in Query.objects.exclude(target_lab_codes=[]).only("id", "target_lab_codes")
            if lab_code in (q.target_lab_codes or [])
        ),
        "result_count": site.results.count(),
        "audit_count": site.audit_entries.count(),
    })


@require_cap(CAP_MANAGE_SITES)
@require_http_methods(["GET", "POST"])
def site_delete(request, lab_code):
    """Remove a site from the registry, or disable it.

    Confirmed on its own page, with what will actually go stated on it. ``QueryResult.site``
    cascades, so removing a site **does** delete the aggregate results it reported; this page
    used to say the opposite, which is the worst way to be wrong about a destructive button.
    Where results exist the lab code has to be typed back before the removal proceeds, and
    the count is on the screen beside it.

    Disabling is offered first and is what most of these decisions actually want: the site
    stops syncing immediately and everything it reported stays joined up to it. Removal is
    for a row that should not have existed.
    """
    site = get_object_or_404(Site, lab_code=lab_code)
    result_count = site.results.count()
    error = None
    if request.method == "POST":
        if request.POST.get("action") == "disable":
            site.status = "disabled"
            site.save(update_fields=["status"])
            messages.success(request, f"{site.lab_code} disabled. It can no longer sync; its history is intact.")
            return redirect("dashboard_sites")
        if result_count and (request.POST.get("confirm_lab_code") or "").strip() != site.lab_code:
            error = (f"Type {site.lab_code} to confirm. Removing it deletes "
                     f"{result_count} aggregate result{'' if result_count == 1 else 's'} it has already reported.")
        else:
            lab = site.lab_code
            site.delete()
            messages.success(
                request,
                f"Removed {lab} from the registry"
                + (f", with {result_count} result{'' if result_count == 1 else 's'} it had reported." if result_count
                   else "."),
            )
            return redirect("dashboard_sites")
    return render(request, "dashboard/site_delete.html", {
        "site": site,
        "error": error,
        "profile_count": site.profiles.count(),
        "dispatch_count": site.dispatches.count(),
        "result_count": result_count,
    })


@require_cap(CAP_MANAGE_SITES)
def site_requests(request):
    """Laboratories that have asked to be registered, newest first."""
    status_filter = request.GET.get("status", "pending").strip()
    requests_qs = SiteEnrolmentRequest.objects.select_related("decided_by", "site")
    if status_filter:
        requests_qs = requests_qs.filter(status=status_filter)
    return render(request, "dashboard/site_requests.html", {
        "requests": list(requests_qs[:200]),
        "status": status_filter,
        "status_choices": SiteEnrolmentRequest.STATUS_CHOICES,
        "pending_count": SiteEnrolmentRequest.objects.filter(status="pending").count(),
        "settled_count": SiteEnrolmentRequest.objects.exclude(status="pending").count(),
        "collected_count": SiteEnrolmentRequest.objects.filter(
            status="approved", site__isnull=False, pickup_redeemed_at__isnull=False
        ).count(),
    })


@require_cap(CAP_MANAGE_SITES)
@require_http_methods(["POST"])
def site_requests_clear(request):
    """Remove settled registration requests from the queue.

    A request that has been approved and whose site has since collected its token is
    finished business, but it stayed on this screen for ever: the queue filled with rows
    nobody could act on, and the pending ones an administrator does have to act on were
    buried among them.

    Only settled requests are removable, and a pending one never is — clearing a request
    somebody still has to decide would silently drop a laboratory's application. Removing
    the request does not touch the site, its tokens or its data: the site is the registry
    entry, and this is only the paperwork that asked for it.

    `scope=collected` removes approved requests whose site exists and has already redeemed
    its pickup token; `scope=settled` removes every approved and declined request. A
    declined one is kept by default because "we turned this one down" is worth having the
    next time the same code appears.
    """
    scope = (request.POST.get("scope") or "collected").strip()
    back = _safe_next(request, default="dashboard_site_requests")

    queryset = SiteEnrolmentRequest.objects.exclude(status="pending")
    if scope == "collected":
        queryset = queryset.filter(status="approved", site__isnull=False, pickup_redeemed_at__isnull=False)
    elif scope != "settled":
        messages.error(request, "Unknown clear scope.")
        return redirect(back)

    lab_codes = sorted({item.lab_code for item in queryset.only("lab_code")})
    removed, _detail = queryset.delete()
    if not removed:
        messages.error(request, "There was nothing to clear.")
        return redirect(back)

    PollAuditEntry.objects.create(
        site=None,
        lab_code="",
        action="enrolment_requests_cleared",
        detail=(
            f"{removed} {scope} registration request(s) removed by {request.user.get_username()}: "
            + ", ".join(lab_codes[:50])
        )[:2000],
    )
    messages.success(request, f"Cleared {removed} settled registration request(s).")
    return redirect(back)


def _safe_next(request, *, default: str) -> str:
    """Where a form says to return to, if it is somewhere on this server.

    A posted redirect target is attacker-controllable, so an unchecked one turns any button
    on this portal into an open redirect — a link that carries the operator's trust in this
    hostname to somebody else's login page. Anything off-host falls back to the default.
    """
    from django.urls import reverse
    from django.utils.http import url_has_allowed_host_and_scheme

    candidate = (request.POST.get("next") or "").strip()
    if candidate and url_has_allowed_host_and_scheme(
        candidate, allowed_hosts={request.get_host()}, require_https=request.is_secure()
    ):
        return candidate
    return reverse(default)


@require_cap(CAP_MANAGE_SITES)
@require_http_methods(["POST"])
def site_request_decide(request, pk):
    """Approve or reject one request.

    Approving is what creates the `Site`; until then nothing about the request is part of
    the registry. It issues the out-of-band site factor and shows it once on the next
    screen. It does not mint the bearer token: the requesting installation mints and
    collects that itself with its one-time pickup proof.

    The whole thing is one transaction: a half-approved request that created a site but
    left itself pending would be approved twice by the next administrator to look.

    The buttons are on two screens — the queue and the registry list — so the caller says
    where to come back to. Approval always lands on the token screen instead, because a
    registered site that cannot sync is not finished business.
    """
    enrolment = get_object_or_404(SiteEnrolmentRequest, pk=pk)
    decision = request.POST.get("decision", "")
    note = (request.POST.get("note") or "").strip()
    back = _safe_next(request, default="dashboard_site_requests")

    if enrolment.status != "pending":
        messages.error(request, f"{enrolment.lab_code} has already been {enrolment.status}.")
        return redirect(back)

    if decision == "reject":
        enrolment.status = "rejected"
        enrolment.decided_by = request.user
        enrolment.decided_at = timezone.now()
        enrolment.decision_note = note
        enrolment.save(update_fields=["status", "decided_by", "decided_at", "decision_note"])
        messages.success(request, f"Declined {enrolment.lab_code}.")
        return redirect(back)

    if decision != "approve":
        messages.error(request, "Choose approve or decline.")
        return redirect(back)

    if Site.objects.filter(lab_code=enrolment.lab_code).exists():
        messages.error(request, f"A site is already registered as {enrolment.lab_code}.")
        return redirect(back)

    with transaction.atomic():
        site = Site(
            lab_code=enrolment.lab_code,
            name=enrolment.name or enrolment.lab_code,
            country=enrolment.country,
            country_code=enrolment.country_code,
            address=enrolment.address or {},
            contact_email=enrolment.contact_email,
            status="active",
        )
        site.admin_unit = _unit_for_request(enrolment)
        # The second factor is minted here, by the act of approving, because it does not
        # travel the enrolment channel: it is shown once on the next screen and carried to
        # the laboratory by whatever means the programme uses. The bearer token is *not*
        # minted here — the installation collects that itself with its pickup token, so no
        # plaintext credential sits at rest waiting for it.
        site_token = Site.issue_token(24)
        site.set_site_token(site_token)
        site.save()
        enrolment.status = "approved"
        enrolment.decided_by = request.user
        enrolment.decided_at = timezone.now()
        enrolment.decision_note = note
        enrolment.site = site
        enrolment.save(update_fields=["status", "decided_by", "decided_at", "decision_note", "site"])
        PollAuditEntry.objects.create(
            site=site, lab_code=site.lab_code, action="site_approved",
            detail=f"Enrolment approved by {request.user.get_username()}"
                   + (f" — {note}" if note else ""),
        )

    # Shown once, on the screen the approver is sent to. Not put in a `messages` banner: those
    # survive a redirect in the session and get re-rendered, and a credential should be on
    # exactly one page.
    request.session["amrit_issued_site_token"] = site_token
    messages.success(request, f"Approved {site.lab_code}.")
    return redirect("dashboard_site_token", lab_code=site.lab_code)


def _unit_for_request(enrolment):
    """The deepest administrative unit the request names that the tree recognises.

    Resolved at approval rather than at request time, so a request that arrived before its
    unit was loaded still places correctly once the tree catches up. Unrecognised codes
    place the site nowhere rather than somewhere wrong.
    """
    from geo.models import AdminUnit

    deepest = None
    for entry in sorted(enrolment.admin_units or [], key=lambda item: int((item or {}).get("level", 0) or 0)):
        code = str((entry or {}).get("code") or "").strip()
        level = int((entry or {}).get("level") or 0)
        if not code or not level:
            continue
        match = AdminUnit.objects.filter(level=level, code=code)
        if enrolment.country_code:
            match = match.filter(country_code=enrolment.country_code)
        found = match.first()
        if found is not None:
            deepest = found
    return deepest


@require_cap(CAP_MANAGE_SITES)
@require_http_methods(["GET", "POST"])
def site_token(request, lab_code):
    """Issue or reset either of a site's two credentials. Each shown once.

    They are reset independently because they fail independently and travel different
    channels. A bearer token reset is what you do when an installation is rebuilt or its
    stored credential is lost; it takes effect on that site's next request. A site token reset
    is what you do when the out-of-band factor is thought to have leaked, and it has to be
    conveyed to the site administrator again by whatever means the programme uses.

    Resetting either one stops that site syncing until the new value reaches it. The screen
    says so before the button is pressed, and every reset is written to the audit trail.
    """
    site = get_object_or_404(Site, lab_code=lab_code)
    new_token = None
    new_site_token = None
    # Handed over from the approval that minted it, and readable exactly once.
    issued_site_token = request.session.pop("amrit_issued_site_token", None)

    if request.method == "POST":
        which = request.POST.get("reset", "auth")
        if which == "site":
            new_site_token = Site.issue_token(24)
            site.set_site_token(new_site_token)
            site.save(update_fields=["site_token_hash", "site_token_prefix"])
            action, label = "site_token_reset", "Site token"
        else:
            new_token = Site.issue_token()
            site.set_auth_token(new_token)
            site.save(update_fields=["auth_token_hash", "auth_token_prefix"])
            action, label = "auth_token_reset", "Bearer token"
        PollAuditEntry.objects.create(
            site=site, lab_code=site.lab_code, action=action,
            detail=f"{label} reset by {request.user.get_username()}",
        )
    return render(
        request,
        "dashboard/site_token.html",
        {
            "site": site,
            "new_token": new_token,
            "new_site_token": new_site_token or issued_site_token,
            "site_token_is_from_approval": bool(issued_site_token),
        },
    )

# from django.views.decorators.clickjacking import xframe_options_exempt
@require_cap(CAP_VIEW_MAP)
# @xframe_options_sameorigin
def sites_map(request):
    if request.GET.get("embed"):
        return render(request, "dashboard/map_embed.html", {})
    return render(request, "dashboard/map.html", {})


@require_cap(CAP_VIEW_MAP)
def sites_map_json(request):
    """GeoJSON-ish list of visible sites with coordinates and where they report from."""
    user = request.user
    now = timezone.now()
    online_threshold = now - ONLINE_WINDOW
    # Every site the operator may see, not only those reporting GPS. A site that never
    # consented to send its coordinates but did record an address is still somewhere, and
    # leaving it off the map made the network look smaller than it is. What each point is
    # worth travels with it as `precision`, so the map can distinguish a building from the
    # centre of a province rather than drawing both as a dot.
    qs = scope_sites(user, Site.objects.all())
    sites = []
    for s in qs:
        point = s.map_point
        if not point:
            continue
        is_online = bool(s.last_seen_at and s.last_seen_at >= online_threshold)

        sites.append({
            "lab_code": s.lab_code,
            "name": s.name,
            "country": s.country,
            "place": s.place_label,
            "admin_path": s.admin_path,
            "status": s.status,
            "online": is_online,
            "lat": point["latitude"],
            "lon": point["longitude"],
            "precision": point.get("precision"),
            "last_seen": s.last_seen_at.isoformat() if s.last_seen_at else None,
        })

    from geo.directory import attribution

    return JsonResponse({
        "sites": sites,
        "generated_at": now.isoformat(),
        # CC BY 4.0: a resolved point is a use of the data, so the map carries the notice.
        "attribution": attribution(),
    })


# --------------------------------------------------------------------------- #
# Queries                                                                     #
# --------------------------------------------------------------------------- #

@require_cap(CAP_VIEW_QUERIES)
def queries_list(request):
    status = request.GET.get("status", "").strip()
    qtype = request.GET.get("type", "").strip()

    visible_sites = scope_sites(request.user, Site.objects.all())
    role = get_role(request.user)
    if not has_cap(request.user, CAP_VIEW_ALL_SITES):
        visible_ids = list(visible_sites.values_list("id", flat=True))
        qs = Query.objects.filter(dispatches__site_id__in=visible_ids).distinct()
    else:
        qs = Query.objects.all()

    qs = qs.select_related("created_by").annotate(
        dispatch_count=Count("dispatches", distinct=True),
        result_count=Count("results", distinct=True),
    )
    if status:
        qs = qs.filter(status=status)
    if qtype:
        qs = qs.filter(type=qtype)

    queries = list(qs.order_by("-created_at")[:200])

    return render(
        request,
        "dashboard/queries.html",
        {
            "queries": queries,
            "status": status,
            "qtype": qtype,
            "status_choices": Query.STATUS_CHOICES,
            "type_choices": SUPPORTED_QUERY_TYPES,
        },
    )


def _admin_unit_options(sites):
    """Every administrative unit the given sites sit under, outermost first.

    Built from the sites' own paths, so the list contains exactly the places that would
    narrow the selection and nothing else. Levels are read off the path rather than
    assumed, which is what makes one control cover a hierarchy of any depth.
    """
    from geo.models import AdminUnit

    prefixes: set[str] = set()
    for site in sites:
        parts = [part for part in (site.admin_path or "").split("/") if part]
        for depth in range(1, len(parts) + 1):
            prefixes.add("/".join(parts[:depth]))
    if not prefixes:
        return []
    units = AdminUnit.objects.filter(admin_path__in=prefixes).order_by("level", "name")
    return [
        {"path": unit.admin_path, "label": f"{'— ' * max(unit.level - 1, 0)}{unit.name}", "level": unit.level}
        for unit in units
    ]


def _units_covered(site_qs) -> int:
    """Distinct level-1 units the given sites report from.

    Counted from the materialised path, so it is one query and needs no join, and it is
    the same number whatever the country calls that level.
    """
    return len({path.split("/")[1] for path in site_qs.values_list("admin_path", flat=True) if path.count("/") >= 1})


def _scope_label(user) -> str:
    """What the site list in front of this operator is limited to, in their own terms."""
    if has_cap(user, CAP_VIEW_ALL_SITES):
        return "All sites"
    profile = get_profile(user)
    unit = getattr(profile, "admin_unit", None) if profile else None
    if unit is not None:
        return unit.name
    site = getattr(profile, "site", None) if profile else None
    return site.name if site else "Scoped"


@require_cap(CAP_RUN_QUERY)
@require_http_methods(["GET", "POST"])
def query_new(request):
    visible_sites = scope_sites(request.user, Site.objects.filter(status="active"))
    sites_list_for_form = online_first_sites(visible_sites)
    role = get_role(request.user)
    # One filter for the whole hierarchy instead of a "State" box and a "District" box.
    # Every unit the visible sites sit under is offered, at whatever depth it is, so this
    # form is the same in a country with one sub-national level and one with five.
    admin_unit_options = _admin_unit_options(sites_list_for_form)
    filter_scope_label = _scope_label(request.user)

    error = None
    if request.method == "POST":
        qtype = request.POST.get("type", "").strip()
        title = request.POST.get("title", "").strip()
        notes = request.POST.get("notes", "").strip()
        antibiotic = request.POST.get("antibiotic_code", "").strip()
        organism = request.POST.get("organism", "").strip()
        specimen = request.POST.get("specimen", "").strip()
        targets = request.POST.getlist("target_lab_codes")
        ttl_hours_raw = request.POST.get("ttl_hours", "24").strip()

        valid_types = {code for code, _ in SUPPORTED_QUERY_TYPES}
        if qtype not in valid_types:
            error = "Pick a valid query type."
        else:
            try:
                ttl_hours = max(1, min(168, int(ttl_hours_raw or 24)))
            except ValueError:
                ttl_hours = 24

            allowed_codes = {s.lab_code for s in sites_list_for_form}
            print("allowed_codes",allowed_codes)
            targets = [t for t in targets if t in allowed_codes]

            filters = {}
            if organism:
                filters["organism"] = organism
            if specimen:
                filters["specimen"] = specimen

            q = Query.objects.create(
                type=qtype,
                title=title or f"{dict(SUPPORTED_QUERY_TYPES).get(qtype, qtype)} request",
                notes=notes,
                target_lab_codes=targets,
                antibiotic_code=antibiotic,
                filters=filters,
                created_by=request.user,
                expires_at=timezone.now() + timedelta(hours=ttl_hours),
                status="queued",
            )

            target_qs = visible_sites
            if targets:
                target_qs = target_qs.filter(lab_code__in=targets)
            for s in target_qs:
                QueryDispatch.objects.get_or_create(query=q, site=s)
            return redirect("query_detail", pk=q.id)
   
    return render(
        request,
        "dashboard/query_new.html",
        {
            "type_choices": SUPPORTED_QUERY_TYPES,
            "antibiotics": COMMON_ANTIBIOTICS,
            "organisms": ORGANISMS_NAME,
            "specimens": COMMON_SPECIMENS,
            "available_sites": sites_list_for_form,
            "error": error,
            "form": request.POST if request.method == "POST" else {},
            "antibiotic_url":"/v1/api/trigger-filter/",
            "role": role,
            "filter_scope_label": filter_scope_label,
            "admin_unit_options": admin_unit_options,
        },
    )


@require_cap(CAP_VIEW_QUERIES)
def query_detail(request, pk):
    visible_sites = scope_sites(request.user, Site.objects.all())
    q = get_object_or_404(Query, pk=pk)

    role = get_role(request.user)
    if not has_cap(request.user, CAP_VIEW_ALL_SITES):
        visible_ids = set(visible_sites.values_list("id", flat=True))
        if not q.dispatches.filter(site_id__in=visible_ids).exists():
            raise Http404("Not visible to your role.")

    dispatches = list(q.dispatches.select_related("site").order_by("site__lab_code"))
    results = list(q.results.select_related("site").order_by("-received_at"))

    if not has_cap(request.user, CAP_VIEW_ALL_SITES):
        visible_ids = set(visible_sites.values_list("id", flat=True))
        dispatches = [d for d in dispatches if d.site_id in visible_ids]
        results = [r for r in results if r.site_id in visible_ids]

    # Aggregate numerator / denominator across results when present.
    agg = {"numerator": 0, "denominator": 0, "rate": None, "n_sites": 0}
    for r in results:
        rj = r.result_json or {}
        num = rj.get("numerator") or rj.get("resistant") or 0
        den = rj.get("denominator") or rj.get("total") or 0
        try:
            agg["numerator"] += int(num)
            agg["denominator"] += int(den)
        except (TypeError, ValueError):
            pass
        if r.ok:
            agg["n_sites"] += 1
    if agg["denominator"]:
        agg["rate"] = round(100.0 * agg["numerator"] / agg["denominator"], 2)

    return render(
        request,
        "dashboard/query_detail.html",
        {"query": q, "dispatches": dispatches, "results": results, "agg": agg},
    )


# --------------------------------------------------------------------------- #
# Audit                                                                       #
# --------------------------------------------------------------------------- #

@require_cap(CAP_VIEW_AUDIT)
def audit_list(request):
    action = request.GET.get("action", "").strip()
    lab_code = request.GET.get("lab_code", "").strip()

    visible_sites = scope_sites(request.user, Site.objects.all())
    qs = PollAuditEntry.objects.select_related("site", "query").filter(
        Q(site__in=visible_sites) | Q(site__isnull=True)
    )
    if action:
        qs = qs.filter(action=action)
    if lab_code:
        qs = qs.filter(lab_code__icontains=lab_code)

    entries = list(qs.order_by("-created_at")[:300])
    actions = list(
        PollAuditEntry.objects.values_list("action", flat=True).distinct().order_by("action")
    )
    return render(
        request,
        "dashboard/audit.html",
        {"entries": entries, "action": action, "lab_code": lab_code, "actions": actions},
    )


# --------------------------------------------------------------------------- #
# Public summary (citizen / press)                                            #
# --------------------------------------------------------------------------- #

@login_required
def public_summary(request):
    now = timezone.now()
    online_threshold = now - ONLINE_WINDOW
    site_qs = Site.objects.filter(status="active")
    completed = Query.objects.filter(status="completed")
    return render(
        request,
        "dashboard/public.html",
        {
            "now": now,
            "active_sites": site_qs.count(),
            "online_sites": site_qs.filter(last_seen_at__gte=online_threshold).count(),
            # How many reporting units are covered, at the shallowest level the deployment
            # actually uses — a count of "states" means nothing where there are none.
            "units_covered": _units_covered(site_qs),
            "completed_queries": completed.count(),
            "completed_recent": list(
                completed.order_by("-completed_at", "-created_at")[:8]
            ),
        },
    )



def trigger_desktop_filter(request):
    """On-demand live pull from one desktop site over the WebSocket bridge.

    Pushes a ``fetch_local_records`` request to the site and waits (briefly) for
    the aggregate answer it caches under the shared ``tx_id`` key. Only aggregate
    data is returned; the PII guard still screens any response body.
    """
    from .consumers import nudge_site_live  # lazy import keeps app-load light

    lab_code = request.GET.get("lab_code", "").strip()
    if not lab_code:
        return JsonResponse({"error": "A valid lab_code parameter must be provided."}, status=400)

    organism = request.GET.get("organism", "")
    specimen_type = request.GET.get("specimen_type", "")
    year = request.GET.get("year", "")
    criteria = {
        "filters": {
            "organism": organism,
            "specimen_type": specimen_type,
            "year": int(year) if year.isdigit() else None,
        }
    }

    tx_id = nudge_site_live(lab_code, criteria=criteria)

    timeout = 10  # seconds to wait for the desktop app to answer
    start_time = time.time()
    while time.time() - start_time < timeout:
        entry = cache.get(tx_id) or {}
        result = (entry.get("responses") or {}).get(lab_code)
        if result is not None:
            return JsonResponse({"status": "success", "tx_id": tx_id, "data": result})
        time.sleep(0.5)

    return JsonResponse(
        {"status": "timeout", "tx_id": tx_id,
         "error": "The desktop client did not respond within the time limit."},
        status=408,
    )


@login_required
@require_http_methods(["GET"])
def data_licences_view(request):
    """Open data and licences.

    Reachable by any signed-in user: attribution and the SNOMED CT position are
    obligations of the deployment, not privileged information.
    """
    from central.data_licences import data_licences, licence_notices

    return render(request, "dashboard/data_licences.html", {
        "datasets": data_licences(),
        "notices": licence_notices(),
    })
