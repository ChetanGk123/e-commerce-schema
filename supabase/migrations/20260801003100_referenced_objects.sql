-- ============================================================
-- 0031  Everything the database still points at
--
-- T5 of docs/image-management.md, and the input to the reconciler.
--
-- The reconciler lists the bucket, subtracts this, and removes the
-- remainder -- unattended, against a bucket with no backup. So this
-- function is not a convenience view. **It is the definition of "in
-- use", and anything it forgets to mention is a file that gets
-- collected.**
--
-- Which is why it exists at all, rather than the reconciler writing two
-- queries inline: a new column holding image URLs must be added HERE, in
-- one place. Adding it late is not a missing feature, it is data loss.
-- If you are adding such a column, add it to this function in the same
-- migration, before the column holds anything.
--
-- WHAT IS IN:
--   product_images.url      the main one
--   collections.image_url   free text on a merchandising collection
--
-- WHAT IS DELIBERATELY OUT:
--   invoices.pdf_url        nothing writes it. Invoices are rendered as
--                           HTML and printed by the browser, so no PDF is
--                           ever stored (decision 2, 2026-08-20). Out on
--                           purpose; if that ever changes, this function
--                           changes first.
--   shipments.tracking_url  a courier's URL. Not ours, never was.
--
-- Returns URLs rather than object paths, for the same reason 0029 does:
-- which URLs belong to our bucket is decided by STORAGE_PUBLIC_URL and
-- STORAGE_BUCKET, which are environment the database does not have. One
-- parser, in apps/api, or the two drift -- and here the drift is
-- measured in deleted photographs.
-- ============================================================

begin;

create or replace function referenced_objects()
returns table (url text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- union, not union all: one URL used by two rows is one reference, and
  -- the caller only ever asks "is this in use".
  select p.url from product_images p
  where p.url is not null and p.url <> ''
  union
  select c.image_url from collections c
  where c.image_url is not null and c.image_url <> ''
$$;

comment on function referenced_objects() is
  'Every URL the database still points at. The reconciler removes what '
  'is NOT in here, so a column of image URLs missing from this function '
  'is a column whose images get collected. See docs/image-management.md.';

revoke execute on function referenced_objects() from public;

-- service_role only. The reconciler runs with no user present, and this
-- is a complete map of every asset the store holds.
grant execute on function referenced_objects() to service_role;

commit;
