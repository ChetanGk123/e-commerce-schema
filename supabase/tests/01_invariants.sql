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
-- Payments and webhooks (0015)
-- ============================================================

-- Restock first, because the assertions above have been buying. Note the
-- shape: a 'purchase' movement, never `update product_variants set stock`.
-- The column is a cache the ledger maintains.
insert into inventory_movements (variant_id, quantity, reason, note)
values ('d0000000-0000-4000-8000-000000000001', 50, 'purchase',
        'restock for the payment assertions');

-- A gateway that delivers twice must change the world once. Everything
-- below is that sentence, taken apart.
do $$
declare
  addr  jsonb := '{"name":"G","line1":"1 St","city":"Bengaluru",
                   "state":"Karnataka","postal_code":"560001","country":"IN"}'::jsonb;
  items jsonb := '[{"variant_id":"d0000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb;
  oid   uuid;
  before_stock int; after_stock int;
  first_call boolean; second_call boolean;
  w record; w2 record;
  n_sale int; n_pay int;
begin
  select stock into before_stock from product_variants
  where id = 'd0000000-0000-4000-8000-000000000001';

  oid := (checkout('pay-k1', 'h', 'g@example.com', '+919876543210',
                   items, addr, 'razorpay') ->> 'order_id')::uuid;
  perform attach_payment_ref(oid, 'razorpay', 'order_RZP_1');

  select * into w from record_webhook('razorpay', 'evt_1', 'payment.captured',
                                      '{}'::jsonb, true);
  if not w.is_new or w.already_processed then
    raise exception 'FAIL  a first delivery reported is_new=% processed=%',
      w.is_new, w.already_processed;
  end if;

  first_call := capture_payment(oid, 'razorpay', 'order_RZP_1');
  perform mark_webhook_processed(w.id);

  -- The redelivery.
  select * into w2 from record_webhook('razorpay', 'evt_1', 'payment.captured',
                                       '{}'::jsonb, true);
  if w2.is_new then
    raise exception 'FAIL  a redelivery was recorded as a new event';
  end if;
  if not w2.already_processed then
    raise exception 'FAIL  a redelivery of a processed event did not say so';
  end if;
  if w2.attempts <> 2 then
    raise exception 'FAIL  attempts is % after two deliveries', w2.attempts;
  end if;

  second_call := capture_payment(oid, 'razorpay', 'order_RZP_1');
  if first_call is not true or second_call is not false then
    raise exception 'FAIL  capture_payment reported first=% second=%',
      first_call, second_call;
  end if;

  select count(*) into n_sale from inventory_movements
  where order_id = oid and reason = 'sale';
  if n_sale <> 1 then
    raise exception 'FAIL  % sale movements for one capture', n_sale;
  end if;

  select count(*) into n_pay from payments where order_id = oid;
  if n_pay <> 1 then
    raise exception 'FAIL  % payment rows for one order', n_pay;
  end if;

  select stock into after_stock from product_variants
  where id = 'd0000000-0000-4000-8000-000000000001';
  if before_stock - after_stock <> 1 then
    raise exception 'FAIL  a doubly-delivered capture moved % units, not 1',
      before_stock - after_stock;
  end if;

  raise notice 'PASS  webhook + capture -- the same delivery twice changes the world once';
end $$;

-- Marking an order paid for the wrong amount cannot be undone without a
-- person, so it is refused rather than reconciled.
do $$
declare
  addr  jsonb := '{"line1":"1 St","city":"B","state":"KA","postal_code":"560001"}'::jsonb;
  items jsonb := '[{"variant_id":"d0000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb;
  oid uuid;
begin
  oid := (checkout('pay-k2', 'h', 'g@example.com', '+919876543210',
                   items, addr, 'razorpay') ->> 'order_id')::uuid;
  begin
    perform capture_payment(oid, 'razorpay', 'order_RZP_2', 1.00);
    raise exception 'FAIL  capture_payment accepted 1.00 against a larger order';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  raise notice 'PASS  capture_payment -- a short capture is refused, not reconciled';
end $$;

-- payment.failed is not terminal at the gateway: a mistyped OTP fires it
-- and the customer retries in the same session. Releasing there would hand
-- their basket away mid-checkout.
do $$
declare
  addr  jsonb := '{"line1":"1 St","city":"B","state":"KA","postal_code":"560001"}'::jsonb;
  items jsonb := '[{"variant_id":"d0000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb;
  oid uuid; st text; holds int;
begin
  oid := (checkout('pay-k3', 'h', 'g@example.com', '+919876543210',
                   items, addr, 'razorpay') ->> 'order_id')::uuid;
  perform fail_payment(oid, 'razorpay', 'order_RZP_3', 'declined');

  select status into st from orders where id = oid;
  if st <> 'pending' then
    raise exception 'FAIL  a failed payment moved the order to %', st;
  end if;

  select count(*) into holds from inventory_movements m
  where m.order_id = oid and m.reason = 'reservation'
    and not exists (select 1 from inventory_movements c where c.reservation_id = m.id);
  if holds <> 1 then
    raise exception 'FAIL  a failed payment released the hold (% left open)', holds;
  end if;
  raise notice 'PASS  fail_payment -- the stock hold survives a retryable failure';
end $$;

-- The quiet one. With no reservation left to consume, a capture that only
-- looked for reservations would mark the order paid and never take the
-- stock, and nobody would find out until someone counted the shelf.
do $$
declare
  addr  jsonb := '{"line1":"1 St","city":"B","state":"KA","postal_code":"560001"}'::jsonb;
  items jsonb := '[{"variant_id":"d0000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb;
  oid uuid; before_stock int; after_stock int;
begin
  oid := (checkout('pay-k4', 'h', 'g@example.com', '+919876543210',
                   items, addr, 'razorpay') ->> 'order_id')::uuid;

  -- Stand in for release_expired_reservations() having swept the hold.
  insert into inventory_movements (variant_id, quantity, reason, order_id, reservation_id)
  select m.variant_id, -m.quantity, 'release', m.order_id, m.id
  from inventory_movements m
  where m.order_id = oid and m.reason = 'reservation';

  select stock into before_stock from product_variants
  where id = 'd0000000-0000-4000-8000-000000000001';

  perform capture_payment(oid, 'razorpay', 'order_RZP_4');

  select stock into after_stock from product_variants
  where id = 'd0000000-0000-4000-8000-000000000001';

  if before_stock - after_stock <> 1 then
    raise exception
      'FAIL  capture after an expired hold moved % units, not 1 -- silent oversell',
      before_stock - after_stock;
  end if;
  raise notice 'PASS  capture_payment -- an expired hold still takes the stock at capture';
end $$;

-- ============================================================
-- Inventory and fulfilment (0016)
-- ============================================================

-- Whoever is running this is staff, for the guarded functions below.
set local request.jwt.claim.sub = 'b0000000-0000-4000-8000-000000000001';

-- The allow-list is the whole point of record_stock_movement. A 'release'
-- row consumes a stock hold, so an admin endpoint able to write one is a
-- way to invent stock out of nothing.
do $$
declare bad text;
begin
  foreach bad in array array['sale', 'reservation', 'release'] loop
    begin
      perform record_stock_movement('d0000000-0000-4000-8000-000000000001',
                                    1, bad, 'should not be allowed');
      raise exception 'FAIL  record_stock_movement accepted reason %', bad;
    exception when others then
      if sqlerrm like 'FAIL%' then raise; end if;
    end;
  end loop;
  raise notice 'PASS  record_stock_movement -- sale, reservation and release are not receivable by hand';
end $$;

select must_fail($$
  select record_stock_movement('d0000000-0000-4000-8000-000000000001',
                               5, 'purchase', '   ')
$$, 'record_stock_movement -- a manual movement without a note is refused');

select must_fail($$
  select record_stock_movement('d0000000-0000-4000-8000-000000000001',
                               5, 'damage', 'wrong sign')
$$, 'record_stock_movement -- writing off stock with a positive quantity is refused');

-- created_by is taken from auth.uid(), never from a parameter: there is
-- no parameter. An adjustment nobody is attached to is one nobody has to
-- explain.
do $$
declare mid uuid; who uuid; before_stock int; after_stock int;
begin
  select stock into before_stock from product_variants
  where id = 'd0000000-0000-4000-8000-000000000001';

  mid := record_stock_movement('d0000000-0000-4000-8000-000000000001',
                               7, 'purchase', 'received 7 from supplier');

  select created_by into who from inventory_movements where id = mid;
  if who is distinct from 'b0000000-0000-4000-8000-000000000001'::uuid then
    raise exception 'FAIL  movement attributed to % rather than the caller', who;
  end if;

  select stock into after_stock from product_variants
  where id = 'd0000000-0000-4000-8000-000000000001';
  if after_stock - before_stock <> 7 then
    raise exception 'FAIL  the ledger moved 7 units but the cache moved %',
      after_stock - before_stock;
  end if;

  raise notice 'PASS  record_stock_movement -- attributed to the caller, and the cache follows the ledger';
end $$;

-- An adjustment that would take a variant negative is refused by the same
-- CHECK that stops overselling.
select must_fail($$
  select record_stock_movement('d0000000-0000-4000-8000-000000000001',
                               -999999, 'adjustment', 'stock count')
$$, 'record_stock_movement -- an adjustment cannot take stock below zero');

-- The monitor has to notice a stranded hold, or it is decoration.
do $$
declare
  addr  jsonb := '{"line1":"1 St","city":"B","state":"KA","postal_code":"560001"}'::jsonb;
  items jsonb := '[{"variant_id":"d0000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb;
  h jsonb; released int;
begin
  perform checkout('inv-h1', 'h', 'g@example.com', '+919876543210',
                   items, addr, 'razorpay', null, null, -1);   -- already expired

  h := inventory_health();
  if (h ->> 'stranded_reservations')::int < 1 then
    raise exception 'FAIL  inventory_health saw no stranded hold when one exists';
  end if;

  released := release_expired_reservations();
  if released < 1 then
    raise exception 'FAIL  the sweeper released % expired holds', released;
  end if;

  h := inventory_health();
  if (h ->> 'stranded_reservations')::int <> 0 then
    raise exception 'FAIL  a hold is still stranded after the sweeper ran: %',
      h ->> 'stranded_reservations';
  end if;
  if h ->> 'last_auto_release' is null then
    raise exception 'FAIL  the sweeper ran but inventory_health reports no last release';
  end if;

  raise notice 'PASS  inventory_health -- a stranded hold is seen, swept, and seen to be gone';
end $$;

-- pg_cron is not installed in the throwaway container, and that must be a
-- finding rather than an exception -- it is exactly the state the live
-- database was in.
do $$
declare h jsonb;
begin
  h := inventory_health();
  if h ->> 'sweeper_installed' is distinct from 'true' then
    raise exception 'FAIL  release_expired_reservations() is not installed by the migrations';
  end if;
  if (h -> 'sweeper_scheduled') is null then
    raise exception 'FAIL  inventory_health did not report on scheduling at all';
  end if;
  raise notice 'PASS  inventory_health -- reports a missing pg_cron rather than failing on it';
end $$;

reset request.jwt.claim.sub;

-- ============================================================
-- Returns, refunds and the wallet (0017)
-- ============================================================

set local request.jwt.claim.sub = 'b0000000-0000-4000-8000-000000000001';

-- The code exists in plaintext for exactly one response and is never
-- stored. A leaked backup of gift_cards must not be a wallet.
do $$
declare g jsonb; code text; n int;
begin
  g    := admin_issue_gift_card(1000.00, 'friend@example.com');
  code := g ->> 'code';

  if code is null or length(code) <> 16 then
    raise exception 'FAIL  admin_issue_gift_card returned code %', coalesce(code, '(null)');
  end if;

  select count(*) into n from gift_cards where code_hash = digest(code, 'sha256');
  if n <> 1 then
    raise exception 'FAIL  the issued card is not findable by its hash';
  end if;

  -- Nothing anywhere in the row should hold the code itself.
  select count(*) into n from gift_cards gc
  where gc.code_hash = digest(code, 'sha256')
    and to_jsonb(gc)::text like '%' || code || '%';
  if n <> 0 then
    raise exception 'FAIL  the gift card row stores the plaintext code';
  end if;

  raise notice 'PASS  admin_issue_gift_card -- the code is returned once and stored only as a hash';
end $$;

-- Overspending is refused by CHECK (balance >= 0), not by the API
-- remembering to look.
do $$
declare g jsonb; gid uuid;
begin
  g   := admin_issue_gift_card(500.00);
  gid := (g ->> 'gift_card_id')::uuid;
  begin
    insert into gift_card_transactions (gift_card_id, delta, balance_after)
    values (gid, -600.00, -100.00);
    raise exception 'FAIL  a gift card was overspent';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  raise notice 'PASS  gift cards -- spending more than the balance is refused';
end $$;

-- Redeeming converts the whole balance to store credit, once.
do $$
declare g jsonb; code text; r jsonb; bal numeric;
begin
  g    := admin_issue_gift_card(1500.00);
  code := g ->> 'code';

  perform set_config('request.jwt.claim.sub',
                     'a0000000-0000-4000-8000-000000000001', true);
  r := redeem_gift_card(code);

  if (r ->> 'redeemed')::numeric <> 1500.00 then
    raise exception 'FAIL  redeemed % of a 1500 card', r ->> 'redeemed';
  end if;

  select balance into bal from customer_credit_balances
  where customer_id = 'a0000000-0000-4000-8000-000000000001';
  if bal < 1500.00 then
    raise exception 'FAIL  credit balance is % after redeeming 1500', bal;
  end if;

  begin
    perform redeem_gift_card(code);
    raise exception 'FAIL  the same gift card was redeemed twice';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;

  perform set_config('request.jwt.claim.sub',
                     'b0000000-0000-4000-8000-000000000001', true);
  raise notice 'PASS  redeem_gift_card -- whole balance to credit, and only once';
end $$;

-- Money going back out, with the order status rule that matters:
-- 'refunded' tells the warehouse to stop shipping, so a PARTIAL refund
-- must not set it.
do $$
declare
  addr  jsonb := '{"line1":"1 St","city":"B","state":"KA","postal_code":"560001"}'::jsonb;
  items jsonb := '[{"variant_id":"d0000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb;
  oid uuid; total numeric; j jsonb; st text;
begin
  perform set_config('request.jwt.claim.sub',
                     'a0000000-0000-4000-8000-000000000001', true);
  oid := (checkout('rf-k1', 'h', 'buyer@example.com', '+919876543210',
                   items, addr, 'razorpay') ->> 'order_id')::uuid;
  perform set_config('request.jwt.claim.sub',
                     'b0000000-0000-4000-8000-000000000001', true);
  perform capture_payment(oid, 'razorpay', 'order_RF1', null, 'pay_RF1');

  select grand_total into total from orders where id = oid;

  j := admin_refund(oid, round(total / 2, 2), null, 'half back');
  perform settle_refund((j ->> 'refund_id')::uuid, 'processed', 'rfnd_half');

  select status into st from orders where id = oid;
  if st = 'refunded' then
    raise exception 'FAIL  a partial refund marked the whole order refunded';
  end if;

  begin
    perform admin_refund(oid, total, null, 'too much');
    raise exception 'FAIL  refunded more than was captured';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;

  j := admin_refund(oid, total - round(total / 2, 2), null, 'the rest');
  perform settle_refund((j ->> 'refund_id')::uuid, 'processed', 'rfnd_rest');

  select status into st from orders where id = oid;
  if st <> 'refunded' then
    raise exception 'FAIL  a fully refunded order is still %', st;
  end if;

  raise notice 'PASS  admin_refund -- partial leaves the order alone, full settles it, over-refund is refused';
end $$;

-- A redelivered settlement must not double-count.
do $$
declare
  addr  jsonb := '{"line1":"1 St","city":"B","state":"KA","postal_code":"560001"}'::jsonb;
  items jsonb := '[{"variant_id":"d0000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb;
  oid uuid; j jsonb; n int;
begin
  perform set_config('request.jwt.claim.sub',
                     'a0000000-0000-4000-8000-000000000001', true);
  oid := (checkout('rf-k2', 'h', 'buyer@example.com', '+919876543210',
                   items, addr, 'razorpay') ->> 'order_id')::uuid;
  perform set_config('request.jwt.claim.sub',
                     'b0000000-0000-4000-8000-000000000001', true);
  perform capture_payment(oid, 'razorpay', 'order_RF2', null, 'pay_RF2');

  j := admin_refund(oid, 10.00, null, 'small');
  perform settle_refund((j ->> 'refund_id')::uuid, 'processed', 'rfnd_dupe');
  perform settle_refund((j ->> 'refund_id')::uuid, 'failed', 'rfnd_dupe');

  select count(*) into n from refunds
  where order_id = oid and status = 'processed';
  if n <> 1 then
    raise exception 'FAIL  a re-settled refund produced % processed rows', n;
  end if;
  raise notice 'PASS  settle_refund -- settling twice does not unsettle or duplicate';
end $$;

-- Store credit: the reasons that must be earned cannot be granted, and
-- the balance cannot be driven negative.
select must_fail($$
  select admin_grant_credit('a0000000-0000-4000-8000-000000000001',
                            500, 'return_credit', 'invented')
$$, 'admin_grant_credit -- return_credit cannot be granted by hand');

select must_fail($$
  select admin_grant_credit('a0000000-0000-4000-8000-000000000001',
                            -99999999, 'adjustment', 'clawback')
$$, 'admin_grant_credit -- the balance cannot go below zero');

select must_fail($$
  select admin_grant_credit('a0000000-0000-4000-8000-000000000001',
                            100, 'goodwill', '  ')
$$, 'admin_grant_credit -- an entry without a note is refused');

reset request.jwt.claim.sub;

-- ============================================================
-- Invoicing: credit notes and the e-invoice stamp (0018)
-- ============================================================

set local request.jwt.claim.sub = 'b0000000-0000-4000-8000-000000000001';

-- A credit note reverses exactly what was charged, pro rata. Crediting
-- at list price would refund tax on money the customer never paid,
-- because the invoice line already carries its share of the discount.
do $$
declare
  addr  jsonb := '{"name":"B","line1":"1 St","city":"B","state":"KA","postal_code":"560001"}'::jsonb;
  items jsonb := '[{"variant_id":"d0000000-0000-4000-8000-000000000001","quantity":2}]'::jsonb;
  oid uuid; inv uuid; note uuid; line uuid;
  parent invoices%rowtype; cn invoices%rowtype;
begin
  perform set_config('request.jwt.claim.sub',
                     'a0000000-0000-4000-8000-000000000001', true);
  oid := (checkout('cn-k1', 'h', 'buyer@example.com', '+919876543210',
                   items, addr, 'razorpay') ->> 'order_id')::uuid;
  perform set_config('request.jwt.claim.sub',
                     'b0000000-0000-4000-8000-000000000001', true);
  perform capture_payment(oid, 'razorpay', 'order_CN1', null, 'pay_CN1');

  inv := admin_issue_invoice(oid);
  select * into parent from invoices where id = inv;

  select id into line from invoice_lines
  where invoice_id = inv and description not like 'Shipping%' limit 1;

  note := admin_issue_credit_note(
            inv, jsonb_build_array(jsonb_build_object(
                   'invoice_line_id', line, 'quantity', 1)),
            'one unit came back');
  select * into cn from invoices where id = note;

  if cn.kind <> 'credit_note' then
    raise exception 'FAIL  a credit note was issued as %', cn.kind;
  end if;
  if cn.parent_invoice_id is distinct from inv then
    raise exception 'FAIL  the credit note does not point at its parent';
  end if;
  if cn.grand_total >= parent.grand_total then
    raise exception 'FAIL  crediting one of two units came to % against %',
      cn.grand_total, parent.grand_total;
  end if;
  if cn.cgst_total <> cn.sgst_total then
    raise exception 'FAIL  credit note CGST % and SGST % differ',
      cn.cgst_total, cn.sgst_total;
  end if;
  if cn.grand_total <> cn.taxable_value + cn.cgst_total + cn.sgst_total + cn.igst_total then
    raise exception 'FAIL  the credit note does not add up';
  end if;

  -- Crediting the remaining unit plus one more must not be possible:
  -- crediting past the invoice files input credit the buyer is not owed.
  begin
    perform admin_issue_credit_note(
      inv, jsonb_build_array(jsonb_build_object(
             'invoice_line_id', line, 'quantity', 2)),
      'too much');
    raise exception 'FAIL  credited more than the invoice';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;

  raise notice 'PASS  admin_issue_credit_note -- reverses pro rata, points at its parent, cannot exceed it';
end $$;

-- The stamp is the IRP's, not ours, and rewriting a signed QR is the
-- exact tampering the signature exists to make detectable.
do $$
declare
  addr  jsonb := '{"name":"B","line1":"1 St","city":"B","state":"KA","postal_code":"560001"}'::jsonb;
  items jsonb := '[{"variant_id":"d0000000-0000-4000-8000-000000000001","quantity":1}]'::jsonb;
  oid uuid; inv uuid;
begin
  perform set_config('request.jwt.claim.sub',
                     'a0000000-0000-4000-8000-000000000001', true);
  oid := (checkout('cn-k2', 'h', 'buyer@example.com', '+919876543210',
                   items, addr, 'razorpay') ->> 'order_id')::uuid;
  perform set_config('request.jwt.claim.sub',
                     'b0000000-0000-4000-8000-000000000001', true);
  perform capture_payment(oid, 'razorpay', 'order_CN2', null, 'pay_CN2');
  inv := admin_issue_invoice(oid);

  begin
    perform admin_stamp_einvoice(inv, 'too-short', 'ACK', now(), 'QR');
    raise exception 'FAIL  a truncated IRN was accepted, permanently';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;

  perform admin_stamp_einvoice(inv, repeat('a', 64), 'ACK-1', now(), 'QR-1');

  begin
    perform admin_stamp_einvoice(inv, repeat('b', 64), 'ACK-2', now(), 'QR-2');
    raise exception 'FAIL  an invoice was stamped twice';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;

  begin
    update invoices set signed_qr = 'TAMPERED' where id = inv;
    raise exception 'FAIL  the signed QR was rewritten after stamping';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;

  begin
    update invoices set ack_no = 'REWRITTEN' where id = inv;
    raise exception 'FAIL  the acknowledgement number was rewritten after stamping';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;

  -- pdf_url stays mutable: regenerating a PDF from unchanged data is
  -- housekeeping, not an amendment.
  update invoices set pdf_url = 'https://cdn.example.com/inv.pdf' where id = inv;

  raise notice 'PASS  the e-invoice stamp is writable once and final after, while pdf_url stays open';
end $$;

-- The number comes back with a rollback. That is what gap-free means:
-- not that numbers are unique, but that a failed issue does not burn one.
do $$
declare before_n int; after_n int;
begin
  select last_number into before_n from invoice_sequences where fy = current_fy();
  begin
    perform next_invoice_number();
    raise exception 'rollback me';
  exception when others then
    null;
  end;
  select last_number into after_n from invoice_sequences where fy = current_fy();

  if after_n is distinct from before_n then
    raise exception 'FAIL  a rolled-back issue burned a number: % -> %',
      before_n, after_n;
  end if;
  raise notice 'PASS  invoice numbering -- a rolled-back issue gives the number back';
end $$;

select must_fail($$
  update invoices set grand_total = 1.00
  where id = (select id from invoices where kind = 'tax_invoice' limit 1)
$$, 'an issued invoice cannot be edited');

select must_fail($$
  delete from invoices
  where id = (select id from invoices where kind = 'tax_invoice' limit 1)
$$, 'an issued invoice cannot be removed');

reset request.jwt.claim.sub;

-- ============================================================
-- Customers, support and engagement (0019)
-- ============================================================

-- The one that was live: anonymize_customer() is SECURITY DEFINER and
-- was granted to `authenticated` with no check inside it, so any
-- signed-in shopper could erase any other customer.
do $$
declare scrubbed timestamptz;
begin
  perform set_config('request.jwt.claim.sub',
                     'a0000000-0000-4000-8000-000000000001', true);
  begin
    perform anonymize_customer('a0000000-0000-4000-8000-000000000002');
    raise exception 'FAIL  a customer erased a DIFFERENT customer';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;

  select anonymized_at into scrubbed from customers
  where id = 'a0000000-0000-4000-8000-000000000002';
  if scrubbed is not null then
    raise exception 'FAIL  the refusal still scrubbed the target';
  end if;

  raise notice 'PASS  anonymize_customer -- one customer cannot erase another';
end $$;

-- DPDP gives people an erasure right over their own data, so
-- self-service has to survive the fix.
do $$
declare nm text;
begin
  perform set_config('request.jwt.claim.sub',
                     'a0000000-0000-4000-8000-000000000002', true);
  perform anonymize_customer('a0000000-0000-4000-8000-000000000002');

  select full_name into nm from customers
  where id = 'a0000000-0000-4000-8000-000000000002';
  if nm <> 'Deleted customer' then
    raise exception 'FAIL  self-erasure left the name as %', nm;
  end if;
  raise notice 'PASS  anonymize_customer -- a customer may still erase themselves';
end $$;

-- Staff, but not just any staff: the fixture is a warehouse account.
do $$
begin
  perform set_config('request.jwt.claim.sub',
                     'b0000000-0000-4000-8000-000000000001', true);
  if staff_has_role('owner', 'admin') then
    raise exception 'FAIL  a warehouse account reports as owner/admin';
  end if;
  begin
    perform anonymize_customer('a0000000-0000-4000-8000-000000000001');
    raise exception 'FAIL  a warehouse account erased a customer';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  raise notice 'PASS  anonymize_customer -- erasing someone else needs owner or admin';
end $$;

-- Support: the two halves of B10's validation bullet.
do $$
declare tid uuid; seen int; pri text;
begin
  perform set_config('request.jwt.claim.sub',
                     'a0000000-0000-4000-8000-000000000001', true);
  tid := open_ticket('Parcel never arrived', 'It has been eight days now.', 'shipping');

  select priority into pri from support_tickets where id = tid;
  if pri <> 'normal' then
    raise exception 'FAIL  a customer opened a ticket at priority %', pri;
  end if;

  -- A staff-only note on the ticket.
  perform set_config('request.jwt.claim.sub',
                     'b0000000-0000-4000-8000-000000000001', true);
  perform admin_reply_ticket(tid, 'Courier lost it. Insurance claim pending.', true);

  -- Back to the customer, under RLS.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
                     'a0000000-0000-4000-8000-000000000001', true);

  select count(*) into seen from ticket_messages where ticket_id = tid;
  if seen <> 1 then
    raise exception 'FAIL  a customer sees % ticket messages; the internal note is one of them', seen;
  end if;

  select count(*) into seen from ticket_messages
  where ticket_id = tid and body like '%Insurance%';
  if seen <> 0 then
    raise exception 'FAIL  the internal note is readable by the customer';
  end if;

  reset role;
  raise notice 'PASS  support -- a customer cannot read an internal note or open at a priority they chose';
end $$;

-- A customer-authored internal note is a contradiction, and the policy
-- says so rather than the API remembering to.
do $$
declare tid uuid;
begin
  perform set_config('request.jwt.claim.sub',
                     'a0000000-0000-4000-8000-000000000001', true);
  select id into tid from support_tickets
  where customer_id = 'a0000000-0000-4000-8000-000000000001' limit 1;

  set local role authenticated;
  begin
    insert into ticket_messages (ticket_id, sender_type, sender_id, body, is_internal)
    values (tid, 'staff', 'a0000000-0000-4000-8000-000000000001', 'I am staff now', true);
    reset role;
    raise exception 'FAIL  a customer wrote an internal note as staff';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  raise notice 'PASS  support -- a customer cannot post as staff, internal or not';
end $$;

-- reviews.is_verified is generated from order_item_id. It is a trust
-- badge shown to shoppers, so it must not be something anyone can send.
do $$
declare n int;
begin
  select count(*) into n
  from information_schema.columns
  where table_name = 'reviews' and column_name = 'is_verified'
    and is_generated = 'ALWAYS';
  if n <> 1 then
    raise exception 'FAIL  reviews.is_verified is not a generated column';
  end if;

  begin
    insert into reviews (product_id, customer_id, rating, is_verified)
    values ('c0000000-0000-4000-8000-000000000001',
            'a0000000-0000-4000-8000-000000000001', 5, true);
    raise exception 'FAIL  is_verified was accepted from the client';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  raise notice 'PASS  reviews -- is_verified is generated, not claimed';
end $$;

reset request.jwt.claim.sub;

-- ============================================================
-- The outbox drain (0020)
-- ============================================================

-- checkout() already queued confirmations above. Everything here is
-- about what happens to them next.

-- A claim moves rows out of reach of a second drainer. Without that,
-- two API instances send the same order confirmation twice.
do $$
declare first_batch int; second_batch int; queued_before int;
begin
  select count(*) into queued_before from message_log where status = 'queued';
  if queued_before < 2 then
    raise exception 'FAIL  no queued messages to drain -- checkout did not fill the outbox';
  end if;

  select count(*) into first_batch from claim_outbox(1);
  if first_batch <> 1 then
    raise exception 'FAIL  claim_outbox(1) claimed % rows', first_batch;
  end if;

  -- The claimed row is now 'sending', so a second claim cannot see it.
  select count(*) into second_batch
  from message_log where status = 'sending';
  if second_batch <> 1 then
    raise exception 'FAIL  % rows are in sending after claiming one', second_batch;
  end if;

  raise notice 'PASS  claim_outbox -- a claimed message is out of reach of the next drainer';
end $$;

-- A provider having a bad minute is not a message that cannot be
-- delivered, so a failure goes back to the queue -- until it has been
-- tried enough times to say otherwise.
do $$
declare mid uuid; st text; i int;
begin
  select id into mid from message_log where status = 'sending' limit 1;

  st := settle_message(mid, false, null, null, 'resend 503');
  if st <> 'queued' then
    raise exception 'FAIL  a single failure marked the message %', st;
  end if;

  -- Five more claim/fail rounds crosses the give-up line.
  for i in 1..5 loop
    perform claim_outbox(200);
    st := settle_message(mid, false, null, null, 'resend 503');
  end loop;

  if st <> 'failed' then
    raise exception 'FAIL  a message retried past the limit is still %', st;
  end if;
  raise notice 'PASS  settle_message -- failures requeue, and stop requeuing once they are hopeless';
end $$;

-- The success path, which the live test could not reach without real
-- provider credentials.
do $$
declare mid uuid; st text; when_sent timestamptz;
begin
  perform claim_outbox(200);
  select id into mid from message_log where status = 'sending' limit 1;

  st := settle_message(mid, true, 'resend', 'msg_abc123');
  if st <> 'sent' then
    raise exception 'FAIL  a successful send landed on %', st;
  end if;

  select sent_at into when_sent from message_log where id = mid;
  if when_sent is null then
    raise exception 'FAIL  a sent message has no sent_at';
  end if;
  raise notice 'PASS  settle_message -- a delivered message is stamped sent, with the provider reference';
end $$;

-- A row left in 'sending' by a drainer that died is invisible to the
-- claim query forever. This is the only thing that gets it back.
do $$
declare stuck int; rescued int;
begin
  perform claim_outbox(200);
  select count(*) into stuck from message_log where status = 'sending';

  -- Nothing is old enough yet, so a sane interval rescues nothing.
  rescued := requeue_stalled_messages('10 minutes');
  if rescued <> 0 then
    raise exception 'FAIL  requeue took % messages that were still in flight', rescued;
  end if;

  -- Now pretend the drainer has been gone a while. now() is
  -- transaction-stable, so inside one transaction "a while ago" has to
  -- be expressed as a negative interval.
  rescued := requeue_stalled_messages('-1 second');
  if rescued <> stuck then
    raise exception 'FAIL  % of % stalled messages were rescued', rescued, stuck;
  end if;
  raise notice 'PASS  requeue_stalled_messages -- rescues a dead drainer''s rows, and only those';
end $$;

-- The queue is a place messages wait, not a place they vanish from.
do $$
declare n int;
begin
  select count(*) into n from message_log where status = 'sending';
  if n <> 0 then
    raise exception 'FAIL  % messages ended stranded in sending', n;
  end if;
  raise notice 'PASS  outbox -- nothing is left stranded after a full drain cycle';
end $$;

-- ============================================================
-- Message templates (0021)
--
-- Customer-facing copy is staff-editable, which makes it the one place
-- an ordinary admin action can reach every inbox the store writes to.
-- The subject is a single header line, and the database is what says so
-- -- not the API, and not whichever mail adapter happens to be selected.
-- ============================================================

select must_fail($$
  insert into message_templates (key, subject, body)
  values ('password_reset', E'Reset\nBcc: attacker@evil.com', 'code {{code}}')
$$, 'template subject is one line -- a newline is a header injection into every send');

select must_fail($$
  insert into message_templates (key, subject, body)
  values ('password_reset', '   ', 'code {{code}}')
$$, 'template subject cannot be blank -- an empty subject is an outage, not a style');

select must_fail($$
  insert into message_templates (key, subject, body)
  values ('Password Reset', 'ok', 'code {{code}}')
$$, 'template key must match message_log.template -- lowercase and underscores only');

select must_pass($$
  insert into message_templates (key, subject, body)
  values ('password_reset', 'Your code', 'Use {{code}} to continue')
$$, 'message_templates -- a well-formed override is accepted');

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
