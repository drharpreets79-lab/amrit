from django.urls import path

from . import poll_views
from . import views

urlpatterns = [
    path("poll", poll_views.poll, name="amrit-poll"),
    path("respond", poll_views.respond, name="amrit-respond"),
    path("heartbeat", poll_views.heartbeat, name="amrit-heartbeat"),
    path('api/trigger-filter/', views.trigger_desktop_filter, name='trigger_desktop_filter'),
    path('api/token_code_verify/',views.token_code_verify, name="token_code_verify"),
]
