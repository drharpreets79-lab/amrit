from django.templatetags.static import static

from .privacy import k_anonymity_floor, residency_note
from .country_profile import ProfileError
from .country_profile import get_profile as get_country_profile
from .roles import (
    CAP_MANAGE_ACTION_PLANS,
    CAP_MANAGE_SITES,
    CAP_MANAGE_USERS,
    CAP_RUN_QUERY,
    CAP_TRACK_ACTION_POINTS,
    CAP_VIEW_ADVANCED_DASHBOARD,
    CAP_VIEW_ALL_SITES,
    CAP_VIEW_AUDIT,
    CAP_VIEW_BASIC_DASHBOARD,
    CAP_VIEW_DASHBOARD,
    CAP_VIEW_MAP,
    CAP_VIEW_OWN_SITE,
    CAP_VIEW_PUBLIC_SUMMARY,
    CAP_VIEW_QUERIES,
    CAP_VIEW_SCOPED_SITES,
    dashboard_for_role,
    get_profile,
    get_role,
    has_cap,
)


def _logo_source(country) -> str:
    """Where the header emblem comes from, or "" for none.

    An uploaded logo is stored as a data URI and is used as-is. A profile that names a
    bundled file gets that file from static. A deployment that has neither gets **nothing** —
    the header falls back to the authority's name in text, because showing one country's
    emblem above another country's data is worse than showing no emblem. The portal header
    used to hardcode a single national emblem for every deployment on earth.
    """
    branding = (country or {}).get("branding") or {}
    logo = str(branding.get("logo") or "").strip()
    if not logo:
        return ""
    if logo.startswith("data:"):
        return logo
    try:
        return static(f"img/{logo}")
    except Exception:  # noqa: BLE001 - a missing static file must not break every page
        return ""


def _pending_site_requests(can_manage_sites: bool) -> int:
    """How many laboratories are waiting to be let in.

    In the header rather than only on the registry page, because a laboratory awaiting a
    decision is a laboratory whose data is not arriving, and a queue you have to go looking
    for is a queue nobody empties. Only counted for operators who could act on it.
    """
    if not can_manage_sites:
        return 0
    try:
        from sites.models import SiteEnrolmentRequest

        return SiteEnrolmentRequest.objects.filter(status="pending").count()
    except Exception:  # noqa: BLE001 - a badge must never take a page down
        return 0


def amrit_context(request):
    user = getattr(request, "user", None)
    profile = get_profile(user)
    role = get_role(user) if user and user.is_authenticated else None
    caps = {
        "view_dashboard": has_cap(user, CAP_VIEW_DASHBOARD),
        "view_all_sites": has_cap(user, CAP_VIEW_ALL_SITES),
        "view_scoped_sites": has_cap(user, CAP_VIEW_SCOPED_SITES),
        "view_own_site": has_cap(user, CAP_VIEW_OWN_SITE),
        "view_map": has_cap(user, CAP_VIEW_MAP),
        "run_query": has_cap(user, CAP_RUN_QUERY),
        "view_queries": has_cap(user, CAP_VIEW_QUERIES),
        "view_audit": has_cap(user, CAP_VIEW_AUDIT),
        "manage_users": has_cap(user, CAP_MANAGE_USERS),
        "manage_sites": has_cap(user, CAP_MANAGE_SITES),
        "view_public_summary": has_cap(user, CAP_VIEW_PUBLIC_SUMMARY),
        "view_basic_dashboard": has_cap(user, CAP_VIEW_BASIC_DASHBOARD),
        "view_advanced_dashboard": has_cap(user, CAP_VIEW_ADVANCED_DASHBOARD),
        "manage_action_plans": has_cap(user, CAP_MANAGE_ACTION_PLANS),
        "track_action_points": has_cap(user, CAP_TRACK_ACTION_POINTS),
    }
    # amrit_profile is the signed-in user's profile; amrit_country is the deployment's
    # country profile. Templates need both, so keep the names distinct.
    try:
        country = get_country_profile()
    except ProfileError:
        # A misconfigured profile must never take the whole site down; templates fall
        # back to their existing hardcoded text until Phase 6 consumes this.
        country = None

    return {
        "amrit_logo": _logo_source(country),
        "amrit_pending_site_requests": _pending_site_requests(caps["manage_sites"]),
        "amrit_profile": profile,
        "amrit_role": role,
        "amrit_role_label": (profile.role_label if profile else None),
        "amrit_caps": caps,
        "amrit_dashboard": dashboard_for_role(role or ""),
        "amrit_country": country,
        # Phase 12: a public page that suppresses small cells has to say so, and a
        # deployment that states where its data is held has to be able to show it.
        "amrit_k_anonymity_floor": k_anonymity_floor(),
        "amrit_residency_note": residency_note(),
    }
