"""Security contract for the outbound desktop WebSocket channel."""

from asgiref.sync import async_to_sync
from channels.db import database_sync_to_async
from channels.testing import WebsocketCommunicator
from django.conf import settings
from django.contrib.auth import get_user_model
from django.test import Client, TransactionTestCase, override_settings

from central.asgi import application
from sites.models import Site


@override_settings(
    ALLOWED_HOSTS=["localhost", "testserver"],
    CHANNEL_LAYERS={"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}},
)
class DesktopWebSocketSecurityTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self):
        self.site = Site.objects.create(lab_code="WSSEC01", name="Secure socket", status="active")
        self.bearer = Site.issue_token()
        self.site_token = Site.issue_token(24)
        self.site.set_auth_token(self.bearer)
        self.site.set_site_token(self.site_token)
        self.site.save()

    def headers(self, *, bearer=None, site_token=None):
        bearer = self.bearer if bearer is None else bearer
        site_token = self.site_token if site_token is None else site_token
        return [
            (b"authorization", f"Bearer {bearer}".encode()),
            (b"x-amrit-site", site_token.encode()),
        ]

    def test_query_string_bearer_is_rejected_so_proxies_cannot_log_it(self):
        async def scenario():
            socket = WebsocketCommunicator(application, f"/ws/desktop/?token={self.bearer}")
            connected, close_code = await socket.connect()
            self.assertFalse(connected)
            self.assertEqual(close_code, 4003)

        async_to_sync(scenario)()

    def test_both_header_credentials_are_required(self):
        async def scenario():
            missing_site = WebsocketCommunicator(
                application,
                "/ws/desktop/",
                headers=[(b"authorization", f"Bearer {self.bearer}".encode())],
            )
            connected, close_code = await missing_site.connect()
            self.assertFalse(connected)
            self.assertEqual(close_code, 4003)

            valid = WebsocketCommunicator(
                application, "/ws/desktop/", headers=self.headers()
            )
            connected, _ = await valid.connect()
            self.assertTrue(connected)
            await valid.disconnect()

        async_to_sync(scenario)()

    def test_reset_invalidates_an_already_open_socket_before_next_response(self):
        @database_sync_to_async
        def reset_site_token():
            site = Site.objects.get(lab_code="WSSEC01")
            site.set_site_token(Site.issue_token(24))
            site.save(update_fields=["site_token_hash", "site_token_prefix"])

        async def scenario():
            socket = WebsocketCommunicator(
                application, "/ws/desktop/", headers=self.headers()
            )
            connected, _ = await socket.connect()
            self.assertTrue(connected)
            await reset_site_token()
            await socket.send_json_to({
                "type": "local_data_response", "tx_id": "tx-reset", "payload": []
            })
            closed = await socket.receive_output(timeout=1)
            self.assertEqual(closed, {"type": "websocket.close", "code": 4003})

        async_to_sync(scenario)()

    def test_pii_in_live_payload_is_rejected_server_side(self):
        async def scenario():
            socket = WebsocketCommunicator(
                application, "/ws/desktop/", headers=self.headers()
            )
            connected, _ = await socket.connect()
            self.assertTrue(connected)
            await socket.send_json_to({
                "type": "local_data_response",
                "tx_id": "tx-pii",
                "payload": [{"patient_id": "P-SECRET", "total": 1}],
            })
            closed = await socket.receive_output(timeout=1)
            self.assertEqual(closed, {"type": "websocket.close", "code": 1008})

        async_to_sync(scenario)()

    def test_browser_socket_applies_the_same_site_scope_as_http(self):
        user_model = get_user_model()
        unscoped = user_model.objects.create_user(username="unscoped-ws", password="unused")
        superuser = user_model.objects.create_superuser(
            username="root-ws", email="root@example.test", password="unused"
        )

        def session_header(user):
            client = Client()
            client.force_login(user)
            value = client.cookies[settings.SESSION_COOKIE_NAME].value
            return [
                (b"cookie", f"{settings.SESSION_COOKIE_NAME}={value}".encode()),
                (b"origin", b"http://localhost"),
            ]

        unscoped_headers = session_header(unscoped)
        superuser_headers = session_header(superuser)

        async def scenario():
            denied = WebsocketCommunicator(
                application, "/ws/web/WSSEC01/", headers=unscoped_headers
            )
            connected, close_code = await denied.connect()
            self.assertFalse(connected)
            self.assertEqual(close_code, 4403)

            allowed = WebsocketCommunicator(
                application, "/ws/web/WSSEC01/", headers=superuser_headers
            )
            connected, _ = await allowed.connect()
            self.assertTrue(connected)
            await allowed.disconnect()

        async_to_sync(scenario)()

    def test_browser_socket_rejects_a_foreign_origin_even_with_valid_session(self):
        user = get_user_model().objects.create_superuser(
            username="origin-root", email="origin@example.test", password="unused"
        )
        client = Client()
        client.force_login(user)
        session = client.cookies[settings.SESSION_COOKIE_NAME].value

        async def scenario():
            socket = WebsocketCommunicator(
                application,
                "/ws/web/WSSEC01/",
                headers=[
                    (b"cookie", f"{settings.SESSION_COOKIE_NAME}={session}".encode()),
                    (b"origin", b"https://hostile.example"),
                ],
            )
            connected, _ = await socket.connect()
            self.assertFalse(connected)

        async_to_sync(scenario)()
