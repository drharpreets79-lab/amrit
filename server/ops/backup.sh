#!/usr/bin/env bash
# Back up the AMRIT Central database and uploaded media.
#
# A surveillance system of record without a rehearsed restore has a backup it cannot rely
# on. Run ops/restore.sh against a scratch database at least once before trusting this.
#
#   ops/backup.sh [destination-directory]
set -euo pipefail

DESTINATION="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
COMPOSE="${COMPOSE:-docker compose}"
DB_SERVICE="${DB_SERVICE:-db}"
WEB_SERVICE="${WEB_SERVICE:-web}"

mkdir -p "$DESTINATION"

: "${POSTGRES_USER:=amrit}"
: "${POSTGRES_DB:=amrit_central}"

ARCHIVE="$DESTINATION/amrit-db-$STAMP.dump"
echo "[backup] dumping $POSTGRES_DB…"
# Custom format: compressed, and restorable selectively.
$COMPOSE exec -T "$DB_SERVICE" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$ARCHIVE"

MEDIA="$DESTINATION/amrit-media-$STAMP.tar.gz"
echo "[backup] archiving uploaded media…"
$COMPOSE exec -T "$WEB_SERVICE" tar czf - -C /app media > "$MEDIA" 2>/dev/null || {
  echo "[backup] no media directory yet; skipping"
  rm -f "$MEDIA"
}

# A checksum so a corrupted or truncated copy is detected before it is relied on.
for file in "$ARCHIVE" "${MEDIA:-}"; do
  [[ -f "$file" ]] || continue
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$file" > "$file.sha256"
  else shasum -a 256 "$file" > "$file.sha256"; fi
done

echo "[backup] wrote:"
ls -lh "$DESTINATION" | grep "$STAMP"
echo
echo "[backup] Store this off the machine that produced it. A backup on the same host"
echo "[backup] survives a mistake but not a failure."
