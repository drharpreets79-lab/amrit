from django.urls import path
from rest_framework.routers import DefaultRouter
from . import views

router = DefaultRouter()
for prefix, viewset in (("organizations", views.OrganizationViewSet), ("devices", views.DeviceRegistrationViewSet),
    ("products", views.DataProductViewSet), ("terminology", views.TerminologyReleaseViewSet),
    ("alerts", views.AlertCaseViewSet), ("risk-assessments", views.JointRiskAssessmentViewSet),
    ("milestones", views.ProgrammeMilestoneViewSet), ("access-requests", views.AccessRequestViewSet),
    ("reporting-runs", views.ReportingRunViewSet)):
    router.register(prefix, viewset, basename=prefix)

urlpatterns = [
    path("ingest/", views.ingest_product, name="ecosystem_ingest"),
    path("workbench/", views.workbench, name="ecosystem_workbench"),
    path("public/", views.transparency_portal, name="ecosystem_public"),
] + router.urls
