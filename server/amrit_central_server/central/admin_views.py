from django.contrib import messages
from django.contrib.auth import get_user_model
from django.db.models import Count
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.http import require_POST

from sites.models import RoleDefinition, Site
from .admin_forms import PortalUserForm, RoleDefinitionForm
from .roles import CAP_MANAGE_USERS, require_cap


@require_cap(CAP_MANAGE_USERS)
def admin_home(request):
    return render(request, "dashboard/admin/home.html", {
        "user_count": get_user_model().objects.count(), "role_count": RoleDefinition.objects.count(),
        "site_count": Site.objects.count(), "active_count": get_user_model().objects.filter(is_active=True).count(),
    })


@require_cap(CAP_MANAGE_USERS)
def admin_users(request):
    users = get_user_model().objects.select_related("amrit_profile", "amrit_profile__site").order_by("username")
    return render(request, "dashboard/admin/users.html", {"portal_users": users})


@require_cap(CAP_MANAGE_USERS)
def admin_user_edit(request, pk=None):
    user = get_object_or_404(get_user_model(), pk=pk) if pk else None
    form = PortalUserForm(request.POST or None, user=user)
    if request.method == "POST" and form.is_valid():
        saved = form.save()
        messages.success(request, f"User {saved.username} saved.")
        return redirect("portal_admin_users")
    return render(request, "dashboard/admin/user_form.html", {"form": form, "edited_user": user})


@require_POST
@require_cap(CAP_MANAGE_USERS)
def admin_user_toggle(request, pk):
    user = get_object_or_404(get_user_model(), pk=pk)
    if user == request.user:
        messages.error(request, "Cannot deactivate current account.")
    else:
        user.is_active = not user.is_active
        user.save(update_fields=["is_active"])
        messages.success(request, f"{user.username} {'activated' if user.is_active else 'deactivated'}.")
    return redirect("portal_admin_users")


@require_cap(CAP_MANAGE_USERS)
def admin_roles(request):
    roles = list(RoleDefinition.objects.order_by("label"))
    counts = dict(get_user_model().objects.filter(amrit_profile__isnull=False).values_list("amrit_profile__role").annotate(Count("id")))
    for role in roles:
        role.assigned_users = counts.get(role.slug, 0)
    return render(request, "dashboard/admin/roles.html", {"roles": roles})


@require_cap(CAP_MANAGE_USERS)
def admin_role_edit(request, pk=None):
    role = get_object_or_404(RoleDefinition, pk=pk) if pk else None
    form = RoleDefinitionForm(request.POST or None, instance=role)
    if request.method == "POST" and form.is_valid():
        saved = form.save()
        messages.success(request, f"Role {saved.label} saved.")
        return redirect("portal_admin_roles")
    return render(request, "dashboard/admin/role_form.html", {"form": form, "edited_role": role})


@require_POST
@require_cap(CAP_MANAGE_USERS)
def admin_role_delete(request, pk):
    role = get_object_or_404(RoleDefinition, pk=pk)
    assigned = get_user_model().objects.filter(amrit_profile__role=role.slug).exists()
    if role.is_system or assigned:
        messages.error(request, "System or assigned roles cannot be deleted. Deactivate instead.")
    else:
        label = role.label
        role.delete()
        messages.success(request, f"Role {label} deleted.")
    return redirect("portal_admin_roles")
