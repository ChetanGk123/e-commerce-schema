-- ============================================================
-- 0034  One definition of "in use", and collections use it too
--
-- T10 of docs/image-management.md, plus a bug the task uncovered.
--
-- THE BUG. 0029's trigger asks "is any product_images row still using
-- this URL" before queueing an object for collection, and 0030's claim
-- asks the same. Both were written when product_images was the only
-- table holding image URLs. It is not: collections.image_url has always
-- been free text, and an admin pasting a product's photograph into a
-- collection's hero image is not exotic -- it is the obvious way to make
-- the collection look like the thing it collects.
--
-- In that state, removing the product image queued an object the
-- collection still displayed, and the sweeper duly removed it. A broken
-- image on a live merchandising page, caused by a delete that looked
-- entirely unrelated.
--
-- 0031 already defines "in use" for precisely this reason, and its
-- comment says a column missing from it is a column whose images get
-- collected. The trigger and the claim were that column, in function
-- form. Both now ask referenced_objects(), so there is one answer and
-- adding a table changes one place.
--
-- THE FEATURE. Collections get what product images already have:
-- replacing or removing the picture queues the old object. Without it
-- every re-branded collection leaves its previous hero image in the
-- bucket until the reconciler finds it a week later -- which works, and
-- is a week of paying for something nothing points at.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- product_images, now asking the shared question
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
    -- referenced_objects(), not product_images: a URL a collection still
    -- points at is in use, however it came to be shared.
    and not exists (select 1 from referenced_objects() r where r.url = d.url)
  on conflict (url) do nothing;

  return null;
end $$;

-- ------------------------------------------------------------
-- collections
--
-- TWO FUNCTIONS, NOT ONE, and the reason is a Postgres rule worth
-- knowing: "transition tables cannot be specified for triggers with
-- column lists". `after update of image_url ... referencing old table`
-- is rejected outright, so a statement-level trigger cannot also be
-- narrowed to a column.
--
-- Given the choice, the transition table wins. Narrowing to the column
-- was only an optimisation -- avoiding the question on every unrelated
-- edit -- and the same saving is available by comparing old to new,
-- which needs both transition tables. That is possible on UPDATE and not
-- on DELETE, where there is no new row, hence two functions rather than
-- one that guesses which tables exist.
--
-- `is distinct from` rather than `<>`: a picture being cleared to null
-- is exactly the case that orphans an object, and `<>` answers null
-- there, which is not true.
-- ------------------------------------------------------------

create or replace function enqueue_replaced_collection_image()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into storage_gc_queue (url)
  select distinct o.image_url
  from old_rows o
  join new_rows n on n.id = o.id
  where o.image_url is not null
    and o.image_url <> ''
    -- Unchanged means nothing was let go of. A collection renamed forty
    -- times keeps its picture and asks nothing.
    and o.image_url is distinct from n.image_url
    and not exists (select 1 from referenced_objects() r where r.url = o.image_url)
  on conflict (url) do nothing;

  return null;
end $$;

create or replace function enqueue_deleted_collection_image()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into storage_gc_queue (url)
  select distinct o.image_url
  from old_rows o
  where o.image_url is not null
    and o.image_url <> ''
    and not exists (select 1 from referenced_objects() r where r.url = o.image_url)
  on conflict (url) do nothing;

  return null;
end $$;

drop trigger if exists trg_gc_collection_image_upd on collections;
drop trigger if exists trg_gc_collection_image_del on collections;

create trigger trg_gc_collection_image_upd
  after update on collections
  referencing old table as old_rows new table as new_rows
  for each statement
  execute function enqueue_replaced_collection_image();

create trigger trg_gc_collection_image_del
  after delete on collections
  referencing old table as old_rows
  for each statement
  execute function enqueue_deleted_collection_image();

revoke execute on function enqueue_replaced_collection_image() from public;
revoke execute on function enqueue_deleted_collection_image()  from public;

-- ------------------------------------------------------------
-- The claim, asking the same question
--
-- Identical reasoning: between queueing and sweeping the object may have
-- become referenced again -- by a re-upload, or by a collection adopting
-- it. Only referenced_objects() knows about both.
-- ------------------------------------------------------------

create or replace function claim_storage_gc(
  p_limit   int default 50,
  p_give_up int default 20
)
returns table (id uuid, url text, attempts int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  delete from storage_gc_queue q
  where exists (select 1 from referenced_objects() r where r.url = q.url);

  return query
  with claimed as (
    select q.id
    from storage_gc_queue q
    where q.attempts < p_give_up
    order by q.queued_at
    limit greatest(1, least(coalesce(p_limit, 50), 500))
    for update skip locked
  )
  update storage_gc_queue q
  set attempts = q.attempts + 1
  from claimed c
  where q.id = c.id
  returning q.id, q.url, q.attempts;
end $$;

commit;
