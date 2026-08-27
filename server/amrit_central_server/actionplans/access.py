"""Who sees which action plans, and for which scope."""

from __future__ import annotations

from django.db.models import Q

from central.roles import dashboard_for_role, get_profile, get_role

from .models import ActionPlan


def scope_for_user(user):
    """Return (scope_type, scope_value) for a user's action inbox.

    An operator scoped to an administrative unit gets that unit's level and code, whatever
    depth it sits at, so the inbox needs no knowledge of what a country calls its tiers.
    """
    from central.scopes import scope_for_level

    role = get_role(user)
    profile = get_profile(user)
    kind = dashboard_for_role(role)
    unit = getattr(profile, "admin_unit", None)
    if kind == "admin" and unit is not None:
        return scope_for_level(unit.level), unit.code
    if kind == "hospital":
        site = getattr(profile, "site", None)
        return "site", (site.lab_code if site else "")
    return "country", ""


def plans_for_scope(scope_type, scope_value, role=""):
    """Plans visible to a stakeholder at a given scope.

    Exact-scope plans, plus national plans roll down to sub-national scopes,
    plus any plan explicitly addressed to the viewer's role.
    """
    from central.scopes import accepted_spellings, canonical_scope_type

    # Every spelling that names the tier is accepted; they mean the same thing.
    cond = Q(scope_type__in=accepted_spellings(scope_type), scope_value=scope_value or "")
    if canonical_scope_type(scope_type) != "country":
        cond |= Q(scope_type__in=["national", "country"], scope_value="")
    if role:
        cond |= Q(target_role=role)
    return ActionPlan.objects.filter(cond).distinct()


def plans_for_user(user):
    role = get_role(user)
    if role in {"super_admin", "programme_admin"}:
        return ActionPlan.objects.all()
    scope_type, scope_value = scope_for_user(user)
    return plans_for_scope(scope_type, scope_value, role)


def can_view_plan(user, plan) -> bool:
    return plans_for_user(user).filter(pk=plan.pk).exists()
