import os

from django.core.asgi import get_asgi_application
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack


os.environ.setdefault("DJANGO_SETTINGS_MODULE", "central.settings")
django_asgi_app = get_asgi_application()
from central import routing
application = ProtocolTypeRouter({
    # Handles standard HTTP requests
    "http": django_asgi_app,
    
    # Handles WebSocket requests with session authentication
    "websocket": AuthMiddlewareStack(
        URLRouter(
            routing.websocket_urlpatterns
        )
    ),
})