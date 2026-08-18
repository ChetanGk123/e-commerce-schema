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

-- Signing up an auth user now creates the customers row and its consent
-- defaults, via the trigger from migration 0011 -- so there is deliberately
-- no explicit `insert into customers` here. The bare phone on the first
-- user is exactly how Supabase stores it; the trigger has to make it E.164.
insert into auth.users (id, email, phone, raw_user_meta_data) values
  ('a0000000-0000-4000-8000-000000000001', 'buyer@example.com',
   '919876543210', '{"full_name":"Priya S"}'::jsonb),
  ('a0000000-0000-4000-8000-000000000002', 'other@example.com', null, null),
  ('b0000000-0000-4000-8000-000000000001', 'staff@example.com', null, null);

insert into staff_users (id, email, role) values
  ('b0000000-0000-4000-8000-000000000001', 'staff@example.com', 'warehouse');

do $$
declare p text; nm text; n int;
begin
  select phone, full_name into p, nm from customers
  where id = 'a0000000-0000-4000-8000-000000000001';

  if p is distinct from '+919876543210' then
    raise exception
      'FAIL  signup trigger did not normalise phone to E.164 (got %)', p;
  end if;
  if nm is distinct from 'Priya S' then
    raise exception 'FAIL  signup trigger did not carry full_name (got %)', nm;
  end if;

  select count(*) into n from customers;
  if n <> 3 then
    raise exception 'FAIL  signup trigger created % customer rows, expected 3', n;
  end if;

  select count(*) into n from communication_preferences;
  if n <> 3 then
    raise exception 'FAIL  consent defaults created for % of 3 signups', n;
  end if;

  raise notice 'PASS  signup trigger creates customer + consent, phone normalised to E.164';
end $$;

insert into products (id, name, slug, status) values
  ('c0000000-0000-4000-8000-000000000001', 'Test Laptop', 'test-laptop', 'active'),
  ('c0000000-0000-4000-8000-000000000002', 'Draft Phone', 'draft-phone', 'draft');

insert into product_variants (id, product_id, sku, price, stock, is_default) values
  ('d0000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-000000000001', 'SKU-TEST-1', 1000.00, 5, true),
  ('d0000000-0000-4000-8000-000000000002',
   'c0000000-0000-4000-8000-000000000002', 'SKU-DRAFT-1', 2000.00, 5, true);

-- Prices that do not divide cleanly, for the discount-apportionment tests.
insert into product_variants (id, product_id, sku, price, stock) values
  ('d0000000-0000-4000-8000-000000000003',
   'c0000000-0000-4000-8000-000000000001', 'SKU-TEST-3', 33.34, 100),
  ('d0000000-0000-4000-8000-000000000004',
   'c0000000-0000-4000-8000-000000000001', 'SKU-TEST-4', 33.33, 100);

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
-- Catalog reads (0013): search and shipping quotes
-- ============================================================

insert into shipping_zones (id, name)
values ('b1000000-0000-4000-8000-000000000001', 'Test Zone');

insert into serviceable_pincodes (pincode, zone_id, cod_allowed)
values ('560001', 'b1000000-0000-4000-8000-000000000001', true);

-- Two bands sharing the 500g edge. rates_no_overlap accepts both
-- because its ranges are half-open; a lookup using BETWEEN would
-- match both and charge whichever the planner returned first.
insert into shipping_rates
  (zone_id, min_weight_grams, max_weight_grams, rate, delivery_days)
values
  ('b1000000-0000-4000-8000-000000000001',   0,  500, 40.00, 3),
  ('b1000000-0000-4000-8000-000000000001', 500, 2000, 80.00, 4);

do $$
declare r record;
begin
  select count(*) as n, min(rate) as rate into r
  from shipping_quote('560001', 500, 0);
  if r.n <> 1 then
    raise exception 'FAIL  shipping_quote matched % bands at the 500g boundary -- must be exactly 1', r.n;
  end if;
  if r.rate <> 80.00 then
    raise exception 'FAIL  shipping_quote took the wrong band at 500g (rate %)', r.rate;
  end if;
  raise notice 'PASS  shipping_quote matches exactly one band on a shared boundary';
end $$;

do $$
declare n int;
begin
  select count(*) into n from shipping_quote('999999', 100, 0);
  if n <> 0 then
    raise exception 'FAIL  shipping_quote quoted an unserviceable pincode';
  end if;
  raise notice 'PASS  shipping_quote answers an unserviceable pincode with no rows';
end $$;

-- 'labtop' vs 'Test Laptop' scores 0.571: below pg_trgm's default word
-- similarity threshold of 0.6, above the 0.35 the function pins. This
-- fails if that set_config is ever dropped.
do $$
declare n int;
begin
  select count(*) into n from search_products('labtop');
  if n < 1 then
    raise exception 'FAIL  search_products did not match "labtop" to "Test Laptop"';
  end if;
  raise notice 'PASS  search_products is typo-tolerant (threshold is pinned, not inherited)';
end $$;

do $$
declare n int;
begin
  select count(*) into n from search_products('%%');
  if n <> 0 then
    raise exception 'FAIL  search_products read "%%" as a wildcard and returned % rows', n;
  end if;
  raise notice 'PASS  search_products escapes LIKE wildcards in the query string';
end $$;

-- ============================================================
-- Checkout (0014)
-- ============================================================

update products set gst_rate = 18.00, hsn_code = '8471'
where id = 'c0000000-0000-4000-8000-000000000001';

update store_settings
set seller_gstin = '29ABCDE1234F1Z5', seller_state_code = '29'
where id = 1;

-- Three lines that do not divide cleanly. 33.34 + 33.33 + 33.33 = 100.00,
-- and a 1.00 discount apportioned by value rounds to 0.34/0.33/0.33 --
-- shares that add to 1.00 only if the last line takes the remainder.
do $$
declare total numeric;
begin
  select sum((e ->> 'taxable_value')::numeric) into total
  from jsonb_array_elements(apportion_taxable(
    '[{"line_total":33.34,"gst_rate":18},
      {"line_total":33.33,"gst_rate":18},
      {"line_total":33.33,"gst_rate":18}]'::jsonb, 100.00, 1.00)) e;

  if total <> 99.00 then
    raise exception
      'FAIL  apportion_taxable shares sum to %, not the 99.00 actually charged', total;
  end if;
  raise notice 'PASS  apportion_taxable -- rounded discount shares add back up exactly';
end $$;

-- Idempotency is the difference between a double-tap and a double order.
do $$
declare
  addr jsonb := '{"name":"G","line1":"1 St","city":"Bengaluru",
                  "state":"Karnataka","postal_code":"560001","country":"IN"}'::jsonb;
  items jsonb := '[{"variant_id":"d0000000-0000-4000-8000-000000000001","quantity":2}]'::jsonb;
  r1 jsonb; r2 jsonb; n int; before_stock int; left_in_stock int;
begin
  -- Relative, not absolute: earlier assertions in this file move stock too.
  select stock into before_stock from product_variants
  where id = 'd0000000-0000-4000-8000-000000000001';

  r1 := checkout('inv-k1', 'hash-1', 'guest@example.com', '+919876543210',
                 items, addr, 'cod');
  r2 := checkout('inv-k1', 'hash-1', 'guest@example.com', '+919876543210',
                 items, addr, 'cod');

  if (r1 ->> 'order_id') is distinct from (r2 ->> 'order_id') then
    raise exception 'FAIL  replaying an idempotency key created a second order';
  end if;

  select count(*) into n from orders where id = (r1 ->> 'order_id')::uuid;
  if n <> 1 then raise exception 'FAIL  checkout produced % orders', n; end if;

  -- The one that actually bites: a replay that moves stock again.
  select stock into left_in_stock from product_variants
  where id = 'd0000000-0000-4000-8000-000000000001';
  if before_stock - left_in_stock <> 2 then
    raise exception 'FAIL  replay moved % units of stock, not the 2 ordered',
      before_stock - left_in_stock;
  end if;

  raise notice 'PASS  checkout -- a replayed key returns the first response and moves stock once';
end $$;

do $$
declare n int;
begin
  select count(*) into n from inventory_movements
  where reason = 'reservation' and expires_at is null;
  if n <> 0 then
    raise exception 'FAIL  % reservation(s) with no expiry -- that stock is stranded', n;
  end if;
  raise notice 'PASS  checkout -- every reservation carries an expiry';
end $$;

select must_fail($$
  select checkout('inv-k2', 'hash-2', 'g@example.com', '+919876543210',
    '[{"variant_id":"d0000000-0000-4000-8000-000000000001","quantity":999}]'::jsonb,
    '{"postal_code":"560001"}'::jsonb, 'cod')
$$, 'checkout -- overselling is refused, and takes the order with it');

select must_fail($$
  select checkout('inv-k3', 'hash-3', 'g@example.com', '+919876543210',
    '[{"variant_id":"d0000000-0000-4000-8000-000000000002","quantity":1}]'::jsonb,
    '{"postal_code":"560001"}'::jsonb, 'cod')
$$, 'checkout -- a draft product cannot be bought');

select must_fail($$
  select checkout('inv-k4', 'hash-4', 'g@example.com', '+919876543210',
    '[{"variant_id":"d0000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb,
    '{"postal_code":"999999"}'::jsonb, 'cod')
$$, 'checkout -- an unserviceable pincode is refused before an order exists');

-- Same key, different body is a client bug. Replaying the first response
-- would hide it and bill for the wrong basket.
select must_fail($$
  select checkout('inv-k1', 'DIFFERENT-HASH', 'guest@example.com', '+919876543210',
    '[{"variant_id":"d0000000-0000-4000-8000-000000000001","quantity":2}]'::jsonb,
    '{"postal_code":"560001"}'::jsonb, 'cod')
$$, 'checkout -- an idempotency key reused with a different body is refused');

-- The reason apportion_taxable is shared rather than written twice: an
-- invoice that does not total what the customer was charged is a filing
-- problem, not a rounding curiosity.
do $$
declare
  addr jsonb := '{"name":"G","line1":"1 St","city":"Bengaluru",
                  "state":"Karnataka","postal_code":"560001","country":"IN"}'::jsonb;
  items jsonb := '[{"variant_id":"d0000000-0000-4000-8000-000000000003","quantity":1},
                   {"variant_id":"d0000000-0000-4000-8000-000000000004","quantity":2}]'::jsonb;
  oid uuid;
  ot numeric; it numeric; cg numeric; sg numeric; ig numeric;
begin
  oid := (checkout('inv-k5', 'hash-5', 'g@example.com', '+919876543210',
                   items, addr, 'cod') ->> 'order_id')::uuid;
  update orders set status = 'paid' where id = oid;

  perform set_config('request.jwt.claim.sub',
                     'b0000000-0000-4000-8000-000000000001', true);
  perform admin_issue_invoice(oid);

  select o.grand_total, i.grand_total, i.cgst_total, i.sgst_total, i.igst_total
    into ot, it, cg, sg, ig
  from orders o join invoices i on i.order_id = o.id where o.id = oid;

  if ot <> it then
    raise exception 'FAIL  intra-state invoice totals % against an order of %', it, ot;
  end if;
  if cg <> sg then
    raise exception 'FAIL  CGST % and SGST % are not equal', cg, sg;
  end if;
  raise notice 'PASS  checkout + invoice -- an intra-state invoice totals exactly what was charged';
end $$;

do $$
declare
  addr jsonb := '{"name":"G","line1":"1 St","city":"Chennai",
                  "state":"Tamil Nadu","postal_code":"560001","country":"IN"}'::jsonb;
  items jsonb := '[{"variant_id":"d0000000-0000-4000-8000-000000000003","quantity":1},
                   {"variant_id":"d0000000-0000-4000-8000-000000000004","quantity":2}]'::jsonb;
  oid uuid; ot numeric; it numeric; ig numeric;
begin
  oid := (checkout('inv-k6', 'hash-6', 'g@example.com', '+919876543210',
                   items, addr, 'cod') ->> 'order_id')::uuid;
  update orders set status = 'paid' where id = oid;

  perform set_config('request.jwt.claim.sub',
                     'b0000000-0000-4000-8000-000000000001', true);
  perform admin_issue_invoice(oid, '33');   -- Tamil Nadu

  select o.grand_total, i.grand_total, i.igst_total into ot, it, ig
  from orders o join invoices i on i.order_id = o.id where o.id = oid;

  -- The same supply, billed inter-state, must come to the same money.
  -- It did not before 0014: IGST rounded at the full rate while CGST and
  -- SGST rounded at half, so the two modes could differ by a paisa.
  if ot <> it then
    raise exception 'FAIL  inter-state invoice totals % against an order of %', it, ot;
  end if;
  if ig = 0 then
    raise exception 'FAIL  an inter-state invoice charged no IGST';
  end if;
  raise notice 'PASS  checkout + invoice -- inter-state bills the same total as intra-state';
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

-- search_products is SECURITY INVOKER precisely so this holds: one
-- function serves the storefront and the admin, and RLS -- not a role
-- flag in the API -- decides which rows come back.
do $$
declare n int;
begin
  select count(*) into n from search_products('phone') where status <> 'active';
  if n <> 0 then
    raise exception 'FAIL  search_products returned % non-active product(s) to a customer', n;
  end if;
  raise notice 'PASS  search_products -- a draft product is invisible to a customer';
end $$;

reset role;

rollback;

drop function must_fail(text, text);
drop function must_pass(text, text);
