#!/usr/bin/env bash
#
# Backs up a Postgres container: roles first, then the database.
#
#   scripts/backup.sh supabase-db-1 /srv/backups
#   scripts/backup.sh ecomm-verify  dist/backup      # what the drill runs
#
# TWO FILES, AND THE FIRST ONE IS THE ONE PEOPLE FORGET.
#
# Every RLS policy in this schema is written `to authenticated`, or checks
# a role PostgREST SETs from the JWT. Restore the database into a cluster
# where `anon`, `authenticated` and `service_role` do not exist and the
# restore does not fail -- it half-succeeds, and you find out when the
# storefront returns 500 on every read. pg_dump does not include roles;
# they are cluster-global. Hence pg_dumpall --roles-only.
#
# WHAT IS NOT IN HERE, said plainly:
#
#   Product images, if Storage is on a local volume rather than an
#   S3-compatible backend. That volume is a separate backup and nothing
#   here will tell you it is missing.
#
#   Anything that happened after it ran. This is a snapshot, not
#   point-in-time recovery. For PITR run WAL-G or pgBackRest against the
#   same container -- see docs/setup.md C5.
#
# Custom format (-Fc) rather than plain SQL: it is compressed, and
# pg_restore can be pointed at one table out of it at 3am without
# replaying the whole file.

set -euo pipefail

CONTAINER="${1:?usage: backup.sh <container> <outdir>}"
OUTROOT="${2:?usage: backup.sh <container> <outdir>}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-postgres}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUTROOT/$STAMP"
mkdir -p "$OUT"

echo "==> backing up $CONTAINER -> $OUT" >&2

# Roles are cluster-global, so this is a pg_dumpall and not a pg_dump.
# --no-role-passwords keeps hashes out of a file that is about to be
# copied off-host; the roles come back without passwords, and restore.sh
# says so rather than leaving it to be discovered.
docker exec "$CONTAINER" pg_dumpall -U "$PGUSER" --roles-only --no-role-passwords \
  > "$OUT/roles.sql"

docker exec "$CONTAINER" pg_dump -U "$PGUSER" -d "$PGDATABASE" -Fc \
  > "$OUT/database.dump"

# A truncated dump is the failure this catches. A shell redirect out of
# `docker exec` will happily leave a short file if the container dies
# mid-stream, and pg_restore only objects to it at restore time -- which,
# without this line, is during the incident.
#
# Read back through the container, not the host: the host is not
# guaranteed to have Postgres client tools at all, and a check that
# silently means "pg_restore is not installed here" is worse than no
# check -- it fails every good backup and would be turned off by Friday.
if ! docker exec -i "$CONTAINER" pg_restore --list > /dev/null 2>&1 < "$OUT/database.dump"; then
  echo "==> BACKUP UNREADABLE: pg_restore cannot list $OUT/database.dump" >&2
  exit 1
fi

printf '==> roles.sql      %s bytes\n' "$(wc -c < "$OUT/roles.sql" | tr -d ' ')" >&2
printf '==> database.dump  %s bytes\n' "$(wc -c < "$OUT/database.dump" | tr -d ' ')" >&2

# The path, on stdout and alone, so a caller can capture it.
echo "$OUT"
