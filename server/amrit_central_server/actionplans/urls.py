from django.urls import path

from . import views

urlpatterns = [
    path("actions/", views.action_inbox, name="action_inbox"),
    path("actions/tracking/", views.action_tracking, name="action_tracking"),
    path("actions/new/", views.action_plan_new, name="action_plan_new"),
    path("actions/<int:pk>/", views.action_plan_detail, name="action_plan_detail"),
]
