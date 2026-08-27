# AMRIT Central Aggregation Server

Django-based, Docker-packaged central server that bridges multiple AMRIT
desktop installations across one or more countries. It implements the AMRIT site
long-poll wire protocol (`SYNC_PROTOCOL.md`) and exposes an analytics API
that returns only **aggregate, de-identified** data — optionally
formatted as **FHIR R4** so downstream applications (dashboards, GLASS
exporters, ML pipelines, public health portals) can be built on top.

## Architecture

```
+-------------------+        long-poll          +---------------------+
|  AMRIT desktop    | <----- /v1/poll --------- |                     |
|  (lab installs)   | -----> /v1/respond -----> |  AMRIT Central      |
+-------------------+        (Bearer auth)      |  Server (Django)    |
                                                |                     |
+-------------------+        REST API           |  Postgres + DRF     |
|  Dashboards / BI  | -----> /api/v1/...   ---> |  PII guard          |
|  GLASS exporters  | <-------- FHIR / JSON --- |  Audit log          |
+-------------------+                           +---------------------+
```

* Sites authenticate with a per-site bearer token (hashed at rest).
* The server queues queries, sites long-poll, results land in Postgres.
* The server **never** stores patient identifiers — the PII guard rejects
  responses containing generic direct identifiers plus national identifier
  keys configured by the active country profile.
* Analyst-facing endpoints expose aggregate metrics only, gated by a
  configurable k-anonymity floor (`AMRIT_K_ANONYMITY_FLOOR`, default 5).

## Endpoints

### Site-facing (matches `SYNC_PROTOCOL.md`)
| Method | Path                | Notes                                                                 |
|--------|---------------------|-----------------------------------------------------------------------|
| GET    | `/v1/poll`          | Long-poll for next dispatched query. `?lab_code=&wait=` query string. |
| POST   | `/v1/respond`       | Site posts aggregate result. Body validated by PII guard.             |

HTTP auth: `Authorization: Bearer <authentication-token>` plus `X-AMRIT-Site: <site-token>`
when a site token has been issued. Desktop WebSocket connections use the same two headers;
credentials are never placed in a WebSocket URL or query string.

### Analyst-facing
| Method | Path                                                | Purpose                                                |
|--------|-----------------------------------------------------|--------------------------------------------------------|
| GET    | `/api/v1/sites/`                                    | CRUD on registered sites. Includes `rotate_token`.     |
| GET    | `/api/v1/queries/`                                  | List & create queries directly.                        |
| GET    | `/api/v1/queries/<id>/results/`                     | Aggregate replies received from each site.             |
| GET    | `/api/v1/queries/audit/`                            | Server-side audit of polls and responses.              |
| GET    | `/api/v1/analytics/filters`                         | Exhaustive filter catalog (see below).                 |
| GET\|POST | `/api/v1/analytics/aggregate/isolate-count`      | Roll-up of stored isolate counts across sites.         |
| GET\|POST | `/api/v1/analytics/aggregate/organism-distribution`| Cross-site organism histogram.                       |
| GET\|POST | `/api/v1/analytics/aggregate/specimen-distribution`| Cross-site specimen histogram.                       |
| GET\|POST | `/api/v1/analytics/aggregate/resistance-rate`    | %R per antibiotic + Wilson 95% CI per site.            |
| POST   | `/api/v1/analytics/dispatch/<metric>`               | Enqueue a fresh long-poll task to all matching sites.  |
| GET    | `/api/v1/docs/`                                     | Swagger UI (drf-spectacular).                          |
| GET    | `/health/`                                          | Liveness probe.                                        |

### Output formats
Set `output_format=fhir_bundle` (default for downstream apps),
`output_format=json`, or `output_format=csv` on any aggregate endpoint.
FHIR responses are R4 `Bundle` of `Organization` + `Measure` +
`MeasureReport` (resistance rate) or `Observation` (counts).

### Filter catalog (exhaustive)

The full list lives at runtime under `GET /api/v1/analytics/filters`.
Highlights:

* **Geography**: `lab_code`, `country`, `country_code`, N-level `admin_path`,
  `admin_code`, `lab_domain`, `site_status`.
* **Specimen / organism**: `organism`, `organism_code`, `organism_group`,
  `specimen_type`, `specimen_category`.
* **Antibiogram**: `antibiotic_code`, `antibiotic_class`, `result`
  (`R`/`I`/`S`/`RIS`), profile-configured `guideline`, `guideline_year`,
  `test_method`.
* **Demographics**: `age_band`, `sex`, `pregnancy`.
* **Encounter**: `location_type` (in/out/icu/ward/ed/community),
  `ward_type`, `infection_origin` (HAI/CAI/HCAI), `admission_route`,
  `isolate_type`.
* **WHONET hygiene**: `first_isolate_only`, `exclude_qc`, `exclude_repeat`.
* **Phenotype**: `phenotype` (MRSA/MSSA/ESBL/AmpC/CRE/CRAB/CRPA/VRE/PNSP/
  MDR/XDR/PDR), `multi_drug_resistant`.
* **Time**: `period_start`, `period_end`, `date_resolution`
  (day/week/iso_week/month/quarter/year).
* **Aggregation**: `group_by`, `min_isolates`, `min_denominator`,
  `include_zero_buckets`.
* **Output**: `output_format`, `ci_method` (wilson/exact/none),
  `ci_level`.

The site-side AMRIT protocol only understands a small subset (organism,
specimen_type, location_type, period_start, period_end). The server
**projects** the rich filter set down to that subset before dispatch and
applies the rest centrally on the returned aggregate buckets — keeping
the wire protocol unchanged.

## Quick start

```bash
cp .env.example .env
docker compose up --build
```

Server listens on `:8000`. It does not invent an administrator credential. Bootstrap one
with an explicit country and a password of at least 12 characters, then visit the API docs:

```bash
docker compose exec web python manage.py bootstrap --country USA \
  --admin-username admin --admin-password '<a long password>'
docker compose exec web python manage.py drf_create_token admin
```

Visit `/api/v1/docs/` for the OpenAPI explorer.

The Postgres container has **no host port** by default — it is reached
internally on `db:5432`. If `0.0.0.0:5432 already allocated` errors
appear, that means an unrelated mapping is being added; `docker compose
down` to clear stale containers and re-up.

If port `:8000` is already in use on the host, override it:

```bash
WEB_PORT=8080 docker compose up --build
# or set WEB_PORT=8080 in .env
```

Find what holds the port: `lsof -iTCP:8000 -sTCP:LISTEN`.

### Expose Postgres on the host (optional)

Need to attach a SQL client from outside Docker?

```bash
cp docker-compose.override.yml.example docker-compose.override.yml
# edit POSTGRES_PORT in .env (default 55432) if 5432 collides on the host
docker compose up --build
```

### Register a site
```bash
curl -X POST http://localhost:8000/api/v1/sites/ \
     -H 'Authorization: Token <administrator-api-token>' \
     -H 'Content-Type: application/json' \
     -d '{"lab_code":"SITE-001","name":"Reference Laboratory",
          "country":"United States","country_code":"USA",
          "address":{"country_code":"USA","address_lines":["100 Example Avenue"],
                     "locality":"Atlanta","admin_area":"GA","postal_code":"30329"}}'
```

The response includes `issued_token`; copy that into the AMRIT desktop
"Network Sync → Bearer auth token" field.

### Dispatch a query
```bash
curl -X POST http://localhost:8000/api/v1/analytics/dispatch/resistance-rate \
     -H 'Authorization: Token <administrator-api-token>' \
     -H 'Content-Type: application/json' \
     -d '{"antibiotic_code":"MEM",
          "lab_code":["SITE-001"],
          "organism":"Escherichia coli",
          "period_start":"2025-01-01",
          "period_end":"2026-04-30"}'
```

Sites pick the query up on the next long-poll, run it locally, and POST
the aggregate result back. Pull the rolled-up FHIR Bundle:

```bash
curl 'http://localhost:8000/api/v1/analytics/aggregate/resistance-rate?antibiotic_code=MEM&output_format=fhir_bundle' \
     -H 'Authorization: Token <administrator-api-token>'
```

## PII guard

`queries/pii_guard.py` protects the site-response boundary over HTTP and WebSocket. It
blocks generic patient identifiers, names, dates of birth, contacts, specimen identifiers,
addresses and coordinates, then adds national identifier keys from the country profile.
Banned content patterns include emails, long identifier-like digit strings and phone-like
strings. A rejected HTTP payload returns 422 with
`{"error":"pii_guard_rejected"}` so operators see violations immediately
rather than silently mining identifiers.

## Operational notes

* Long-poll uses DB polling (`AMRIT_LONGPOLL_TICK` seconds) instead of
  Redis pub/sub to keep the deployment single-container-friendly.
* Run Daphne/ASGI, as the packaged container does. A WSGI-only server drops the
  desktop WebSocket bridge.
* Postgres is recommended for production; a `sqlite://` fallback works
  for local development if `DATABASE_URL` is unset.
* Audit log entries are persisted (not in-memory) so they survive
  restarts and feed compliance review.

## Stakeholder dashboards + action tracking

Three apps add role-based dashboards and the action-plan workflow on top of the
aggregation core:

* **`metrics/`** — declarative registry of every dashboard indicator
  (`MetricDef`: title, plain-language definition, calculation/formula, data
  source, guideline reference). `metrics/compute.py` rolls stored aggregate
  `QueryResult` rows into values; a test pins the resistance formula
  (`%R = R/(R+I+S)`) to the desktop `aggregate_measures` contract.
* **`dashboards/`** — `KPISnapshot` (the only aggregate stored at rest) plus one
  generic, scope-aware view rendering a **Basic** and an **Advanced** section per
  stakeholder (country / any administrative depth / epidemiologist / hospital). Every
  number carries an "ⓘ Definition" popover. "Refresh live" pulls fresh aggregate
  numbers from the desktop apps (WebSocket nudge + long-poll dispatch) and writes
  a new snapshot — no patient rows ever persist.
* **`actionplans/`** — `ThresholdRule` engine auto-drafts an `ActionPlan` (with
  seeded `ActionPoint`s) whenever a snapshot breaches a limit; stakeholders also
  author plans manually, track points, and file `ActionTakenReport`s (ATRs) with
  the triggering aggregate figure auto-attached as evidence.

Role → dashboard routing and the new capabilities live in `central/roles.py`
(`ROLE_DASHBOARD`, `CAP_VIEW_BASIC_DASHBOARD`, `CAP_VIEW_ADVANCED_DASHBOARD`,
`CAP_MANAGE_ACTION_PLANS`, `CAP_TRACK_ACTION_POINTS`).

### Seed + schedule

```bash
python manage.py seed_demo            # sites + one user per role
python manage.py seed_action_rules    # threshold rules + plan templates
python manage.py seed_dashboards      # synthetic snapshots (+ auto-drafts plans)
```

Keep snapshots warm on a schedule (cron / Celery-beat / a docker compose
sidecar):

```bash
# every 30 min: pull live, then roll up country + every configured administrative level/site
*/30 * * * *  python manage.py refresh_snapshots --live
```

`seed_demo` is an explicitly India-only demonstration story and refuses to run under any
other deployment profile. Its published credentials are for disposable demo systems only.
