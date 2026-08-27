"""WebSocket bridge between AMRIT desktop apps and dashboard browsers.

Two consumers + one server-side helper:

* ``DesktopClientConsumer`` — the desktop app connects here with ``Authorization`` and
  ``X-AMRIT-Site`` headers. It joins the group ``desktop_user_<lab_code>``
  and answers ``fetch_local_records`` requests with aggregate-only payloads.
* ``WebDashboardConsumer`` — a dashboard browser connects here
  (``ws/web/<lab_code>/``) to receive streamed aggregate updates.
* ``nudge_site_live`` — called from a view/refresh to push a filter request to a
  site over the socket so it answers immediately (instead of waiting for the
  next long-poll). Returns a ``tx_id`` the caller can poll in the cache.

Group name and cache key are the single contract shared by the consumer, the
``trigger_desktop_filter`` view, and ``dashboards.refresh`` — they were
previously inconsistent (``desktop_user_*`` vs ``lab_*``; ``tx_id`` vs
``response_user_*``) which silently broke live pulls. Do not diverge them.
"""

from __future__ import annotations

import json
import uuid

from asgiref.sync import async_to_sync
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from channels.layers import get_channel_layer
from django.core.cache import cache
from django.utils import timezone

from sites.models import Site, _hash_token
from queries.pii_guard import PIIViolation, assert_aggregate_only
from central.roles import scope_sites


MAX_DESKTOP_MESSAGE_BYTES = 256 * 1024


def desktop_group(lab_code: str) -> str:
    return f"desktop_user_{lab_code}"


def web_group(lab_code: str) -> str:
    return f"web_dashboard_{lab_code}"


LIVE_PULL_TIMEOUT = 30  # seconds the aggregate response stays cached


@database_sync_to_async
def verify_credentials_on_server_side(token_key, site_token):
    """Return lab code only when both current credentials authenticate an active site."""
    try:
        token_entry = Site.objects.get(auth_token_hash=_hash_token(token_key), status="active")
        return token_entry.lab_code if token_entry.check_site_token(site_token) else None
    except Site.DoesNotExist:
        return None


@database_sync_to_async
def user_can_view_site(user, lab_code: str) -> bool:
    """Apply the same site-scope gate as HTTP dashboards to browser sockets."""
    return scope_sites(user, Site.objects.filter(lab_code=lab_code)).exists()


@database_sync_to_async
def update_lab_status(lab_code, status_bool):
    Site.objects.filter(lab_code=lab_code).update(
        is_online=status_bool,
        last_seen_at=timezone.now(),
    )


# --------------------------------------------------------------------------- #
# Server-side helper: nudge a site to answer a live pull immediately          #
# --------------------------------------------------------------------------- #
def nudge_site_live(lab_code: str, *, criteria: dict | None = None, tx_id: str | None = None) -> str:
    """Push a fetch_local_records request to a site over the socket.

    Pre-seeds a cache entry keyed by ``tx_id`` that the site fills in via its
    ``local_data_response`` message. Returns the ``tx_id`` for the caller to poll.
    """
    tx_id = tx_id or uuid.uuid4().hex
    cache.set(tx_id, {"responses": {}, "created_at": timezone.now().isoformat()}, timeout=LIVE_PULL_TIMEOUT)
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        desktop_group(lab_code),
        {
            "type": "forward_filter_request",
            "criteria": criteria or {},
            "tx_id": tx_id,
        },
    )
    return tx_id


# --------------------------------------------------------------------------- #
# Desktop side                                                                #
# --------------------------------------------------------------------------- #
class DesktopClientConsumer(AsyncWebsocketConsumer):

    async def connect(self):
        headers = {key.lower(): value for key, value in self.scope.get("headers", [])}
        authorization = headers.get(b"authorization", b"").decode("utf-8", "ignore").strip()
        self.auth_token = authorization.split(" ", 1)[1].strip() if authorization.lower().startswith("bearer ") else ""
        self.site_token = headers.get(b"x-amrit-site", b"").decode("utf-8", "ignore").strip()
        if not self.auth_token:
            await self.close(code=4003)
            return

        self.lab_code = await verify_credentials_on_server_side(self.auth_token, self.site_token)
        if not self.lab_code:
            await self.close(code=4003)
            return

        self.group_name = desktop_group(self.lab_code)
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()
        await update_lab_status(self.lab_code, True)

    async def disconnect(self, close_code):
        if hasattr(self, "group_name"):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)
        if hasattr(self, "lab_code"):
            await update_lab_status(self.lab_code, False)

    async def receive(self, text_data=None):
        if not text_data:
            return
        if len(text_data.encode("utf-8")) > MAX_DESKTOP_MESSAGE_BYTES:
            await self.close(code=1009)
            return
        # Token reset, site-token reset and site disablement take effect on an already-open
        # channel before it can send another response. A WebSocket must not outlive the
        # credentials that created it.
        current_lab = await verify_credentials_on_server_side(self.auth_token, self.site_token)
        if current_lab != self.lab_code:
            await self.close(code=4003)
            return
        try:
            data = json.loads(text_data)
        except json.JSONDecodeError:
            await self.close(code=1007)
            return
        if not isinstance(data, dict):
            await self.close(code=1007)
            return
        if data.get("type") == "local_data_response":
            tx_id = data.get("tx_id")
            payload = data.get("payload", [])
            if not isinstance(tx_id, str) or not tx_id or len(tx_id) > 128:
                await self.close(code=1007)
                return
            try:
                assert_aggregate_only(payload, source="WebSocket live aggregate response")
            except PIIViolation:
                await self.close(code=1008)
                return
            current = cache.get(tx_id)
            if current is not None:
                current["responses"][self.lab_code] = payload
                cache.set(tx_id, current, timeout=LIVE_PULL_TIMEOUT)
            # Also fan out to any dashboard browser watching this lab.
            await self.channel_layer.group_send(
                web_group(self.lab_code),
                {"type": "dashboard_update", "tx_id": tx_id, "payload": payload},
            )

    async def forward_filter_request(self, event):
        """Deliver a server-issued filter request down to this desktop client."""
        current_lab = await verify_credentials_on_server_side(self.auth_token, self.site_token)
        if current_lab != self.lab_code:
            await self.close(code=4003)
            return
        await self.send(text_data=json.dumps({
            "command": "fetch_local_records",
            "criteria": event.get("criteria", {}),
            "tx_id": event.get("tx_id"),
        }))


# --------------------------------------------------------------------------- #
# Dashboard-browser side                                                      #
# --------------------------------------------------------------------------- #
class WebDashboardConsumer(AsyncWebsocketConsumer):

    async def connect(self):
        user = self.scope.get("user")
        if user is None or not user.is_authenticated:
            await self.close(code=4401)
            return
        self.lab_code = self.scope["url_route"]["kwargs"].get("lab_code", "")
        if not await user_can_view_site(user, self.lab_code):
            await self.close(code=4403)
            return
        self.group_name = web_group(self.lab_code)
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

    async def disconnect(self, close_code):
        if hasattr(self, "group_name"):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def dashboard_update(self, event):
        await self.send(text_data=json.dumps({
            "type": "aggregate_update",
            "tx_id": event.get("tx_id"),
            "payload": event.get("payload", []),
        }))
