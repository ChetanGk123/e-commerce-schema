-- ============================================================
-- triggers.sql -- the schema's invariants, enforced in the database
-- Run AFTER ecommerce-schema-full.sql (and before rls-policies.sql)
--
-- What this gives you:
--   1. updated_at maintained automatically
--   2. variant.stock kept in sync with the inventory ledger,
--      with a built-in oversell guard
--   3. options_signature maintained, so duplicate-combination
--      protection fires without app cooperation
--   4. price_history captured on every price change
--   5. next_invoice_number(): gap-free GST numbering in one call
--   6. Append-only guards on ledgers and legal documents
-- ============================================================

-- 1 ----------------------------------------------------------
-- updated_at, everywhere it exists

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger trg_touch_products
  before update on products
  for each row execute function set_updated_at();
create trigger trg_touch_variants
  before update on product_variants
  for each row execute function set_updated_at();
create trigger trg_touch_carts
  before update on carts
  for each row execute function set_updated_at();
create trigger trg_touch_pincodes
  before update on serviceable_pincodes
  for each row execute function set_updated_at();
create trigger trg_touch_settings
  before update on store_settings
  for each row execute function set_updated_at();
create trigger trg_touch_tickets
  before update on support_tickets
  for each row execute function set_updated_at();
create trigger trg_touch_comm_prefs
  before update on communication_preferences
  for each row execute function set_updated_at();

-- 2 ----------------------------------------------------------
-- The ledger writes the cache. Never update variant.stock directly:
-- insert an inventory_movements row and this trigger keeps the
-- cached total correct. Because product_variants.stock has
-- CHECK (stock >= 0), a sale that would oversell fails the whole
-- transaction -- that IS the oversell guard.
-- (Corrections are new 'adjustment' entries, never edits: see #6.)

create or replace function apply_inventory_movement()
returns trigger language plpgsql as $$
begin
  update product_variants
  set stock = stock + new.quantity
  where id = new.variant_id;
  return null;
end $$;

create trigger trg_apply_movement
  after insert on inventory_movements
  for each row execute function apply_inventory_movement();

-- 3 ----------------------------------------------------------
-- Recompute options_signature whenever a variant's option values
-- change. Statement-level with transition tables: insert ALL of a
-- variant's option values in ONE insert statement and the signature
-- is computed once, cleanly -- then the unique index
-- (product_id, options_signature) rejects duplicate combinations
-- with no app code involved.

create or replace function refresh_signature_ins()
returns trigger language plpgsql as $$
begin
  update product_variants v
  set options_signature = (
    select string_agg(vov.option_value_id::text, '|'
                      order by vov.option_value_id)
    from variant_option_values vov
    where vov.variant_id = v.id)
  where v.id in (select distinct variant_id from new_rows);
  return null;
end $$;

create trigger trg_signature_ins
  after insert on variant_option_values
  referencing new table as new_rows
  for each statement execute function refresh_signature_ins();

create or replace function refresh_signature_del()
returns trigger language plpgsql as $$
begin
  update product_variants v
  set options_signature = (
    select string_agg(vov.option_value_id::text, '|'
                      order by vov.option_value_id)
    from variant_option_values vov
    where vov.variant_id = v.id)
  where v.id in (select distinct variant_id from old_rows);
  return null;
end $$;

create trigger trg_signature_del
  after delete on variant_option_values
  referencing old table as old_rows
  for each statement execute function refresh_signature_del();

-- 4 ----------------------------------------------------------
-- Price history, captured automatically. (changed_by stays null
-- from the trigger; the admin app can attribute changes by writing
-- audit_logs, or you can drop this trigger and insert rows from
-- app code if you prefer attribution here.)

create or replace function log_price_change()
returns trigger language plpgsql as $$
begin
  if new.price is distinct from old.price then
    insert into price_history (variant_id, old_price, new_price)
    values (new.id, old.price, new.price);
  end if;
  return new;
end $$;

create trigger trg_price_history
  after update on product_variants
  for each row execute function log_price_change();

-- 5 ----------------------------------------------------------
-- GST invoice numbering.
-- current_fy(): Indian financial year, Apr 2026 - Mar 2027 -> '2026-27'

create or replace function current_fy(d date default current_date)
returns text language sql stable as $$
  select case
    when extract(month from d) >= 4 then
      format('%s-%s', extract(year from d)::int,
             to_char((extract(year from d)::int + 1) % 100, 'FM00'))
    else
      format('%s-%s', extract(year from d)::int - 1,
             to_char(extract(year from d)::int % 100, 'FM00'))
  end
$$;

-- Gap-free and concurrency-safe: ON CONFLICT UPDATE takes a row
-- lock that serialises simultaneous invoices, and a rolled-back
-- invoice rolls its number back with it. Call inside the same
-- transaction that inserts the invoice.

create or replace function next_invoice_number(p_fy text default current_fy())
returns text language plpgsql as $$
declare n int;
begin
  insert into invoice_sequences (fy, last_number)
  values (p_fy, 1)
  on conflict (fy) do update
    set last_number = invoice_sequences.last_number + 1
  returning last_number into n;
  return format('INV/%s/%s', p_fy, lpad(n::text, 5, '0'));
end $$;

-- 6 ----------------------------------------------------------
-- Append-only guards. Ledgers and history tables can be added to,
-- never edited -- not even from the Supabase dashboard, because
-- triggers (unlike RLS) apply to every role.

create or replace function forbid_change()
returns trigger language plpgsql as $$
begin
  raise exception '% is append-only: % not allowed',
    tg_table_name, tg_op;
end $$;

create trigger trg_lock_inventory
  before update or delete on inventory_movements
  for each row execute function forbid_change();
create trigger trg_lock_credit
  before update or delete on credit_ledger
  for each row execute function forbid_change();
create trigger trg_lock_giftcard_txn
  before update or delete on gift_card_transactions
  for each row execute function forbid_change();
create trigger trg_lock_order_events
  before update or delete on order_events
  for each row execute function forbid_change();
create trigger trg_lock_price_history
  before update or delete on price_history
  for each row execute function forbid_change();
create trigger trg_lock_audit
  before update or delete on audit_logs
  for each row execute function forbid_change();
create trigger trg_lock_invoice_lines
  before update or delete on invoice_lines
  for each row execute function forbid_change();

-- Invoices: deletes always forbidden; the only permitted update is
-- setting pdf_url after the PDF is generated. Mistakes get a
-- credit_note, not an edit.

create or replace function protect_invoice()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'invoices are permanent legal documents: delete not allowed';
  end if;
  if to_jsonb(new) - 'pdf_url' is distinct from to_jsonb(old) - 'pdf_url' then
    raise exception 'invoices are immutable: only pdf_url may be updated (issue a credit_note instead)';
  end if;
  return new;
end $$;

create trigger trg_protect_invoices
  before update or delete on invoices
  for each row execute function protect_invoice();