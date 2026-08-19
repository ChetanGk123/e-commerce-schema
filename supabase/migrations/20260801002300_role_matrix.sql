-- ============================================================
-- 0023  staff_users.role starts meaning something
--
-- Until now `staff_all` granted every active staff member full
-- read/write on all 51 tables, whatever their role, and README.md said
-- so under "Known accepted risk". The sharpest edge of that was not
-- cost_price: it was that a warehouse account could UPDATE its own
-- staff_users row and set role = 'owner'. Straight privilege
-- escalation, one PostgREST call, no admin UI involved.
--
-- This replaces the blanket policy on the tables that carry money,
-- identity or configuration. Everything else keeps staff_all, which is
-- the deliberate choice: a matrix that denies a role a table it needs
-- shows up as a 403 on a screen someone uses every day, and the point
-- of this migration is to close the sharp edges rather than to relitigate
-- all 51 tables at once.
--
-- WHAT THIS CANNOT DO, stated plainly so nobody reads more into it.
-- cost_price is a COLUMN, and every staff member connects to Postgres as
-- the same `authenticated` role -- PostgREST takes that from the JWT's
-- `role` claim, which GoTrue issues, not from staff_users.role. RLS is
-- row-level; column privileges are per database role. So "warehouse can
-- read variants but not their cost" is not expressible here. It needs a
-- database role per staff role and JWTs that carry it, which is a much
-- larger change than this. product_variants therefore keeps staff_all
-- and README.md's caveat still applies to that one column.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- Which role is the caller?
--
-- security definer for the same reason is_staff() is: the caller may
-- not be able to read staff_users at all once the policies below apply,
-- and a permission check that depends on the permission it is checking
-- can only fail closed in confusing ways.
-- ------------------------------------------------------------

create or replace function has_staff_role(variadic p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from staff_users s
    where s.id = auth.uid()
      and s.is_active
      and s.role = any(p_roles)
  )
$$;

revoke execute on function has_staff_role(variadic text[]) from public;
grant  execute on function has_staff_role(variadic text[]) to authenticated;

comment on function has_staff_role(variadic text[]) is
  'True when the caller is active staff holding one of the named roles. '
  'Definer because the policies below may deny the caller staff_users.';

-- ------------------------------------------------------------
-- staff_users -- the privilege escalation
--
-- Owner and admin manage the team. Everyone else may read their own row
-- and nothing else.
--
-- That self-read is not a convenience. apps/api's requireStaff() looks
-- the caller up in this table on every admin request; without it every
-- non-owner is locked out of the entire admin surface. It is also what
-- keeps the is_active check in requireStaff load-bearing rather than
-- redundant, which src/auth.ts already anticipated in a comment.
-- ------------------------------------------------------------

drop policy if exists staff_all on staff_users;

create policy staff_manage_team on staff_users
  for all to authenticated
  using (has_staff_role('owner', 'admin'))
  with check (has_staff_role('owner', 'admin'));

create policy staff_read_self on staff_users
  for select to authenticated
  using (id = auth.uid());

-- ------------------------------------------------------------
-- store_settings -- the GSTIN on every invoice, and the COD switch
--
-- Readable by all staff: screens across the admin need the store name,
-- the free-shipping threshold and whether COD is on. Writable by owner
-- and admin only, which matches what apps/api already enforces at the
-- route with requireRole -- this is the same rule where PostgREST can
-- see it too.
-- ------------------------------------------------------------

drop policy if exists staff_all on store_settings;

create policy settings_read on store_settings
  for select to authenticated using (is_staff());

create policy settings_write on store_settings
  for all to authenticated
  using (has_staff_role('owner', 'admin'))
  with check (has_staff_role('owner', 'admin'));

-- ------------------------------------------------------------
-- discounts and gift_cards -- money someone can mint
--
-- A gift card is a liability the store has to honour and a discount is
-- margin given away. Both are readable by any staff member, because
-- support has to be able to explain why an order was cheaper than the
-- list price. Neither is creatable below manager.
-- ------------------------------------------------------------

drop policy if exists staff_all on discounts;

create policy discounts_read on discounts
  for select to authenticated using (is_staff());

create policy discounts_write on discounts
  for all to authenticated
  using (has_staff_role('owner', 'admin', 'manager'))
  with check (has_staff_role('owner', 'admin', 'manager'));

drop policy if exists staff_all on gift_cards;

create policy gift_cards_read on gift_cards
  for select to authenticated using (is_staff());

create policy gift_cards_write on gift_cards
  for all to authenticated
  using (has_staff_role('owner', 'admin', 'manager'))
  with check (has_staff_role('owner', 'admin', 'manager'));

-- ------------------------------------------------------------
-- customers -- the PII
--
-- Warehouse is the one role with no reason to hold a customer list.
-- Picking and packing needs the address on the order, which is a
-- snapshot on orders and shipments and stays reachable; it does not
-- need every address that customer has ever used, their phone number or
-- their order history.
--
-- addresses follows customers for the same reason and by the same rule.
-- ------------------------------------------------------------

drop policy if exists staff_all on customers;

create policy customers_staff on customers
  for all to authenticated
  using (has_staff_role('owner', 'admin', 'manager', 'support'))
  with check (has_staff_role('owner', 'admin', 'manager', 'support'));

drop policy if exists staff_all on addresses;

-- The customer's own policy (own_addresses) is untouched and still
-- applies; this is only the staff half of the table's access.
create policy addresses_staff on addresses
  for all to authenticated
  using (has_staff_role('owner', 'admin', 'manager', 'support'))
  with check (has_staff_role('owner', 'admin', 'manager', 'support'));

commit;
