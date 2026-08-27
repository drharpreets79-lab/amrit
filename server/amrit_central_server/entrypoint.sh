#!/usr/bin/env bash
set -euo pipefail

# Configuration is checked before anything is done, not after.
#
# These rules used to be enforced in the superuser step at the very end, so a container with
# a six-character password migrated the database, collected 570 static files and printed the
# whole demo account table before refusing — and then, under `restart: unless-stopped`, did
# all of it again every few seconds with the one line that mattered scrolling past between
# repeats of everything that did not. Failing here costs a second and puts the reason at the
# top of the log.
if [[ "${DJANGO_CREATE_SUPERUSER:-0}" == "1" ]]; then
  password="${DJANGO_SUPERUSER_PASSWORD:-}"
  if [[ -z "$password" ]]; then
    echo "[amrit-central] DJANGO_CREATE_SUPERUSER is set but DJANGO_SUPERUSER_PASSWORD is empty." >&2
    echo "[amrit-central] Set one in .env, or set DJANGO_CREATE_SUPERUSER=0 and create the" >&2
    echo "[amrit-central] account with 'docker compose run --rm web python manage.py bootstrap'." >&2
    exit 1
  fi
  if (( ${#password} < 12 )); then
    echo "[amrit-central] DJANGO_SUPERUSER_PASSWORD is ${#password} characters; at least 12 are required." >&2
    echo "[amrit-central] A short password on a reachable deployment is an open door, and the" >&2
    echo "[amrit-central] entrypoint will not shorten the rule for you. Generate one with:" >&2
    echo "[amrit-central]   python3 -c 'import secrets; print(secrets.token_urlsafe(18))'" >&2
    echo "[amrit-central] and put it in .env as DJANGO_SUPERUSER_PASSWORD, then recreate this" >&2
    echo "[amrit-central] container. Until then nothing else in this entrypoint runs." >&2
    exit 1
  fi
fi

echo "[amrit-central] migrating database…"
python manage.py migrate --noinput

echo "[amrit-central] collecting static files…"
python manage.py collectstatic --noinput || true

# Demo data is opt-in. It creates sixteen fictional sites and one user per role with
# passwords published in this repository, so seeding it into a real deployment hands
# anyone who has read the source a working login. Set AMRIT_SEED_DEMO=1 only for a
# demonstration or evaluation instance.
if [[ "${AMRIT_SEED_DEMO:-0}" == "1" ]]; then
  echo "[amrit-central] WARNING: seeding demo accounts with publicly known passwords."
  echo "[amrit-central] WARNING: do not do this on a deployment holding real data."
  # These used to end in `|| true`, so a seeder that failed left a deployment that booted,
  # answered /health/ and looked entirely well — with no users in it. Someone then spent a
  # long time being told their password was wrong by a login page that had nobody to let in.
  # An operator who asked for demo data and did not get it needs to hear about it.
  echo "[amrit-central] seeding demo sites + role users…"
  python manage.py seed_demo
  echo "[amrit-central] seeding action-plan threshold rules…"
  python manage.py seed_action_rules
  echo "[amrit-central] seeding dashboard KPI snapshots (+ auto action plans)…"
  python manage.py seed_dashboards
fi

if [[ "${DJANGO_CREATE_SUPERUSER:-0}" == "1" ]]; then
  python manage.py shell <<'PY'
import os
from django.contrib.auth import get_user_model
User = get_user_model()
username = os.environ.get("DJANGO_SUPERUSER_USERNAME", "admin")
email = os.environ.get("DJANGO_SUPERUSER_EMAIL", "admin@example.com")
password = os.environ.get("DJANGO_SUPERUSER_PASSWORD", "")
# Checked at the top of this entrypoint, where a bad value fails in a second instead of
# after every migration and seeder has run. Kept here too: this block must be safe to reach
# on its own, and refusing to invent a password is the whole point — a default such as
# "admin" on an internet-reachable deployment is an open door nobody remembers to close.
if not password or len(password) < 12:
    raise SystemExit(
        "DJANGO_SUPERUSER_PASSWORD must be set to at least 12 characters. "
        "Set it in .env, or set DJANGO_CREATE_SUPERUSER=0 and create the account with "
        "'manage.py bootstrap'."
    )
if not User.objects.filter(username=username).exists():
    User.objects.create_superuser(username=username, email=email, password=password)
    print(f"created superuser {username}")
else:
    print(f"superuser {username} already exists")
PY
fi

exec "$@"
