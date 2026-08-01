#!/usr/bin/env bash
#
# Concatenates supabase/migrations/*.sql into a single runnable file.
#
# The migrations remain the source of truth. This output is GENERATED --
# regenerate it with `make bundle` rather than editing it, or the two
# will drift and you will have two schemas that disagree.
#
# Each migration wraps itself in begin;/commit;. Those are stripped and
# the whole bundle is wrapped in ONE transaction instead, so a single-file
# run is all-or-nothing: you get the complete schema or an untouched
# database, never half of one.
#
# Safe because every top-level wrapper is exactly `^begin;` / `^commit;`
# while plpgsql block openers are `^begin` with no semicolon.

set -euo pipefail

OUT="dist/schema.sql"
mkdir -p "$(dirname "$OUT")"

{
  cat <<'HEADER'
-- ============================================================
-- E-commerce schema -- complete, single file, runs top to bottom
-- Postgres 15+ / Supabase
--
--   psql "$DATABASE_URL" -f dist/schema.sql
--
-- or paste into the Supabase SQL editor.
--
-- ------------------------------------------------------------
-- GENERATED FILE -- DO NOT EDIT
--
-- Built from supabase/migrations/ by `make bundle`. Edit the
-- migrations and regenerate; edits made here are lost on the next
-- build and, worse, silently diverge from what actually ships.
--
-- Use this file for a FIRST install or a throwaway database. To
-- change a database that already exists, add a migration -- this
-- file only knows how to create things, not how to alter them.
-- ------------------------------------------------------------
--
-- The whole schema is one transaction. If any statement fails,
-- nothing is created.
--
-- Afterwards, two optional extras:
--   psql "$DATABASE_URL" -f supabase/jobs/retention.sql   (schedulers)
--   psql "$DATABASE_URL" -f supabase/seed.sql             (demo data)
-- ============================================================

begin;
HEADER

  for f in supabase/migrations/*.sql; do
    printf '\n\n-- ============================================================\n'
    printf -- '-- SOURCE: %s\n' "$(basename "$f")"
    printf -- '-- ============================================================\n\n'
    # Separate -e patterns rather than \| alternation: the GNU BRE
    # extension is not portable across grep implementations, and a
    # silently-unmatched pattern here leaves stray BEGIN statements
    # that turn the bundle into something other than one transaction.
    grep -v -e '^begin;$' -e '^commit;$' "$f"
  done

  printf '\n\ncommit;\n'
} > "$OUT"

printf '==> %s (%s lines, from %s migrations)\n' \
  "$OUT" "$(wc -l < "$OUT" | tr -d ' ')" \
  "$(ls supabase/migrations/*.sql | wc -l | tr -d ' ')"
