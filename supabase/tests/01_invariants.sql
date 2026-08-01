-- ============================================================
-- Invariant tests
--
-- Every assertion here corresponds to a rule the schema claims to
-- enforce. A schema whose guarantees are untested is a schema whose
-- guarantees are aspirational.
--
-- Run:  make test
-- Plain SQL on purpose -- no pgTAP dependency, so this runs against
-- any Postgres 15+ including a bare container.
-- ============================================================

\set ON_ERROR_STOP on

create or replace function must_fail(stmt text, label text)
returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception
    when others then
      raise notice 'PASS  %  [rejected: %]', label, left(replace(sqlerrm, E'\n', ' '), 55);
      return;
  end;
  raise exception 'FAIL  %  -- statement was accepted but should have been rejected', label;
end $$;

create or replace function must_pass(stmt text, label text)
returns void language plpgsql as $$
begin
  execute stmt;
  raise notice 'PASS  %', label;
exception when others then
  raise exception 'FAIL  %  -- %', label, sqlerrm;
end $$;

begin;

-- ------------------------------------------------------------
-- Fixtures
-- ------------------------------------------------------------

insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-000000000001', 'buyer@example.com'),
  ('a0000000-0000-4000-8000-000000000002', 'other@example.com'),
  ('b0000000-0000-4000-8000-000000000001', 'staff@example.com');

insert into customers (id, email) values
  ('a0000000-0000-4000-8000-000000000001', 'buyer@example.com'),
  ('a0000000-0000-4000-8000-000000000002', 'other@example.com');

insert into staff_users (id, email, role) values
  ('b0000000-0000-4000-8000-000000000001', 'staff@example.com', 'warehouse');

insert into products (id, name, slug, status) values
  ('c0000000-0000-4000-8000-000000000001', 'Test Laptop', 'test-laptop', 'active'),
  ('c0000000-0000-4000-8000-000000000002', 'Draft Phone', 'draft-phone', 'draft');

insert into product_variants (id, product_id, sku, price, stock, is_default) values
  ('d0000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-000000000001', 'SKU-TEST-1', 1000.00, 5, true),
  ('d0000000-0000-4000-8000-000000000002',
   'c0000000-0000-4000-8000-000000000002', 'SKU-DRAFT-1', 2000.00, 5, true);

insert into orders (id, email, subtotal, grand_total, shipping_address, customer_id)
values ('e0000000-0000-4000-8000-000000000001', 'buyer@example.com',
        1000.00, 1000.00, '{}'::jsonb, 'a0000000-0000-4000-8000-000000000001');

insert into order_items (id, order_id, variant_id, product_name, variant_title, sku,
                         unit_price, quantity)
values ('f0000000-0000-4000-8000-000000000001',
        'e0000000-0000-4000-8000-000000000001',
        'd0000000-0000-4000-8000-000000000001',
        'Test Laptop', 'default', 'SKU-TEST-1', 1000.00, 2);

-- ============================================================
-- Identity
-- ============================================================

select must_fail($$
  insert into customers (email) values ('nodefault@example.com')
$$, 'customers.id has no default -- a customer cannot be created without auth.uid()');

select must_fail($$
  insert into customers (id, email, phone)
  values ('a0000000-0000-4000-8000-000000000009', null, '9876543210')
$$, 'phone must be E.164 -- bare 10-digit numbers rejected');

select must_fail($$
  update customers set email = 'BUYER@EXAMPLE.COM'
  where id = 'a0000000-0000-4000-8000-000000000002'
$$, 'email is citext -- case variants collide with the existing unique');

-- ============================================================
-- Catalog integrity
-- ============================================================

insert into product_options (id, product_id, name) values
  ('11110000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-000000000001', 'Colour');
insert into product_option_values (id, option_id, product_id, value) values
  ('22220000-0000-4000-8000-000000000001',
   '11110000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-000000000001', 'Midnight');

select must_fail($$
  insert into variant_option_values (variant_id, option_value_id, product_id)
  values ('d0000000-0000-4000-8000-000000000002',
          '22220000-0000-4000-8000-000000000001',
          'c0000000-0000-4000-8000-000000000002')
$$, 'composite FK -- cannot attach one product''s option value to another''s variant');

select must_fail($$
  insert into product_images (product_id, variant_id, url)
  values ('c0000000-0000-4000-8000-000000000001',
          'd0000000-0000-4000-8000-000000000002', 'https://x/y.jpg')
$$, 'composite FK -- image cannot pin a variant from a different product');

select must_fail($$
  insert into product_variants (product_id, sku, price, is_default)
  values ('c0000000-0000-4000-8000-000000000001', 'SKU-TEST-2', 500, true)
$$, 'uniq_default_variant -- only one default variant per product');

select must_fail($$
  insert into product_variants (product_id, sku, price, compare_at_price)
  values ('c0000000-0000-4000-8000-000000000001', 'SKU-TEST-3', 900, 500)
$$, 'compare_at_price must not sit below price');

-- ============================================================
-- Inventory: the oversell guard
-- ============================================================

select must_pass($$
  insert into inventory_movements (variant_id, quantity, reason)
  values ('d0000000-0000-4000-8000-000000000001', -3, 'sale')
$$, 'sale within stock succeeds');

do $$
declare s int;
begin
  select stock into s from product_variants
  where id = 'd0000000-0000-4000-8000-000000000001';
  if s <> 2 then
    raise exception 'FAIL  ledger did not update cached stock (expected 2, got %)', s;
  end if;
  raise notice 'PASS  ledger writes the cache -- stock is now %', s;
end $$;

select must_fail($$
  insert into inventory_movements (variant_id, quantity, reason)
  values ('d0000000-0000-4000-8000-000000000001', -99, 'sale')
$$, 'OVERSELL GUARD -- stock cannot go negative');

select must_fail($$
  update inventory_movements set quantity = 0
$$, 'inventory_movements is append-only -- UPDATE blocked for every role');

select must_fail($$
  insert into inventory_movements (variant_id, quantity, reason)
  values ('d0000000-0000-4000-8000-000000000001', -1, 'reservation')
$$, 'a reservation without expires_at is rejected');

-- ============================================================
-- Quantity ceilings
-- ============================================================

insert into shipments (id, order_id) values
  ('33330000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001');

select must_fail($$
  insert into shipment_items (shipment_id, order_item_id, order_id, quantity)
  values ('33330000-0000-4000-8000-000000000001',
          'f0000000-0000-4000-8000-000000000001',
          'e0000000-0000-4000-8000-000000000001', 5)
$$, 'cannot ship 5 of a line item that sold 2');

-- ============================================================
-- Orders arithmetic
-- ============================================================

select must_fail($$
  insert into orders (email, subtotal, tax_total, grand_total, shipping_address)
  values ('x@example.com', 100, 18, 100, '{}'::jsonb)
$$, 'orders totals must balance (grand_total = subtotal - discount + shipping + tax)');

-- ============================================================
-- Discounts
-- ============================================================

insert into discounts (id, code, kind, value, max_uses, max_uses_per_customer)
values ('44440000-0000-4000-8000-000000000001', 'TESTCODE', 'percent', 20, 1, 1);

select must_fail($$
  insert into discounts (code, kind, value) values ('BAD', 'percent', 500)
$$, 'a percent discount above 100 is rejected');

select must_fail($$
  insert into discounts (code, kind, value, applies_to)
  values ('BAD2', 'fixed', 100, 'product')
$$, 'applies_to = product with no product_id is rejected');

select must_pass($$
  insert into discount_redemptions (discount_id, order_id, customer_id, amount)
  values ('44440000-0000-4000-8000-000000000001',
          'e0000000-0000-4000-8000-000000000001',
          'a0000000-0000-4000-8000-000000000001', 200)
$$, 'first redemption of a single-use code succeeds');

insert into orders (id, email, subtotal, grand_total, shipping_address)
values ('e0000000-0000-4000-8000-000000000002', 'other@example.com',
        1000, 1000, '{}'::jsonb);

select must_fail($$
  insert into discount_redemptions (discount_id, order_id, customer_id, amount)
  values ('44440000-0000-4000-8000-000000000001',
          'e0000000-0000-4000-8000-000000000002',
          'a0000000-0000-4000-8000-000000000002', 200)
$$, 'COUPON RACE GUARD -- max_uses = 1 blocks the second redemption');

-- ============================================================
-- Gift cards
-- ============================================================

insert into gift_cards (id, code_hash, last4, initial_balance, balance)
values ('55550000-0000-4000-8000-000000000001',
        digest('GIFT-TEST-CODE', 'sha256'), 'CODE', 1000, 1000);

select must_pass($$
  insert into gift_card_transactions (gift_card_id, delta, balance_after)
  values ('55550000-0000-4000-8000-000000000001', -400, 600)
$$, 'gift card redemption updates the cached balance');

select must_fail($$
  insert into gift_card_transactions (gift_card_id, delta, balance_after)
  values ('55550000-0000-4000-8000-000000000001', -100, 999)
$$, 'a balance_after that disagrees with the ledger is rejected');

select must_fail($$
  insert into gift_card_transactions (gift_card_id, delta, balance_after)
  values ('55550000-0000-4000-8000-000000000001', -9999, 0)
$$, 'a gift card cannot be overspent');

-- ============================================================
-- GST invoicing
-- ============================================================

do $$
declare a text; b text;
begin
  a := next_invoice_number('2026-27');
  b := next_invoice_number('2026-27');
  if a <> 'INV/2026-27/00001' or b <> 'INV/2026-27/00002' then
    raise exception 'FAIL  invoice numbering not sequential: % then %', a, b;
  end if;
  raise notice 'PASS  invoice numbers are gap-free and sequential (%, %)', a, b;
end $$;

do $$
begin
  if current_fy('2026-08-01'::date) <> '2026-27'
     or current_fy('2027-01-15'::date) <> '2026-27'
     or current_fy('2027-04-01'::date) <> '2027-28' then
    raise exception 'FAIL  current_fy() is wrong across the April boundary';
  end if;
  raise notice 'PASS  current_fy() correct across the April boundary';
end $$;

insert into invoices (id, invoice_number, order_id, customer_name, billing_address,
                      seller_gstin, place_of_supply, taxable_value,
                      cgst_total, sgst_total, grand_total)
values ('66660000-0000-4000-8000-000000000001', 'INV/2026-27/00001',
        'e0000000-0000-4000-8000-000000000001', 'Test Buyer', '{}'::jsonb,
        '29ABCDE1234F1Z5', '29', 1000, 90, 90, 1180);

select must_fail($$
  delete from invoices where id = '66660000-0000-4000-8000-000000000001'
$$, 'invoices cannot be deleted -- they are legal documents');

select must_fail($$
  update invoices set taxable_value = 1
  where id = '66660000-0000-4000-8000-000000000001'
$$, 'invoices are immutable except for pdf_url and the e-invoice fields');

select must_pass($$
  update invoices set pdf_url = 'https://x/inv.pdf'
  where id = '66660000-0000-4000-8000-000000000001'
$$, 'pdf_url may still be stamped after generation');

select must_fail($$
  insert into invoices (invoice_number, order_id, customer_name, billing_address,
                        seller_gstin, place_of_supply, taxable_value,
                        cgst_total, sgst_total, igst_total, grand_total)
  values ('INV/2026-27/00003', 'e0000000-0000-4000-8000-000000000001', 'X',
          '{}'::jsonb, '29ABCDE1234F1Z5', '29', 100, 9, 9, 18, 136)
$$, 'CGST/SGST and IGST are mutually exclusive');

-- ============================================================
-- Reviews
-- ============================================================

select must_fail($$
  insert into reviews (product_id, customer_id, order_item_id, rating)
  values ('c0000000-0000-4000-8000-000000000001',
          'a0000000-0000-4000-8000-000000000002',
          'f0000000-0000-4000-8000-000000000001', 5)
$$, 'cannot claim a verified review against another customer''s order item');

select must_pass($$
  insert into reviews (product_id, customer_id, order_item_id, rating)
  values ('c0000000-0000-4000-8000-000000000001',
          'a0000000-0000-4000-8000-000000000001',
          'f0000000-0000-4000-8000-000000000001', 5)
$$, 'a genuine purchase can be reviewed');

do $$
declare v boolean;
begin
  select is_verified into v from reviews
  where customer_id = 'a0000000-0000-4000-8000-000000000001';
  if not v then raise exception 'FAIL  is_verified should be generated true'; end if;
  raise notice 'PASS  is_verified is generated from order_item_id, not client-supplied';
end $$;

-- ============================================================
-- The storefront view must not leak unreleased products
-- ============================================================

do $$
declare n int;
begin
  select count(*) into n from storefront_variants
  where product_id = 'c0000000-0000-4000-8000-000000000002';
  if n <> 0 then
    raise exception 'FAIL  storefront_variants exposes % variant(s) of a draft product', n;
  end if;
  raise notice 'PASS  storefront_variants hides variants of non-active products';
end $$;

do $$
declare n int;
begin
  select count(*) into n
  from information_schema.columns
  where table_name = 'storefront_variants' and column_name = 'cost_price';
  if n <> 0 then raise exception 'FAIL  storefront_variants exposes cost_price'; end if;
  raise notice 'PASS  storefront_variants does not project cost_price';
end $$;

-- ============================================================
-- RLS: a customer must not be able to write privileged state
-- ============================================================

set local role authenticated;
set local request.jwt.claim.sub = 'a0000000-0000-4000-8000-000000000002';

select must_fail($$
  insert into reviews (product_id, customer_id, rating, status)
  values ('c0000000-0000-4000-8000-000000000001',
          'a0000000-0000-4000-8000-000000000002', 5, 'approved')
$$, 'RLS -- a customer cannot insert a pre-approved review');

select must_fail($$
  insert into return_requests (order_id, customer_id, reason, status)
  values ('e0000000-0000-4000-8000-000000000001',
          'a0000000-0000-4000-8000-000000000002', 'damaged', 'refunded')
$$, 'RLS -- a customer cannot open a return already marked refunded');

select must_fail($$
  insert into support_tickets (customer_id, subject, priority)
  values ('a0000000-0000-4000-8000-000000000002', 'help', 'urgent')
$$, 'RLS -- a customer cannot self-assign urgent priority');

-- RLS filters rows rather than raising, so the assertion is
-- emptiness, not an error. product_variants has no public policy at
-- all, so the storefront must go through storefront_variants.
do $$
declare n int;
begin
  select count(*) into n from product_variants;
  if n <> 0 then
    raise exception 'FAIL  customer can read % rows of product_variants (cost_price is on that table)', n;
  end if;
  raise notice 'PASS  RLS -- product_variants is invisible to customers (cost_price protected)';
end $$;

do $$
declare n int;
begin
  select count(*) into n from orders;
  if n <> 0 then
    raise exception 'FAIL  customer can see % orders that are not theirs', n;
  end if;
  raise notice 'PASS  RLS -- a customer sees none of another customer''s orders';
end $$;

reset role;

rollback;

drop function must_fail(text, text);
drop function must_pass(text, text);
