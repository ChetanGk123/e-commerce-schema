-- ============================================================
-- 0008  Functions & triggers: the schema's invariants
--
-- Everything here is enforced in the database rather than the
-- application, because these are the rules that cost money when
-- they are broken and because more than one client will eventually
-- write to these tables.
-- ============================================================

begin;

-- ============================================================
-- 1. updated_at, everywhere it exists
-- ============================================================

create trigger trg_touch_staff before update on staff_users
  for each row execute function set_updated_at();
create trigger trg_touch_customers before update on customers
  for each row execute function set_updated_at();
create trigger trg_touch_addresses before update on addresses
  for each row execute function set_updated_at();
create trigger trg_touch_comm_prefs before update on communication_preferences
  for each row execute function set_updated_at();
create trigger trg_touch_categories before update on categories
  for each row execute function set_updated_at();
create trigger trg_touch_products before update on products
  for each row execute function set_updated_at();
create trigger trg_touch_variants before update on product_variants
  for each row execute function set_updated_at();
create trigger trg_touch_collections before update on collections
  for each row execute function set_updated_at();
create trigger trg_touch_orders before update on orders
  for each row execute function set_updated_at();
create trigger trg_touch_payments before update on payments
  for each row execute function set_updated_at();
create trigger trg_touch_carts before update on carts
  for each row execute function set_updated_at();
create trigger trg_touch_shipments before update on shipments
  for each row execute function set_updated_at();
create trigger trg_touch_discounts before update on discounts
  for each row execute function set_updated_at();
create trigger trg_touch_returns before update on return_requests
  for each row execute function set_updated_at();
create trigger trg_touch_refunds before update on refunds
  for each row execute function set_updated_at();
create trigger trg_touch_gift_cards before update on gift_cards
  for each row execute function set_updated_at();
create trigger trg_touch_reviews before update on reviews
  for each row execute function set_updated_at();
create trigger trg_touch_pincodes before update on serviceable_pincodes
  for each row execute function set_updated_at();
create trigger trg_touch_tickets before update on support_tickets
  for each row execute function set_updated_at();
create trigger trg_touch_enquiries before update on product_enquiries
  for each row execute function set_updated_at();
create trigger trg_touch_settings before update on store_settings
  for each row execute function set_updated_at();

-- ============================================================
-- 2. Inventory: the ledger writes the cache
--
-- Never update product_variants.stock directly. Insert an
-- inventory_movements row and this trigger keeps the cached total
-- correct. Because product_variants.stock has CHECK (stock >= 0), a
-- sale that would oversell fails the whole transaction -- that IS
-- the oversell guard, and the row lock taken by this UPDATE is what
-- makes it safe under concurrency.
--
-- Corrections are new 'adjustment' rows, never edits (see §10).
-- ============================================================

create or replace function apply_inventory_movement()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  update product_variants
  set stock = stock + new.quantity
  where id = new.variant_id;
  return null;
end $$;

create trigger trg_apply_movement
  after insert on inventory_movements
  for each row execute function apply_inventory_movement();

-- ============================================================
-- 3. options_signature
--
-- Statement-level with transition tables: insert ALL of a variant's
-- option values in ONE statement and the signature is computed once,
-- cleanly. The unique index (product_id, options_signature) then
-- rejects duplicate combinations with no application cooperation.
--
-- Inserting them one row at a time is still supported but is a
-- known footgun: an intermediate signature can collide with another
-- variant's final one and raise a spurious unique violation. Batch
-- the insert.
-- ============================================================

create or replace function refresh_signature()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  update product_variants v
  set options_signature = (
    select string_agg(vov.option_value_id::text, '|'
                      order by vov.option_value_id)
    from variant_option_values vov
    where vov.variant_id = v.id)
  where v.id in (select variant_id from changed_rows);
  return null;
end $$;

create trigger trg_signature_ins
  after insert on variant_option_values
  referencing new table as changed_rows
  for each statement execute function refresh_signature();

create trigger trg_signature_del
  after delete on variant_option_values
  referencing old table as changed_rows
  for each statement execute function refresh_signature();

-- ============================================================
-- 4. Price history
-- ============================================================

create or replace function log_price_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  insert into price_history (variant_id, old_price, new_price)
  values (new.id, old.price, new.price);
  return null;
end $$;

-- The WHEN clause matters: without it every stock movement fires
-- this trigger, because inventory updates touch the same row.
create trigger trg_price_history
  after update of price on product_variants
  for each row
  when (old.price is distinct from new.price)
  execute function log_price_change();

-- ============================================================
-- 5. Number generators
--
-- Invoice numbers must be gap-free per financial year: Postgres
-- sequences leak numbers on rollback and GST rules do not allow
-- that. ON CONFLICT DO UPDATE takes a row lock that serialises
-- concurrent invoices, and a rolled-back invoice rolls its number
-- back with it. Call inside the transaction that inserts the row.
--
-- Order and ticket numbers carry no such legal requirement, so they
-- use ordinary sequences and may contain gaps. That is deliberate:
-- gap-free order numbers would serialise every checkout in the
-- store behind one row lock.
-- ============================================================

create or replace function next_invoice_number(p_fy text default current_fy())
returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare n int;
begin
  insert into invoice_sequences (fy, last_number)
  values (p_fy, 1)
  on conflict (fy) do update
    set last_number = invoice_sequences.last_number + 1
  returning last_number into n;
  return format('INV/%s/%s', p_fy, lpad(n::text, 5, '0'));
end $$;

create sequence order_number_seq;
create sequence ticket_number_seq;

create or replace function next_order_number()
returns text
language sql
set search_path = public, pg_temp
as $$
  select format('ORD-%s-%s',
                to_char(now(), 'YYYY'),
                lpad(nextval('order_number_seq')::text, 5, '0'))
$$;

create or replace function next_ticket_number()
returns text
language sql
set search_path = public, pg_temp
as $$
  select format('TKT-%s-%s',
                to_char(now(), 'YYYY'),
                lpad(nextval('ticket_number_seq')::text, 5, '0'))
$$;

alter table orders
  alter column order_number set default next_order_number();
alter table support_tickets
  alter column ticket_number set default next_ticket_number();

-- ============================================================
-- 6. Quantity ceilings
--
-- A CHECK constraint cannot see sibling rows, so "you may not ship
-- or return more than was ordered" has to be a trigger. Without
-- these you can ship 10 of a line item you sold 2 of, and refund
-- the difference.
-- ============================================================

create or replace function enforce_shipment_quantity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  ordered  int;
  shipped  int;
begin
  select quantity into ordered
  from order_items where id = new.order_item_id;

  select coalesce(sum(quantity), 0) into shipped
  from shipment_items
  where order_item_id = new.order_item_id
    and shipment_id <> new.shipment_id;

  if shipped + new.quantity > ordered then
    raise exception
      'cannot ship % of order item %: % ordered, % already in other shipments',
      new.quantity, new.order_item_id, ordered, shipped
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger trg_shipment_quantity
  before insert or update on shipment_items
  for each row execute function enforce_shipment_quantity();

create or replace function enforce_return_quantity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  ordered   int;
  returned  int;
begin
  select quantity into ordered
  from order_items where id = new.order_item_id;

  select coalesce(sum(quantity), 0) into returned
  from return_items
  where order_item_id = new.order_item_id
    and return_id <> new.return_id;

  if returned + new.quantity > ordered then
    raise exception
      'cannot return % of order item %: % ordered, % already in other returns',
      new.quantity, new.order_item_id, ordered, returned
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger trg_return_quantity
  before insert or update on return_items
  for each row execute function enforce_return_quantity();

-- ============================================================
-- 7. Discount usage limits
--
-- The UPDATE takes a row lock on the discount, which serialises
-- concurrent redemptions of the same code. discounts_within_max_uses
-- then fails the transaction on overuse. Per-customer limits are
-- counted under that same lock, so they are safe too.
--
-- Previously both limits were advisory: two simultaneous checkouts
-- could each read "0 uses so far" and both redeem a single-use code.
-- ============================================================

create or replace function enforce_discount_limits()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  per_customer_cap  int;
  used_by_customer  int;
begin
  update discounts
  set used_count = used_count + 1
  where id = new.discount_id
  returning max_uses_per_customer into per_customer_cap;

  if not found then
    raise exception 'discount % does not exist', new.discount_id
      using errcode = 'foreign_key_violation';
  end if;

  if per_customer_cap is not null and new.customer_id is not null then
    select count(*) into used_by_customer
    from discount_redemptions
    where discount_id = new.discount_id
      and customer_id = new.customer_id;

    if used_by_customer > per_customer_cap then
      raise exception
        'customer % has already used discount % the maximum % times',
        new.customer_id, new.discount_id, per_customer_cap
        using errcode = 'check_violation';
    end if;
  end if;

  return null;
end $$;

create trigger trg_discount_limits
  after insert on discount_redemptions
  for each row execute function enforce_discount_limits();

-- ============================================================
-- 8. Gift card balance follows its ledger
--
-- Same pattern as inventory: the ledger is the truth, the column is
-- a cache maintained in the same transaction, and CHECK
-- (balance >= 0) is what stops a card being overspent.
-- ============================================================

create or replace function apply_gift_card_transaction()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare new_balance numeric(12,2);
begin
  update gift_cards
  set balance = balance + new.delta
  where id = new.gift_card_id
  returning balance into new_balance;

  if new_balance is distinct from new.balance_after then
    raise exception
      'gift card %: balance_after % disagrees with ledger balance %',
      new.gift_card_id, new.balance_after, new_balance
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

create trigger trg_apply_gift_card_txn
  after insert on gift_card_transactions
  for each row execute function apply_gift_card_transaction();

-- ============================================================
-- 9. Review verification
--
-- reviews.is_verified is generated from order_item_id, so the only
-- remaining question is whether that order item is really the
-- reviewer's and really for this product. Without this a customer
-- can point order_item_id at a stranger's purchase and collect the
-- "verified buyer" badge.
-- ============================================================

create or replace function validate_review_purchase()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare ok boolean;
begin
  if new.order_item_id is null then
    return new;
  end if;

  select exists (
    select 1
    from order_items oi
    join orders o on o.id = oi.order_id
    join product_variants v on v.id = oi.variant_id
    where oi.id = new.order_item_id
      and o.customer_id = new.customer_id
      and v.product_id = new.product_id
  ) into ok;

  if not ok then
    raise exception
      'order item % does not belong to customer % for product %',
      new.order_item_id, new.customer_id, new.product_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger trg_validate_review
  before insert or update on reviews
  for each row execute function validate_review_purchase();

-- ============================================================
-- 10. Append-only guards
--
-- Ledgers and history tables can be added to, never edited -- not
-- even from the Supabase dashboard, because triggers (unlike RLS)
-- apply to every role including the service key.
-- ============================================================

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
create trigger trg_lock_discount_redemptions
  before update or delete on discount_redemptions
  for each row execute function forbid_change();

-- Invoices: deletes always forbidden. The only permitted updates are
-- setting pdf_url after generation and stamping the e-invoice fields
-- when the IRP responds. Mistakes get a credit_note, not an edit.
create or replace function protect_invoice()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  mutable_fields text[] := array['pdf_url', 'irn', 'ack_no', 'ack_date', 'signed_qr'];
begin
  if tg_op = 'DELETE' then
    raise exception 'invoices are permanent legal documents: delete not allowed'
      using errcode = 'restrict_violation';
  end if;

  if (to_jsonb(new) - mutable_fields) is distinct from (to_jsonb(old) - mutable_fields) then
    raise exception
      'invoices are immutable: only pdf_url and the e-invoice fields may be updated (issue a credit_note instead)'
      using errcode = 'restrict_violation';
  end if;

  -- Once the IRP has signed an invoice, that stamp is final too.
  if old.irn is not null and new.irn is distinct from old.irn then
    raise exception 'IRN is assigned by the IRP and cannot be changed'
      using errcode = 'restrict_violation';
  end if;

  return new;
end $$;

create trigger trg_protect_invoices
  before update or delete on invoices
  for each row execute function protect_invoice();

-- ============================================================
-- 11. Audit trail
--
-- Attached to the tables where an unexplained change is expensive.
-- Captures auth.uid() so a staff action stays attributable even
-- though staff write to these tables directly.
-- ============================================================

create or replace function audit_row()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid     uuid;
  rec_txt text;
  rec_id  uuid;
  delta   jsonb;
  j_old   jsonb;
  j_new   jsonb;
begin
  begin
    uid := auth.uid();
  exception when others then
    uid := null;          -- vanilla Postgres, or a job running without a JWT
  end;

  if tg_op = 'DELETE' then
    j_old   := to_jsonb(old);
    rec_txt := j_old ->> 'id';
    delta   := jsonb_build_object('old', j_old);
  elsif tg_op = 'INSERT' then
    j_new   := to_jsonb(new);
    rec_txt := j_new ->> 'id';
    delta   := jsonb_build_object('new', j_new);
  else
    j_old   := to_jsonb(old);
    j_new   := to_jsonb(new);
    rec_txt := j_new ->> 'id';
    -- Only the columns that actually changed, so the log stays
    -- readable and does not balloon with unchanged blobs.
    delta := jsonb_build_object(
      'old', coalesce((select jsonb_object_agg(key, value)
                       from jsonb_each(j_old)
                       where j_new -> key is distinct from value), '{}'::jsonb),
      'new', coalesce((select jsonb_object_agg(key, value)
                       from jsonb_each(j_new)
                       where j_old -> key is distinct from value), '{}'::jsonb)
    );
  end if;

  -- Not every audited table keys on a uuid (store_settings is a
  -- single int-keyed row), so the cast has to be tolerant. The
  -- table_name column identifies the row well enough when it fails.
  begin
    rec_id := rec_txt::uuid;
  exception when others then
    rec_id := null;
  end;

  insert into audit_logs (staff_id, actor_uid, action, table_name, record_id, changes)
  values (
    (select s.id from staff_users s where s.id = uid),
    uid,
    lower(tg_op),
    tg_table_name,
    rec_id,
    delta
  );
  return null;
end $$;

comment on function audit_row() is
  'SECURITY DEFINER so it can write audit_logs even when the acting role '
  'cannot. search_path pins pg_temp LAST so the definer context cannot be '
  'hijacked by a shadowing temp table.';

create trigger trg_audit_variants
  after insert or update or delete on product_variants
  for each row execute function audit_row();
create trigger trg_audit_discounts
  after insert or update or delete on discounts
  for each row execute function audit_row();
create trigger trg_audit_settings
  after update on store_settings
  for each row execute function audit_row();
create trigger trg_audit_staff
  after insert or update or delete on staff_users
  for each row execute function audit_row();
create trigger trg_audit_gift_cards
  after insert or update or delete on gift_cards
  for each row execute function audit_row();
create trigger trg_audit_blocklist
  after insert or update or delete on blocklist
  for each row execute function audit_row();

-- ============================================================
-- 12. DPDP erasure without destroying the commercial record
--
-- India's DPDP Act gives people an erasure right; GST requires you
-- to keep invoices and order records for years. Deleting the
-- customer row satisfies neither -- it cascades away addresses,
-- reviews and consent, and would have taken the credit ledger with
-- it. Scrub the PII, keep the row and its history.
-- ============================================================

create or replace function anonymize_customer(p_customer_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update customers
  set email         = format('deleted+%s@invalid', id),
      phone         = null,
      full_name     = 'Deleted customer',
      anonymized_at = now()
  where id = p_customer_id
    and anonymized_at is null;

  delete from addresses where customer_id = p_customer_id;
  delete from communication_preferences where customer_id = p_customer_id;
  delete from wishlist_items where customer_id = p_customer_id;
  delete from stock_alerts where customer_id = p_customer_id;

  -- Orders keep a contact snapshot for GST purposes, but the name
  -- and address blobs are personal data, so they go.
  update orders
  set email            = format('deleted+%s@invalid', p_customer_id),
      phone            = null,
      shipping_address = '{"redacted": true}'::jsonb,
      billing_address  = null
  where customer_id = p_customer_id;

  update reviews
  set title = null, body = null
  where customer_id = p_customer_id;
end $$;

revoke execute on function anonymize_customer(uuid) from public;

comment on function anonymize_customer(uuid) is
  'DPDP erasure. Scrubs PII while retaining orders, invoices and the credit '
  'ledger. Call this BEFORE deleting the auth.users row -- customers.id has '
  'ON DELETE RESTRICT precisely so an unscrubbed delete fails loudly.';

commit;
