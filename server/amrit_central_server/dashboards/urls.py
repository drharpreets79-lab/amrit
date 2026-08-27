from django.urls import path

from . import views

urlpatterns = [
    path("dashboard/roles/", views.dashboard_home, name="dashboard_home"),
    path("dashboard/roles/<str:kind>/", views.stakeholder_dashboard, name="stakeholder_dashboard"),
    path("dashboard/roles/<str:kind>/refresh-live/", views.refresh_live, name="dashboard_refresh_live"),
]
