-- ============================================================
-- A fingerprint of a database, for comparing two of them
--
-- Used by `make restore-drill`: run this against the source and against
-- the restored copy, diff the two outputs, and any line that differs is
-- something the backup did not bring across.
--
-- WHY NOT JUST RUN 01_invariants.sql AGAINST THE RESTORE. Because that
-- file inserts its own fixtures, so it only runs against an empty
-- database -- and a backup worth rehearsing has data in it. More to the
-- point, the invariants test whether the SCHEMA is correct, which
-- `make test` already does on every run. What a restore has to prove is
-- a different thing: that it is faithful to the database it came from.
--
-- The four things a Supabase restore actually drops, in the order people
-- discover them:
--
--   ROLES. Cluster-global, so `pg_dump` does not contain them. Restore
--   without `pg_dumpall --roles-only` and every `to authenticated`
--   policy errors -- and pg_restore keeps going, leaving you all the
--   data and none of the access control.
--
--   POLICIES, AND WHETHER RLS IS STILL ON. The reason matching row
--   counts are not enough. A database with every row and no RLS is not a
--   restored store, it is a public one.
--
--   FUNCTIONS, BY SIGNATURE. checkout() and capture_payment() have both
--   been redefined across migrations; identity arguments are included so
--   an overload that failed to restore shows up rather than being masked
--   by a same-named survivor.
--
--   ROW COUNTS. Last, because it is the one everybody already checks.
--
-- Run it the same way against both:
--   psql -tAf supabase/tests/02_fingerprint.sql > a.txt
-- ============================================================

select 'role:' || rolname
from pg_roles
where rolname in ('anon', 'authenticated', 'service_role', 'authenticator')

union all

select 'policy:' || tablename || '.' || policyname
from pg_policies
where schemaname = 'public'

union all

-- Both flags: FORCE is what stops the owner -- every migration, job and
-- admin script -- from bypassing policies entirely, and it is exactly
-- the sort of attribute a restore can quietly leave off.
select 'rls:' || c.relname || '=' || c.relrowsecurity::text || c.relforcerowsecurity::text
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'

union all

select 'func:' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'

union all

-- query_to_xml is how a count runs against a table named by a row rather
-- than by the parser. The alternative is a plpgsql loop, which cannot be
-- piped straight into diff.
select 'table:' || tablename || '=' ||
       (xpath('/row/c/text()',
              query_to_xml(format('select count(*) c from public.%I', tablename),
                           false, true, '')))[1]::text
from pg_tables
where schemaname = 'public'

order by 1;
