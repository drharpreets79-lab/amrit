#!/usr/bin/env bash
# Restore an AMRIT Central backup.
#
#   ops/restore.sh backups/amrit-db-20260101T000000Z.dump
#
# This REPLACES the current database. Rehearse it against a scratch deployment first: a
# restore procedure that has never been run is a hope, not a plan.
set -euo pipefail

ARCHIVE="${1:?usage: ops/restore.sh <dump-file>}"
COMPOSE="${COMPOSE:-docker compose}"
DB_SERVICE="${DB_SERVICE:-db}"
: "${POSTGRES_USER:=amrit}"
: "${POSTGRES_DB:=amrit_central}"

[[ -f "$ARCHIVE" ]] || { echo "no such file: $ARCHIVE" >&2; exit 1; }

if [[ -f "$ARCHIVE.sha256" ]]; then
  echo "[restore] verifying checksum…"
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c "$ARCHIVE.sha256"
  else shasum -a 256 -c "$ARCHIVE.sha256"; fi
else
  echo "[restore] WARNING: no .sha256 beside the archive; integrity is unverified."
fi

echo
echo "This REPLACES the contents of database '$POSTGRES_DB'."
read -r -p "Type the database name to confirm: " CONFIRM
[[ "$CONFIRM" == "$POSTGRES_DB" ]] || { echo "aborted"; exit 1; }

echo "[restore] restoring…"
$COMPOSE exec -T "$DB_SERVICE" pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists < "$ARCHIVE"

echo "[restore] applying any migrations newer than the backup…"
$COMPOSE exec -T web python manage.py migrate --noinput

echo "[restore] done. Check the dashboards before returning the deployment to service."
