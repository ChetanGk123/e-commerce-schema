-- ============================================================
-- 0002  Base functions (no table dependencies)
--
-- Only functions that reference no tables live here, so this
-- migration can run before any table exists. Table-dependent
-- functions (is_staff, next_invoice_number, the number
-- generators) are defined in the triggers migration, after the
-- tables they read.
--
-- SECURITY NOTE: every function in this project pins search_path
-- with pg_temp LAST. Postgres searches pg_temp first for relation
-- names when it is not named explicitly, so a SECURITY DEFINER
-- function with `set search_path = public` can be hijacked by a
-- user who creates a shadowing temp table. Putting pg_temp last
-- closes that. See the Postgres docs on writing SECURITY DEFINER
-- functions safely.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- updated_at maintenance
-- ------------------------------------------------------------

create or replace function set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end $$;

comment on function set_updated_at() is
  'BEFORE UPDATE trigger: stamps updated_at with now().';

-- ------------------------------------------------------------
-- Append-only guard
--
-- Ledgers and history tables can be added to, never edited. This
-- is a trigger rather than an RLS policy on purpose: triggers
-- apply to EVERY role, including the service key and the Supabase
-- dashboard. RLS does not.
-- ------------------------------------------------------------

create or replace function forbid_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception '% is append-only: % not allowed', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end $$;

comment on function forbid_change() is
  'BEFORE UPDATE OR DELETE trigger: makes a table append-only for all roles.';

-- ------------------------------------------------------------
-- Indian financial year: April 2026 - March 2027 -> '2026-27'
-- ------------------------------------------------------------

create or replace function current_fy(d date default current_date)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when extract(month from d) >= 4 then
      format('%s-%s', extract(year from d)::int,
             to_char((extract(year from d)::int + 1) % 100, 'FM00'))
    else
      format('%s-%s', extract(year from d)::int - 1,
             to_char(extract(year from d)::int % 100, 'FM00'))
  end
$$;

comment on function current_fy(date) is
  'Indian financial year label for a date, e.g. 2026-08-01 -> 2026-27.';

commit;
