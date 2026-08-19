-- ============================================================
-- 0024  A category cannot be its own ancestor
--
-- categories_no_self_parent stops A -> A. Nothing stopped A -> B -> A,
-- and a cycle there is not a cosmetic problem: every breadcrumb, every
-- "products in this category and its children" query and every menu
-- render walks parent_id, so one cycle is an infinite loop in whatever
-- reads it. It is also close to unrecoverable through an API that can
-- only set one parent at a time.
--
-- In the database rather than in the route because that is where the
-- other rules are: the categories in this store today were created in
-- psql, and a guard the API holds is a guard psql does not.
-- ============================================================

begin;

create or replace function guard_category_cycle()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  cycles boolean;
begin
  if new.parent_id is null then
    return new;
  end if;

  -- Walk up from the proposed parent. If this row is anywhere above it,
  -- attaching would close a loop.
  with recursive ancestry as (
    select c.id, c.parent_id, 1 as depth
    from categories c
    where c.id = new.parent_id
    union all
    select c.id, c.parent_id, a.depth + 1
    from categories c
    join ancestry a on c.id = a.parent_id
    -- Belt and braces: if a cycle already exists in the data, this
    -- recursion would not terminate on its own.
    where a.depth < 100
  )
  select exists (select 1 from ancestry where id = new.id) into cycles;

  if cycles then
    -- ECOM1 is this schema's "a refusal we wrote for a person to read".
    -- errors.ts forwards the message and uses the hint as the code.
    raise exception 'That would make the category its own ancestor.'
      using errcode = 'ECOM1', hint = 'category_cycle';
  end if;

  return new;
end $$;

create trigger trg_category_cycle
  before insert or update of parent_id on categories
  for each row execute function guard_category_cycle();

commit;
