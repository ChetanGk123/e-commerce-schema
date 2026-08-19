#!/usr/bin/env bash
#
# Restores a backup.sh directory into a Postgres container.
#
#   scripts/restore.sh ecomm-restore dist/backup/20260819T174211Z
#
# ORDER IS NOT NEGOTIABLE. Roles first: the dump is full of GRANT and
# `create policy ... to authenticated`, and every one of those is an
# error against a cluster that has never heard of the role. Postgres
# keeps going after them, which is worse than stopping -- you end up with
# all the tables, all the data, and no access control.
#
# RESTORE INTO AN EMPTY DATABASE. Not the one having the incident. This
# script will not do that for you, deliberately: a restore tool that
# drops a live database is a tool that will one day drop the wrong one.
#
# ROLE PASSWORDS ARE NOT IN THE BACKUP (backup.sh passes
# --no-role-passwords). Set them after restoring or nothing can connect:
#
#   alter role authenticator with password '...';
#
# Supabase derives those from the secrets in template.toml, so on a real
# restore take them from there rather than inventing new ones.

set -euo pipefail

CONTAINER="${1:?usage: restore.sh <container> <backup-dir>}"
DIR="${2:?usage: restore.sh <container> <backup-dir>}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-postgres}"

[ -f "$DIR/roles.sql" ]     || { echo "no $DIR/roles.sql" >&2; exit 1; }
[ -f "$DIR/database.dump" ] || { echo "no $DIR/database.dump" >&2; exit 1; }

echo "==> restoring $DIR -> $CONTAINER"

# Roles. Deliberately not ON_ERROR_STOP: a role that already exists is
# fine and expected -- `postgres` is in every dump and in every fresh
# cluster -- so this step tolerates errors and the next one does not.
docker exec -i "$CONTAINER" psql -U "$PGUSER" -q -o /dev/null \
  < "$DIR/roles.sql" 2>/dev/null || true

# The database. --exit-on-error is the whole point: a restore that
# reports success while having skipped forty statements is how a backup
# gets believed for a year.
docker exec -i "$CONTAINER" pg_restore -U "$PGUSER" -d "$PGDATABASE" \
  --exit-on-error --no-owner \
  < "$DIR/database.dump"

echo "==> restored"
