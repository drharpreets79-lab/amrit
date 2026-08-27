"""Role-based access helpers for the AMRIT Central operator portal."""

from __future__ import annotations

from functools import wraps

from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied
from django.db.models import Q



# Capability flags — checked by views/templates.
CAP_VIEW_DASHBOARD = "view_dashboard"
CAP_VIEW_ALL_SITES = "view_all_sites"
CAP_VIEW_SCOPED_SITES = "view_scoped_sites"
CAP_VIEW_OWN_SITE = "view_own_site"
CAP_VIEW_MAP = "view_map"
CAP_RUN_QUERY = "run_query"
CAP_VIEW_QUERIES = "view_queries"
CAP_VIEW_AUDIT = "view_audit"
CAP_MANAGE_USERS = "manage_users"
CAP_MANAGE_SITES = "manage_sites"
CAP_VIEW_PUBLIC_SUMMARY = "view_public_summary"
# Stakeholder dashboards + action tracking.
CAP_VIEW_BASIC_DASHBOARD = "view_basic_dashboard"
CAP_VIEW_ADVANCED_DASHBOARD = "view_advanced_dashboard"
CAP_MANAGE_ACTION_PLANS = "manage_action_plans"   # author / issue / assign
CAP_TRACK_ACTION_POINTS = "track_action_points"   # update status / file ATR
# Deliberately separate from CAP_MANAGE_USERS: editing the identifier namespace changes
# what every downstream FHIR consumer sees, which is not the same authority as adding a user.
CAP_MANAGE_DEPLOYMENT = "manage_deployment"

ALL_CAPABILITIES = (
    CAP_VIEW_DASHBOARD, CAP_VIEW_ALL_SITES, CAP_VIEW_SCOPED_SITES, CAP_VIEW_OWN_SITE,
    CAP_VIEW_MAP, CAP_RUN_QUERY, CAP_VIEW_QUERIES, CAP_VIEW_AUDIT, CAP_MANAGE_USERS,
    CAP_MANAGE_SITES, CAP_VIEW_PUBLIC_SUMMARY, CAP_VIEW_BASIC_DASHBOARD,
    CAP_VIEW_ADVANCED_DASHBOARD, CAP_MANAGE_ACTION_PLANS, CAP_TRACK_ACTION_POINTS,
    CAP_MANAGE_DEPLOYMENT,
)


# Which stakeholder dashboard a role lands on ("" = ops overview / public only).
ROLE_DASHBOARD = {
    "super_admin": "country",
    "programme_admin": "country",
    "policy_maker": "country",
    "researcher": "epidemiologist",
    "epidemiologist": "epidemiologist",
    "public_health_expert": "country",
    # One administrative dashboard for every sub-national level: it takes its level, its
    # title and what it ranks from the viewer's own unit, so a country with five levels
    # needs no five dashboards and a country with one needs no district it does not have.
    "admin_officer": "admin",
    "hospital_admin": "hospital",
    "press": "",
    "citizen": "",
}


ROLE_CAPS = {
    "super_admin": {
        CAP_VIEW_DASHBOARD, CAP_VIEW_ALL_SITES, CAP_VIEW_MAP, CAP_RUN_QUERY,
        CAP_VIEW_QUERIES, CAP_VIEW_AUDIT, CAP_MANAGE_USERS, CAP_MANAGE_SITES,
        CAP_VIEW_PUBLIC_SUMMARY,
        CAP_VIEW_BASIC_DASHBOARD, CAP_VIEW_ADVANCED_DASHBOARD,
        CAP_MANAGE_ACTION_PLANS, CAP_TRACK_ACTION_POINTS,
        # Only super_admin by default; see CAP_MANAGE_DEPLOYMENT.
        CAP_MANAGE_DEPLOYMENT,
    },
    "programme_admin": {
        CAP_VIEW_DASHBOARD, CAP_VIEW_ALL_SITES, CAP_VIEW_MAP, CAP_RUN_QUERY,
        CAP_VIEW_QUERIES, CAP_VIEW_AUDIT, CAP_MANAGE_SITES,
        CAP_VIEW_PUBLIC_SUMMARY,
        CAP_VIEW_BASIC_DASHBOARD, CAP_VIEW_ADVANCED_DASHBOARD,
        CAP_MANAGE_ACTION_PLANS, CAP_TRACK_ACTION_POINTS,
    },
    "policy_maker": {
        CAP_VIEW_DASHBOARD, CAP_VIEW_ALL_SITES, CAP_VIEW_MAP, CAP_VIEW_QUERIES,
        CAP_VIEW_PUBLIC_SUMMARY,
        CAP_VIEW_BASIC_DASHBOARD, CAP_VIEW_ADVANCED_DASHBOARD,
        CAP_MANAGE_ACTION_PLANS, CAP_TRACK_ACTION_POINTS,
    },
    "researcher": {
        CAP_VIEW_DASHBOARD, CAP_VIEW_ALL_SITES, CAP_VIEW_MAP, CAP_RUN_QUERY,
        CAP_VIEW_QUERIES, CAP_VIEW_PUBLIC_SUMMARY,
        CAP_VIEW_BASIC_DASHBOARD, CAP_VIEW_ADVANCED_DASHBOARD,
        CAP_TRACK_ACTION_POINTS,
    },
    "epidemiologist": {
        CAP_VIEW_DASHBOARD, CAP_VIEW_ALL_SITES, CAP_VIEW_MAP, CAP_RUN_QUERY,
        CAP_VIEW_QUERIES, CAP_VIEW_AUDIT, CAP_VIEW_PUBLIC_SUMMARY,
        CAP_VIEW_BASIC_DASHBOARD, CAP_VIEW_ADVANCED_DASHBOARD,
        CAP_MANAGE_ACTION_PLANS, CAP_TRACK_ACTION_POINTS,
    },
    "public_health_expert": {
        CAP_VIEW_DASHBOARD, CAP_VIEW_ALL_SITES, CAP_VIEW_MAP, CAP_RUN_QUERY,
        CAP_VIEW_QUERIES, CAP_VIEW_PUBLIC_SUMMARY,
        CAP_VIEW_BASIC_DASHBOARD, CAP_VIEW_ADVANCED_DASHBOARD,
        CAP_MANAGE_ACTION_PLANS, CAP_TRACK_ACTION_POINTS,
    },
    "admin_officer": {
        CAP_VIEW_DASHBOARD, CAP_VIEW_SCOPED_SITES, CAP_VIEW_MAP, CAP_RUN_QUERY,
        CAP_VIEW_QUERIES, CAP_VIEW_PUBLIC_SUMMARY,
        CAP_VIEW_BASIC_DASHBOARD, CAP_VIEW_ADVANCED_DASHBOARD,
        CAP_MANAGE_ACTION_PLANS, CAP_TRACK_ACTION_POINTS,
    },
    "hospital_admin": {
        CAP_VIEW_DASHBOARD, CAP_VIEW_OWN_SITE, CAP_RUN_QUERY, CAP_VIEW_QUERIES,
        CAP_VIEW_PUBLIC_SUMMARY,
        CAP_VIEW_BASIC_DASHBOARD, CAP_VIEW_ADVANCED_DASHBOARD,
        CAP_TRACK_ACTION_POINTS,
    },
    "press": {
        CAP_VIEW_DASHBOARD, CAP_VIEW_PUBLIC_SUMMARY,
    },
    "citizen": {
        CAP_VIEW_PUBLIC_SUMMARY,
    },
}


def get_profile(user):
    if not user or not user.is_authenticated:
        return None
    if user.is_superuser:
        return _SuperAdminProfile(user)
    return getattr(user, "amrit_profile", None)


def get_role(user) -> str:
    if user and user.is_superuser:
        return "super_admin"
    p = get_profile(user)
    return p.role if p else "citizen"


def has_cap(user, cap: str) -> bool:
    role = get_role(user)
    definition = get_role_definition(role)
    if definition is not None:
        return cap in set(definition.capabilities or [])
    return cap in ROLE_CAPS.get(role, set())


def get_role_definition(role: str):
    """Resolve editable role config; tolerate pre-migration/startup states."""
    try:
        from sites.models import RoleDefinition
        return RoleDefinition.objects.filter(slug=role, is_active=True).first()
    except Exception:
        return None


def dashboard_for_role(role: str) -> str:
    definition = get_role_definition(role)
    return definition.dashboard_kind if definition is not None else ROLE_DASHBOARD.get(role, "")


def require_cap(cap: str):
    """View decorator: 403 if user lacks capability."""
    def deco(view):
        @wraps(view)
        @login_required
        def wrapper(request, *args, **kwargs):
            if not has_cap(request.user, cap):
                raise PermissionDenied("Insufficient role for this view.")
            return view(request, *args, **kwargs)
        return wrapper
    return deco


def scope_sites(user, qs):
    """Restrict a Site queryset to what the user is allowed to see."""
    role = get_role(user)
    definition = get_role_definition(role)
    scope_kind = definition.scope_kind if definition is not None else None
    caps = set(definition.capabilities or []) if definition is not None else ROLE_CAPS.get(role, set())
    if scope_kind == "all" or CAP_VIEW_ALL_SITES in caps:
        return qs
    if scope_kind == "country":
        p = get_profile(user)
        country = getattr(p, "country_code", "") if p else ""
        return qs.filter(country_code=country.upper()) if country else qs.none()
    if scope_kind == "admin" or CAP_VIEW_SCOPED_SITES in caps:
        p = get_profile(user)
        # Scoping is by the unit the operator is linked to, and everything beneath it, at
        # whatever depth that unit sits — which is what lets one role definition serve a
        # country with one sub-national level and a country with five. It is a prefix match
        # on ASCII codes, the only form that works when unit names are not ASCII.
        unit = getattr(p, "admin_unit", None) if p else None
        if unit is None:
            # No unit means no scope. Fails closed: an operator sees nothing until someone
            # says where they belong, rather than seeing everything.
            return qs.none()
        return qs.filter(Q(admin_path__startswith=f"{unit.admin_path}/") | Q(admin_unit=unit.pk))
    if scope_kind == "site" or CAP_VIEW_OWN_SITE in caps:
        p = get_profile(user)
        if p and getattr(p, "site_id", None):
            return qs.filter(pk=p.site_id)
        return qs.none()
    return qs.none()


class _SuperAdminProfile:
    """Synthetic profile so superusers always have role/scope context."""

    role = "super_admin"
    full_name = ""
    organization = ""
    designation = "Super Administrator"
    # A superuser is scoped to everything, so there is no unit to carry; the attributes
    # exist so callers can read them without a hasattr dance.
    admin_unit = None
    admin_unit_id = None
    country_code = ""
    site = None
    site_id = None

    def __init__(self, user):
        self.user = user
        self.full_name = user.get_full_name() or user.username
        # The authority name belongs to the deployment, not to this codebase.
        try:
            from .country_profile import get_profile as _country_profile

            self.organization = str((_country_profile().get("branding") or {}).get("authority_name") or "")
        except Exception:  # noqa: BLE001 - a bad profile must not break sign-in
            self.organization = ""

    @property
    def role_label(self) -> str:
        return "Super Admin"
