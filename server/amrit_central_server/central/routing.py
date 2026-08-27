from django.urls import re_path
from channels.security.websocket import AllowedHostsOriginValidator

from central import consumers

websocket_urlpatterns = [
    # Desktop app: wss://host/ws/desktop/ with Authorization + X-AMRIT-Site headers.
    # Secrets never enter the URL/query string, where proxies commonly log them.
    re_path(r"^ws/desktop/$", consumers.DesktopClientConsumer.as_asgi()),

    # Dashboard browser:  ws://host/ws/web/<lab_code>/
    # Browser sessions carry cookies automatically, so reject cross-site WebSocket
    # handshakes before session authentication can be replayed from a hostile origin.
    re_path(
        r"^ws/web/(?P<lab_code>[\w-]+)/$",
        AllowedHostsOriginValidator(consumers.WebDashboardConsumer.as_asgi()),
    ),
]
