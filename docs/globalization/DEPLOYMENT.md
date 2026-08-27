# Deploying AMRIT Central

The server, from a clean machine to a deployment that can accept sites. The desktop
application is installed separately and needs none of this — it is offline-first and works
with no server at all.

## What you need

- Docker with Compose v2, or Python 3.13+ and PostgreSQL 15+ if you would rather run it
  directly.
- A hostname and a TLS certificate. Do not skip this: site enrolment and the administrator
  sign-in both carry credentials, and the compose file publishes the web port on the
  loopback interface only for exactly that reason.
- Somewhere off this machine to keep backups.

## 1. Configure

```bash
cd server
cp amrit_central_server/.env.example .env
```

Edit `.env`. The three that have no safe default:

| Variable | Why it matters |
|---|---|
| `DJANGO_SECRET_KEY` | Signs sessions. Generate: `python3 -c "import secrets; print(secrets.token_urlsafe(50))"` |
| `POSTGRES_PASSWORD` | Compose refuses to start without it |
| `AMRIT_ENROLMENT_SECRET` | Without it no site can register. See [Site enrolment](#site-enrolment) |

Set `DJANGO_ALLOWED_HOSTS` to your hostname. The default of `*` is convenient for a first
run and wrong for anything reachable.

`AMRIT_COUNTRY_PROFILE` selects the country: a curated profile id such as `IN`, or any ISO
3166-1 code, which is synthesized. Leaving it empty resolves the unconfigured fallback,
which works but emits `https://amrit.invalid` as its FHIR namespace.

The desktop follows the same rule. A fresh installation has no implied country: choose the
base country under **Deployment** before entering laboratories. If the environment locks
`AMRIT_COUNTRY_PROFILE`, the UI shows the country but will not override it.

### Facility addresses

Address fields, labels, ordering, required components and postal-code patterns come from the
selected country's format. The same field is therefore shown as ZIP code, postcode, PIN code,
Eircode or another local label without changing the stored contract. Administrative reporting
placement is separate: `admin_unit` / `admin_path` answers which programme unit owns a facility;
the postal address answers where its building is.

Facilities may also store a full [Google Plus Code](https://github.com/google/open-location-code).
It resolves to a labelled coordinate offline and covers places that lack a usable street or
postal-code system. Short Plus Codes are refused because decoding them requires a trusted
reference location. The hosted Google Address Validation API is not a runtime dependency: its
country coverage is limited and it would add network, billing and API-key requirements to an
otherwise offline workflow.

## 2. Start

```bash
docker compose up -d
```

The web container migrates the database and collects static files on start. Postgres and
Redis both have healthchecks, and the web container waits for them.

## 3. Bootstrap the country

```bash
docker compose exec web python manage.py bootstrap --country NGA \
  --admin-username admin --admin-password '<a long password>' \
  --print-enrolment-secret
```

This resolves the profile, records the country, loads a bundled geo pack if one exists,
reports the role definitions, and creates the first administrator. It is idempotent, so
re-running it reports what already exists rather than duplicating it.

It will not invent a credential. Without `--admin-password` no account is created, and the
password must be at least 12 characters.

If no geo pack ships for your country, bootstrap says so and prints the import command.
See [ONBOARDING_A_COUNTRY.md](./ONBOARDING_A_COUNTRY.md).

## 4. Put TLS in front

Nothing in the compose file terminates TLS. With Caddy, which obtains a certificate
automatically:

```
amr.example.gov {
    reverse_proxy 127.0.0.1:8000
}
```

With nginx, terminate TLS and proxy to `127.0.0.1:8000`, forwarding `Upgrade` and
`Connection` headers — the desktop bridge is a WebSocket and will not work without them.

## Site enrolment

Two endpoints register a site and issue its bearer token. Both require
`AMRIT_ENROLMENT_SECRET`, supplied by the site as the `X-AMRIT-Enrolment-Secret` header.

A server with no secret set **refuses** enrolment rather than allowing it. That is
deliberate: issuing a site token also rotates it, so an unauthenticated caller who knew a
lab code could both impersonate a laboratory and cut off its sync in one request.

`AMRIT_ALLOW_UNAUTHENTICATED_ENROLMENT=1` restores the old behaviour for a deployment
mid-migration. While it is on, anyone who can reach the server can register sites and issue
tokens, and every request is logged as a warning. Turn it off as soon as the sites have the
secret.

### Enrolling a laboratory

Asking to join needs no credential; approving is the gate. A laboratory presses **Request
access** in its Sync Centre, the endpoint answers `202` with `"status": "pending"`, and
nothing exists in the registry yet. Requiring a shared secret to *ask* would mean handing the
same secret to every laboratory in the programme — a worse thing to have to protect than a
queue entry that grants nobody anything. One caller may open requests for ten distinct lab
codes an hour; retrying an existing request is free, because a desktop waiting for a decision
retries steadily and should.

Someone with `manage_sites` decides under **Registry → Sites** (the requests appear on the
registry page itself, with the full queue behind **Requests**). Each shows the name, country,
administrative codes, contact, app version and originating IP it arrived with. Approving is
what creates the site; declining keeps the row, so a laboratory turned down once can ask again
and the earlier decision stays on the record.

The path that *edits* a site the registry already has still requires
`AMRIT_ENROLMENT_SECRET`: that one can overwrite a live laboratory's name and geography.

### The two credentials

An approved laboratory holds two, and they travel by different routes on purpose.

| | Bearer token | Site token |
|---|---|---|
| Sent as | `Authorization: Bearer …` | `X-AMRIT-Site` |
| Reaches the site | over the network, collected by the installation | out of band, by you |
| Minted at | collection | approval |
| Stored as | SHA-256 hash | SHA-256 hash |

The desktop collects the bearer token itself, presenting the one-time **pickup token** it was
given when it filed the request. So an approval requires no copying and pasting, and knowing a
lab code gets an attacker nothing — collecting requires the secret held only by the
installation that asked. Collection is single-use: a replay is refused rather than quietly
rotating the credential and stranding the laboratory that already collected.

The site token is shown **once**, on the screen you land on after approving, and is never sent
down the enrolment channel. Carry it to the site administrator by whatever means your programme
uses for credentials — not in the same email as the server address. Compromising the enrolment
path therefore does not by itself yield anything that syncs. Once a site has one, every request
from it must carry it; a request that omits it is refused rather than waved through.

If you close that screen before noting the site token, it is gone: reset it under
**Registry → Sites → issue/rotate** to get a new one. Both credentials reset independently
there, each shown once, each written to the audit trail. Resetting either stops that site
syncing until the new value reaches it, which the screen says before you press the button.

### When the codes disagree

A site whose sync fails with `HTTP 403 {"error": "lab_code mismatch"}` is sending a code the
registry holds under a different name. The refusal now states which code the registry has and
both ways out, and the site's own screen shows that sentence rather than the raw body.

Fix it on the **server**: **Registry → Sites → rename**. On the desktop the lab code is the
parent key of a dozen local tables and is stamped on every isolate row, so renaming there
rewrites the laboratory's database; here it is one unique column. The rename retargets any
pending queries addressed to the old code, leaves the audit trail as it stands and appends
the change to it, and does not touch the token — the laboratory reconfigures nothing and its
next poll succeeds.

## Demo data

`AMRIT_SEED_DEMO=1` seeds sixteen fictional sites and one user per role **with passwords
published in this repository**. It is off by default. Do not enable it on a deployment that
holds real data — anyone who has read the source has a working login.

## Backups

```bash
ops/backup.sh /var/backups/amrit
```

Dumps the database and any uploaded media, with a SHA-256 beside each file. Copy them off
this machine: a backup on the same host survives a mistake but not a failure.

```bash
ops/restore.sh /var/backups/amrit/amrit-db-20260101T000000Z.dump
```

Rehearse the restore against a scratch deployment before you need it. A restore procedure
that has never been run is a hope, not a plan.

## Installing without internet access

Many ministries run with no outbound connectivity. Nothing in the running system requires
it: the country reference data, the AMR catalogue and the geo packs all ship in the image.

On a machine that does have access:

```bash
docker compose build
docker save postgres:17-alpine redis:7-alpine amrit-web:latest -o amrit-images.tar
```

Move `amrit-images.tar`, this repository and your `.env` across, then:

```bash
docker load -i amrit-images.tar
docker compose up -d
```

What will not work offline, by nature: fetching breakpoint tables from CLSI or EUCAST (use
the offline import instead), and map tiles unless you set `map.tile_url` to a tile server
you host.

## Running without Docker

```bash
cd server/amrit_central_server
pip install -r requirements.txt
export DATABASE_URL=postgres://amrit:password@localhost:5432/amrit_central
python manage.py migrate
python manage.py bootstrap --country IN --admin-username admin --admin-password '<password>'
daphne -b 127.0.0.1 -p 8000 central.asgi:application
```

Use `daphne`, not a WSGI server: the desktop bridge is a WebSocket and gunicorn will drop
it.

A `sqlite:` `DATABASE_URL` is supported for evaluation and now honours the path you give
it — `sqlite:///local.db` is relative to the project, `sqlite:////tmp/x.db` absolute. Use
PostgreSQL for anything real.

## Health

`GET /health/` returns 200 when the application is serving. The web container uses it as
its Docker healthcheck.
