-- ============================================================
-- 0032  An orphan has to be seen twice before it is collected
--
-- T7 of docs/image-management.md, and rail 1 of six.
--
-- Two decisions taken on 2026-08-20 are fine apart and sharp together:
-- the reconciler removes objects UNATTENDED, and the bucket has NO
-- BACKUP. There is no human between a mistake and permanent loss, so the
-- mistake has to be made unlikely rather than recoverable.
--
-- The mistake in question is not exotic. referenced_objects() returning
-- fewer rows than it should -- a migration mid-flight, a renamed column,
-- a revoked grant, a table momentarily unreadable -- makes real images
-- look unreferenced, and the reconciler then does exactly what it was
-- told.
--
-- So: a path is recorded the first time it looks orphaned, and collected
-- only if it STILL looks orphaned a confirmation window later. A query
-- that breaks produces a first sighting and nothing more; the next pass,
-- with the query working again, finds the path referenced and forgets
-- it. That window is what an unbacked bucket buys instead of a restore.
--
-- Deliberately NOT a queue. This is a memory of observations, and an
-- observation that stops being true has to be forgotten -- which is why
-- every pass clears sightings it did not re-observe. An image restored
-- from a backup, re-uploaded by hand, or re-attached to another product
-- starts its week again from zero.
-- ============================================================

begin;

create table if not exists storage_orphan_sightings (
  -- The object path, not a URL: by the time a path reaches here apps/api
  -- has already resolved it against the bucket, and there is nothing
  -- left to interpret.
  path          text primary key,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

comment on table storage_orphan_sightings is
  'Objects that looked unreferenced on some pass. Collected only after '
  'they still look unreferenced a confirmation window later, and '
  'forgotten the moment a pass does not see them. docs/image-management.md.';

alter table storage_orphan_sightings enable row level security;
alter table storage_orphan_sightings force row level security;

create policy storage_orphan_sightings_staff_r on storage_orphan_sightings
  for select to authenticated
  using (has_staff_role('owner', 'admin', 'manager', 'support'));

-- ------------------------------------------------------------
-- Record one pass, and say what is now safe to collect
--
-- Three things in one statement, so a pass cannot half-apply:
--
--   FORGET what this pass did not see. A path that has stopped looking
--   orphaned is not "still pending" -- it is in use, and its clock must
--   reset rather than pause. This is the line that makes a broken
--   referenced_objects() harmless.
--
--   REMEMBER what it did see, keeping the ORIGINAL first_seen_at. The
--   entire mechanism is that first sighting; refreshing it every pass
--   would mean nothing ever ages into being collectable.
--
--   RETURN only what has been waiting long enough.
--
-- An empty p_paths is a legitimate answer -- a bucket with no orphans --
-- and correctly forgets everything. It is the empty REFERENCE set that
-- is dangerous, and apps/api refuses that before calling this.
-- ------------------------------------------------------------

create or replace function record_orphan_sightings(
  p_paths   text[],
  p_confirm interval default '7 days'
)
returns table (path text, first_seen_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
-- The RETURNS TABLE names (path, first_seen_at) are in scope for the
-- whole body, so `on conflict (path)` below is ambiguous between the
-- output variable and the column. Prefer the column: every bare mention
-- of `path` here means the table's.
#variable_conflict use_column
begin
  delete from storage_orphan_sightings s
  where s.path <> all (coalesce(p_paths, array[]::text[]));

  insert into storage_orphan_sightings (path)
  select distinct unnest(coalesce(p_paths, array[]::text[]))
  on conflict (path) do update set last_seen_at = now();

  return query
  select s.path, s.first_seen_at
  from storage_orphan_sightings s
  where s.first_seen_at < now() - p_confirm
  order by s.first_seen_at;
end $$;

-- ------------------------------------------------------------
-- Forget the ones that were collected
--
-- Called with what was actually removed, never with what was planned. A
-- path whose deletion failed keeps its sighting and its original
-- first_seen_at, so it is still confirmed next pass and gets retried
-- rather than starting its week over.
-- ------------------------------------------------------------

create or replace function forget_orphan_sightings(p_paths text[])
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare removed int := 0;
begin
  delete from storage_orphan_sightings
  where path = any (coalesce(p_paths, array[]::text[]));
  get diagnostics removed = row_count;
  return removed;
end $$;

revoke execute on function record_orphan_sightings(text[], interval) from public;
revoke execute on function forget_orphan_sightings(text[])           from public;

-- service_role only. The reconciler runs with no user present, and
-- record_orphan_sightings is what decides an object may be collected.
grant execute on function record_orphan_sightings(text[], interval)  to service_role;
grant execute on function forget_orphan_sightings(text[])            to service_role;

commit;
