-- ============================================================
-- Local/CI shim: fabricates the parts of Supabase that vanilla
-- Postgres does not have, so the migration set can be applied and
-- tested in a throwaway container.
--
-- NEVER run this against Supabase or production. It is loaded only
-- by `make verify` and `make test`, before the migrations.
-- ============================================================

create schema if not exists auth;

-- Mirrors the columns migration 0011's signup trigger reads. phone is
-- deliberately typed as bare text because that is how Supabase stores it:
-- '919876543210', with no '+'. The trigger has to add one, and this shim
-- would hide that bug if it stored E.164.
create table if not exists auth.users (
  id                  uuid primary key,
  email               text,
  phone               text,
  raw_user_meta_data  jsonb
);

alter table auth.users add column if not exists phone text;
alter table auth.users add column if not exists raw_user_meta_data jsonb;

-- Supabase derives this from the request JWT. This mirrors Supabase's own
-- definition, which reads BOTH shapes, because two callers set two
-- different GUCs:
--
--   request.jwt.claim.sub   what a SQL test sets by hand:
--                             set local request.jwt.claim.sub = '<uuid>';
--   request.jwt.claims      what PostgREST v9+ sets, the whole claim set
--                           as one JSON object
--
-- Reading only the first is why `make test-api` first saw every staff
-- request answered 403: auth.uid() was null under a real PostgREST, so
-- is_staff() was false and RLS believed nobody was signed in. The SQL
-- invariants could not have caught that -- they set the GUC themselves.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;

-- Supabase configures these defaults on a fresh project; RLS, not
-- the grant, is what actually gates browser access.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
