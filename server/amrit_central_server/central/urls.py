from django.contrib import admin
from django.contrib.auth import views as auth_views
from django.http import JsonResponse
from django.urls import include, path

from central import deployment_views
from drf_spectacular.views import (
    SpectacularAPIView,
    SpectacularSwaggerView,
)

from . import views as dashboard_views
from . import admin_views
from sites import views
from analytics.portal import outbreak_dashboard


def health(_request):
    return JsonResponse({"status": "ok", "service": "amrit-central"})


urlpatterns = [
    path("", dashboard_views.dashboard, name="dashboard"),
    path("dashboard/licences/", dashboard_views.data_licences_view, name="dashboard_licences"),
    path("dashboard/deployment/", deployment_views.deployment_settings, name="dashboard_deployment"),
    path("dashboard/deployment/save/", deployment_views.deployment_settings_save, name="dashboard_deployment_save"),
    path("dashboard/deployment/logo/", deployment_views.deployment_logo_upload, name="dashboard_deployment_logo"),
    path("dashboard/deployment/reset/", deployment_views.deployment_settings_reset, name="dashboard_deployment_reset"),
    path("dashboard/deployment/revert/", deployment_views.deployment_settings_revert, name="dashboard_deployment_revert"),
    path("dashboard/deployment/export/", deployment_views.deployment_settings_export, name="dashboard_deployment_export"),
    path("dashboard/deployment/profile.json", deployment_views.deployment_settings_json, name="dashboard_deployment_json"),
    path("dashboard/sites/", dashboard_views.sites_list, name="dashboard_sites"),
    # Static segments before the <str:lab_code> catch-all, or "new" and "requests" would
    # be read as laboratory codes.
    path("dashboard/sites/new/", dashboard_views.site_create, name="dashboard_site_create"),
    path("dashboard/sites/requests/", dashboard_views.site_requests, name="dashboard_site_requests"),
    path("dashboard/sites/requests/clear/", dashboard_views.site_requests_clear, name="dashboard_site_requests_clear"),
    path("dashboard/sites/requests/<int:pk>/decide/", dashboard_views.site_request_decide, name="dashboard_site_request_decide"),
    path("dashboard/sites/<str:lab_code>/edit/", dashboard_views.site_edit, name="dashboard_site_edit"),
    path("dashboard/sites/<str:lab_code>/rename/", dashboard_views.site_rename, name="dashboard_site_rename"),
    path("dashboard/sites/<str:lab_code>/delete/", dashboard_views.site_delete, name="dashboard_site_delete"),
    path("dashboard/sites/<str:lab_code>/token/", dashboard_views.site_token, name="dashboard_site_token"),
    path("dashboard/sites/map/", dashboard_views.sites_map, name="dashboard_map"),
    path("dashboard/sites/map.json", dashboard_views.sites_map_json, name="dashboard_map_json"),
    path("dashboard/queries/", dashboard_views.queries_list, name="dashboard_queries"),
    path("dashboard/queries/new/", dashboard_views.query_new, name="query_new"),
    path("dashboard/queries/<uuid:pk>/", dashboard_views.query_detail, name="query_detail"),
    path("dashboard/audit/", dashboard_views.audit_list, name="dashboard_audit"),
    path("dashboard/public/", dashboard_views.public_summary, name="public_summary"),
    path("dashboard/outbreaks/", outbreak_dashboard, name="outbreak_dashboard"),
    path("portal-admin/", admin_views.admin_home, name="portal_admin_home"),
    path("portal-admin/users/", admin_views.admin_users, name="portal_admin_users"),
    path("portal-admin/users/new/", admin_views.admin_user_edit, name="portal_admin_user_new"),
    path("portal-admin/users/<int:pk>/", admin_views.admin_user_edit, name="portal_admin_user_edit"),
    path("portal-admin/users/<int:pk>/toggle/", admin_views.admin_user_toggle, name="portal_admin_user_toggle"),
    path("portal-admin/roles/", admin_views.admin_roles, name="portal_admin_roles"),
    path("portal-admin/roles/new/", admin_views.admin_role_edit, name="portal_admin_role_new"),
    path("portal-admin/roles/<int:pk>/", admin_views.admin_role_edit, name="portal_admin_role_edit"),
    path("portal-admin/roles/<int:pk>/delete/", admin_views.admin_role_delete, name="portal_admin_role_delete"),

    path("accounts/login/", auth_views.LoginView.as_view(), name="login"),
    path("accounts/logout/", auth_views.LogoutView.as_view(next_page="login"), name="logout"),

    path("", include("dashboards.urls")),
    path("", include("actionplans.urls")),

    path("health/", health, name="health"),
    path("admin/", admin.site.urls),
    path("v1/", include("queries.poll_urls")),
    path("api/v1/sites/", include("sites.urls")),
    path("api/v1/queries/", include("queries.urls")),
    path("api/v1/analytics/", include("analytics.urls")),
    # Phase 22. FHIR terminology, so a receiving system can validate against the same
    # table the desktop exporter binds with rather than against its own copy.
    path("api/v1/terminology/", include("terminology.urls")),
    path("api/v1/ecosystem/", include("ecosystem.urls")),
    path("api/v1/schema/", SpectacularAPIView.as_view(), name="schema"),
    path("api/v1/docs/", SpectacularSwaggerView.as_view(url_name="schema"), name="docs"),

    # add here site url fetch_site_token
    path("create_labcode/", views.create_labcode, name="create_labcode"),
    # Was also named "create_labcode", which shadowed the route above so reverse() for
    # either name resolved to whichever Django registered last.
    path("fetch_site_token/", dashboard_views.fetch_site_token, name="fetch_site_token"),
    path("api/v2/sites/register/", views.register_site, name="register_site"),
]
