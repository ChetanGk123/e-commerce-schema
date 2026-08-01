-- ============================================================
-- Demo seed data
--
-- Enough catalog, shipping and pricing to render a storefront and
-- exercise checkout. Deliberately contains NO customers, orders or
-- staff: those carry identity that must equal auth.users.id, so they
-- belong to whatever auth fixtures your environment creates.
--
-- Run: make seed
-- ============================================================

begin;

-- ------------------------------------------------------------
-- Store
-- ------------------------------------------------------------

update store_settings
set store_name          = 'Aurora Store',
    support_email       = 'support@aurora.example',
    support_phone       = '+918000000000',
    seller_gstin        = '29ABCDE1234F1Z5',
    seller_state_code   = '29',              -- Karnataka
    free_shipping_above = 2000,
    flat_shipping_rate  = 79,
    cod_enabled         = true
where id = 1;

-- ------------------------------------------------------------
-- Shipping
-- ------------------------------------------------------------

insert into shipping_zones (id, name, position) values
  ('a1000000-0000-4000-8000-000000000001', 'Karnataka',      0),
  ('a1000000-0000-4000-8000-000000000002', 'Metros',         1),
  ('a1000000-0000-4000-8000-000000000003', 'Rest of India',  2);

insert into serviceable_pincodes (pincode, zone_id, cod_allowed, courier) values
  ('560001', 'a1000000-0000-4000-8000-000000000001', true,  'Delhivery'),
  ('560095', 'a1000000-0000-4000-8000-000000000001', true,  'Delhivery'),
  ('400001', 'a1000000-0000-4000-8000-000000000002', true,  'Blue Dart'),
  ('110001', 'a1000000-0000-4000-8000-000000000002', true,  'Blue Dart'),
  ('737101', 'a1000000-0000-4000-8000-000000000003', false, 'Shiprocket');

-- Bands must not overlap -- rates_no_overlap enforces it, so these
-- double as a worked example of a valid tier set.
insert into shipping_rates
  (zone_id, min_weight_grams, max_weight_grams, min_order_total, max_order_total,
   rate, cod_surcharge, delivery_days)
values
  ('a1000000-0000-4000-8000-000000000001', 0,    1000, 0,    2000, 49,  25, 2),
  ('a1000000-0000-4000-8000-000000000001', 0,    1000, 2000, null, 0,   25, 2),
  ('a1000000-0000-4000-8000-000000000001', 1000, null, 0,    null, 99,  25, 3),
  ('a1000000-0000-4000-8000-000000000002', 0,    1000, 0,    2000, 79,  35, 3),
  ('a1000000-0000-4000-8000-000000000002', 0,    1000, 2000, null, 0,   35, 3),
  ('a1000000-0000-4000-8000-000000000002', 1000, null, 0,    null, 149, 35, 4),
  ('a1000000-0000-4000-8000-000000000003', 0,    null, 0,    null, 199, 50, 7);

-- ------------------------------------------------------------
-- Catalog
-- ------------------------------------------------------------

insert into categories (id, name, slug, position) values
  ('a2000000-0000-4000-8000-000000000001', 'Computers', 'computers', 0),
  ('a2000000-0000-4000-8000-000000000002', 'Laptops',   'laptops',   0);

update categories set parent_id = 'a2000000-0000-4000-8000-000000000001'
where id = 'a2000000-0000-4000-8000-000000000002';

insert into products (id, category_id, brand, name, slug, description,
                      hsn_code, gst_rate, status)
values ('a3000000-0000-4000-8000-000000000001',
        'a2000000-0000-4000-8000-000000000002',
        'Aurora', 'Aurora Laptop', 'aurora-laptop',
        'A thin, quiet laptop for people who read more than they render.',
        '8471', 18.00, 'active');

-- Options: two axes, two variants.
insert into product_options (id, product_id, name, position) values
  ('a4000000-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', 'Storage', 0),
  ('a4000000-0000-4000-8000-000000000002',
   'a3000000-0000-4000-8000-000000000001', 'Colour',  1);

insert into product_option_values (id, option_id, product_id, value, position) values
  ('a5000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', '512GB', 0),
  ('a5000000-0000-4000-8000-000000000002', 'a4000000-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001', '1TB',   1),
  ('a5000000-0000-4000-8000-000000000003', 'a4000000-0000-4000-8000-000000000002',
   'a3000000-0000-4000-8000-000000000001', 'Midnight', 0);

insert into product_variants
  (id, product_id, sku, title, specs, price, compare_at_price, cost_price,
   stock, low_stock_threshold, weight_grams, is_default)
values
  ('a6000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001',
   'SKU-AUR-M1-512', '512GB / Midnight',
   '{"chip":"M1","ram_gb":16,"ssd_gb":512}'::jsonb,
   89900, 99900, 62000, 0, 3, 1240, true),
  ('a6000000-0000-4000-8000-000000000002', 'a3000000-0000-4000-8000-000000000001',
   'SKU-AUR-M1-1TB', '1TB / Midnight',
   '{"chip":"M1","ram_gb":16,"ssd_gb":1024}'::jsonb,
   109900, 119900, 74000, 0, 3, 1240, false);

-- Insert all of a variant's option values in ONE statement: the
-- statement-level trigger then computes options_signature once.
insert into variant_option_values (variant_id, option_value_id, product_id) values
  ('a6000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001',
   'a3000000-0000-4000-8000-000000000001'),
  ('a6000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000003',
   'a3000000-0000-4000-8000-000000000001'),
  ('a6000000-0000-4000-8000-000000000002', 'a5000000-0000-4000-8000-000000000002',
   'a3000000-0000-4000-8000-000000000001'),
  ('a6000000-0000-4000-8000-000000000002', 'a5000000-0000-4000-8000-000000000003',
   'a3000000-0000-4000-8000-000000000001');

insert into product_images (product_id, variant_id, url, alt_text, position) values
  ('a3000000-0000-4000-8000-000000000001', null,
   'https://images.example/aurora/hero.jpg',
   'Aurora Laptop, closed, three-quarter view', 0);

-- Stock arrives through the ledger, never by writing variant.stock.
insert into inventory_movements (variant_id, quantity, reason, note) values
  ('a6000000-0000-4000-8000-000000000001', 25, 'purchase', 'opening stock'),
  ('a6000000-0000-4000-8000-000000000002', 10, 'purchase', 'opening stock');

insert into collections (id, name, slug, description, is_active) values
  ('a7000000-0000-4000-8000-000000000001', 'New Arrivals', 'new-arrivals',
   'Just landed.', true);

insert into collection_products (collection_id, product_id, position) values
  ('a7000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 0);

-- ------------------------------------------------------------
-- Promotions
-- ------------------------------------------------------------

insert into discounts (code, description, kind, value, min_order_total,
                       max_uses, max_uses_per_customer, ends_at)
values ('WELCOME10', '10% off your first order', 'percent', 10, 1000,
        1000, 1, now() + interval '90 days');

commit;
