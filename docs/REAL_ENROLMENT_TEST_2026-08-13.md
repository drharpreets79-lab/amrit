# Desktop enrolment and sync — real-system verification

Date: 2026-08-13  
Result: PASS

## System under test

- Real Django/Channels ASGI server on `127.0.0.1:8127`
- Real Redis channel layer and shared Redis cache in an isolated container
- Fresh database migrated through `amrit_sites.0012`
- Real TypeScript `SyncManager` from the desktop application
- Real HTTP login and approval through `/dashboard/sites/requests/`
- Real WebSocket connection through `/ws/desktop/`

The database, administrator account, bearer token, pickup proof and site token were all
ephemeral. No credential value is present in this report.

## Observed flow

1. Desktop filed `REAL-E2E-01`; HTTP 202; portal showed one **Awaiting decision** request.
2. A real super-administrator session posted **Approve**; HTTP 302 redirected to the site's
   token page; the site factor was shown once.
3. Desktop's server-paced approval poll collected the bearer credential once and marked the
   pickup proof redeemed.
4. The separately delivered site factor was supplied to the desktop configuration.
5. Desktop opened its outbound WebSocket with bearer + site-factor headers. Both the WSS
   channel and HTTP long-poll authenticated.
6. The server triggered a live filter over Redis/Channels. The desktop replied over the
   WebSocket with one aggregate row; HTTP returned 200 and `total_records_fetched: 1`.

## Final evidence

```json
{
  "request_status_in_database": "approved",
  "pickup_redeemed": true,
  "site_status": "active",
  "bearer_stored_as_hash_only_on_server": true,
  "site_factor_stored_as_hash_only_on_server": true,
  "desktop_websocket": "connected",
  "desktop_long_poll": "idle",
  "live_aggregate_replies": 1,
  "live_http_status": 200,
  "pickup_secret_exposed_to_renderer_or_report": false
}
```

The server audit contained `site_approved`, `token_collected`, and `heartbeat`. The site's
online flag returned to false after the test deliberately stopped the desktop client, which
confirms disconnect cleanup also ran.

## Re-run

`app/tests/real-enrolment.integration.test.ts` is opt-in. Point it at an isolated running
server with `AMRIT_REAL_SERVER_URL`, `AMRIT_REAL_COORDINATION_FILE`,
`AMRIT_REAL_SITE_TOKEN_FILE`, and `AMRIT_REAL_LAB_CODE`; approve through the portal and put
the once-shown site factor in the named token file. The ordinary test suite skips it when
those variables are absent.
