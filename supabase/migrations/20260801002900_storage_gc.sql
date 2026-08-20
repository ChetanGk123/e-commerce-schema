-- ============================================================
-- 0029  Collecting images nothing points at any more
--
-- T1 of docs/image-management.md.
--
-- product_images has two ON DELETE CASCADE foreign keys:
--
--   product_id               -> products(id)
--   (variant_id, product_id) -> product_variants(id, product_id)
--
-- So deleting a product or a variant deletes its image rows, and the API
-- is not involved and cannot be -- there is no product-delete route, and
-- this store is administered in psql. A product with twelve photographs
-- is deleted, twelve rows disappear, twelve objects stay in the bucket
-- being billed, and nothing anywhere says so.
--
-- That is why this lives in the database. The instruction to delete an
-- object has to be recorded where the deletion actually happens, which
-- is here, not in a route handler that never ran.
--
-- Same shape as message_log and claim_outbox: enqueue inside the
-- transaction that caused it, drain outside. An HTTP call to storage
-- must not sit inside the transaction deleting the row -- it would hold
-- that transaction open for a network round trip, and a rollback cannot
-- un-delete an object.
--
-- WHY THIS STORES A URL AND NOT AN OBJECT PATH. The plan said parse the
-- path here, mirroring pathFromUrl() in storage.ts. That was wrong.
-- Which URLs belong to our bucket is decided by STORAGE_PUBLIC_URL and
-- STORAGE_BUCKET, which are environment, and the database has neither.
-- Duplicating that logic in SQL would give two parsers free to disagree
-- -- and disagreeing means either deleting somebody else's URL or
-- silently leaking our own. So the trigger records the URL verbatim and
-- apps/api decides what it means, using the one pathFromUrl() that
-- already exists.
-- ============================================================

begin;

create table if not exists storage_gc_queue (
  id         uuid primary key default gen_random_uuid(),
  -- The URL as it was stored on the row, not an object path. See above.
  url        text not null unique,
  queued_at  timestamptz not null default now(),
  attempts   int not null default 0,
  last_error text
);

comment on table storage_gc_queue is
  'Objects whose last product_images row was deleted. Drained by the '
  'jobs tick in apps/api/src/jobs.ts, which is where the environment '
  'knows which URLs belong to our bucket. See docs/image-management.md.';

-- The trigger asks "does any row still use this URL" once per deleted
-- row. Without this that is a sequential scan per photograph, on the
-- exact statement that deletes a product with a full gallery.
create index if not exists idx_product_images_url on product_images(url);

alter table storage_gc_queue enable row level security;
alter table storage_gc_queue force row level security;

-- Staff can watch the backlog. No write policy at all: the trigger below
-- is security definer and the sweeper runs as service_role, so there is
-- no version of this a signed-in shopper reaches.
create policy storage_gc_queue_staff_r on storage_gc_queue
  for select to authenticated
  using (has_staff_role('owner', 'admin', 'manager', 'support'));

-- ------------------------------------------------------------
-- Enqueue on delete
--
-- Statement-level with a transition table, not per row. A cascade
-- deleting a twelve-image gallery is one statement, and twelve separate
-- trigger invocations inserting twelve rows is the pattern this schema
-- avoids everywhere else.
--
-- THE `not exists` IS NOT DEFENSIVE PADDING. Two product_images rows may
-- carry the same URL -- nothing forbids it, and a hand-written insert in
-- psql is exactly how it happens. Deleting one of them must not queue an
-- object the other still displays. The check runs against the table as
-- it stands AFTER the delete, so it asks the right question: is anybody
-- still using this?
-- ------------------------------------------------------------

create or replace function enqueue_deleted_images()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into storage_gc_queue (url)
  select distinct d.url
  from deleted d
  where d.url is not null
    and d.url <> ''
    and not exists (select 1 from product_images p where p.url = d.url)
  -- Already queued. The same object cannot need deleting twice, and a
  -- second row would only be a second failed attempt to delete nothing.
  on conflict (url) do nothing;

  return null;
end $$;

drop trigger if exists trg_gc_product_images on product_images;

create trigger trg_gc_product_images
  after delete on product_images
  referencing old table as deleted
  for each statement
  execute function enqueue_deleted_images();

revoke execute on function enqueue_deleted_images() from public;

commit;
