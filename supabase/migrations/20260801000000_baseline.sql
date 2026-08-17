-- ============================================================
-- E-commerce schema -- squashed baseline
-- Postgres 15+ / Supabase
--
-- This is the SOURCE OF TRUTH. It replaces the eleven ordered
-- migrations that built this schema incrementally; they were
-- squashed once, before the schema had shipped anywhere it could
-- not be rebuilt.
--
-- To CHANGE this schema, add a new migration beside this file --
-- do not edit this one. The filename's leading timestamp is what
-- keeps this baseline sorted first; anything added later must use
-- a later timestamp or it will apply out of order.
--
-- The whole file is one transaction: if any statement fails,
-- nothing is created.
--
-- Afterwards, two optional extras:
--   psql "$DATABASE_URL" -f supabase/jobs/retention.sql   (schedulers)
--   psql "$DATABASE_URL" -f supabase/seed.sql             (demo data)
-- ============================================================

begin;


-- ============================================================
-- SOURCE: 20260801000100_extensions.sql
-- ============================================================

-- ============================================================
-- 0001  Extensions
--
-- Every later migration assumes these are present. Supabase ships
-- all four; on self-hosted Postgres they come with contrib.
-- ============================================================


-- citext: case-insensitive email. Without it Foo@x.com and foo@x.com
-- are two different customers, which is one of the most common
-- duplicate-account bugs in production e-commerce.
create extension if not exists citext;

-- pg_trgm: fuzzy catalog search ("iphone chrger" -> "iPhone charger").
-- Used by the GIN indexes in the indexes migration.
create extension if not exists pg_trgm;

-- btree_gist: lets exclusion constraints mix uuid equality with range
-- overlap. Used to stop overlapping shipping rate bands.
create extension if not exists btree_gist;

-- pgcrypto: gen_random_uuid() is built into Postgres 13+, but pgcrypto
-- also gives us digest() for hashing gift card codes.
create extension if not exists pgcrypto;



-- ============================================================
-- SOURCE: 20260801000200_functions_base.sql
-- ============================================================

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



-- ============================================================
-- SOURCE: 20260801000300_identity.sql
-- ============================================================

-- ============================================================
-- 0003  Identity: staff, customers, addresses, consent
--
-- THE IDENTITY CONTRACT
--
-- customers.id   IS auth.users.id
-- staff_users.id IS auth.users.id
--
-- This is not optional and not a convention -- every RLS policy in
-- this project compares these columns against auth.uid() directly.
-- The previous version of this schema declared these columns as
-- `default gen_random_uuid()` while the RLS file assumed they
-- equalled auth.uid(). The result was a database where auth.uid()
-- never matched any row, so every customer policy and the whole
-- staff blanket denied silently, and the service key was the only
-- thing that worked. The default is deliberately REMOVED here so
-- that inserting a customer without supplying auth.uid() is an
-- error you see immediately rather than a permission failure you
-- discover in production.
--
-- Guests never get a customers row. Guest identity lives on the
-- order itself (orders.guest_email / guest_phone) and on
-- carts.session_id.
-- ============================================================


-- ------------------------------------------------------------
-- Staff
-- ------------------------------------------------------------

create table staff_users (
  id          uuid primary key,          -- = auth.users.id, no default on purpose
  email       citext not null unique,
  full_name   text,
  role        text not null default 'support'
              check (role in ('owner', 'admin', 'manager', 'support', 'warehouse')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table staff_users is
  'Admin console users. id must equal auth.users.id -- is_staff() joins on it.';
comment on column staff_users.role is
  'ACCEPTED RISK: RLS grants every active staff member full access to all '
  'tables regardless of this column (see the staff_all policy). Role '
  'enforcement is currently an application concern. Anyone holding a staff '
  'JWT can read cost_price, customer PII and store_settings.config through '
  'PostgREST directly, whatever the admin UI shows.';

-- ------------------------------------------------------------
-- Customers
-- ------------------------------------------------------------

create table customers (
  id             uuid primary key,       -- = auth.users.id, no default on purpose
  email          citext unique,
  phone          text unique,
  full_name      text,
  -- DPDP erasure: we scrub rather than delete, because orders,
  -- invoices and the credit ledger must survive for GST retention.
  -- See anonymize_customer() in the triggers migration.
  anonymized_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- A row with neither contact method is unreachable and, because
  -- UNIQUE permits many NULLs, could be created without limit.
  constraint customers_reachable
    check (email is not null or phone is not null or anonymized_at is not null),

  -- Store phones in E.164 so the COD blocklist actually matches.
  -- '+919876543210' and '9876543210' are not the same string, and a
  -- blocklist that stores one and checks the other blocks nobody.
  constraint customers_phone_e164
    check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$')
);

comment on table customers is
  'Shoppers. id must equal auth.users.id. Guests have no row here.';
comment on column customers.anonymized_at is
  'Set by anonymize_customer(). Non-null means PII has been scrubbed for a '
  'DPDP erasure request while the commercial record was retained.';

-- ------------------------------------------------------------
-- Addresses
-- ------------------------------------------------------------

create table addresses (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references customers(id) on delete cascade,
  label        text,                             -- "Home", "Office"
  line1        text not null,
  line2        text,
  city         text not null,
  state        text not null,
  postal_code  text not null,
  country      text not null default 'IN',
  is_default   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint addresses_country_iso
    check (country ~ '^[A-Z]{2}$'),
  -- India PIN codes never start with 0.
  constraint addresses_pincode_format
    check (country <> 'IN' or postal_code ~ '^[1-9][0-9]{5}$')
);

-- Exactly one default address per customer. Nothing in the previous
-- schema stopped a customer accumulating five "default" addresses,
-- which makes checkout's address preselection nondeterministic.
create unique index uniq_default_address
  on addresses(customer_id)
  where is_default;

-- ------------------------------------------------------------
-- Consent & channel preferences
--
-- Transactional updates default ON; marketing defaults OFF --
-- India's DPDP Act expects explicit opt-in.
-- ------------------------------------------------------------

create table communication_preferences (
  customer_id             uuid primary key references customers(id) on delete cascade,
  order_updates_email     boolean not null default true,
  order_updates_sms       boolean not null default true,
  order_updates_whatsapp  boolean not null default true,
  marketing_email         boolean not null default false,
  marketing_sms           boolean not null default false,
  marketing_whatsapp      boolean not null default false,
  updated_at              timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Bind identity to Supabase auth, when auth.users is present.
--
-- Guarded so the same migration set can be applied to a vanilla
-- Postgres (CI, `make verify`) where the auth schema does not
-- exist. On Supabase both constraints are created.
--
-- ON DELETE RESTRICT on customers is deliberate: deleting an auth
-- user must NOT cascade away their credit_ledger, which is money
-- you owe them, nor their order history, which GST requires you to
-- keep for eight years. Call anonymize_customer() first, then
-- delete the auth user.
-- ------------------------------------------------------------

do $$
begin
  if to_regclass('auth.users') is not null then
    alter table customers
      add constraint customers_id_fkey
      foreign key (id) references auth.users(id) on delete restrict;

    alter table staff_users
      add constraint staff_users_id_fkey
      foreign key (id) references auth.users(id) on delete cascade;
  else
    raise notice
      'auth.users not found -- skipping identity FKs. Expected on vanilla Postgres; NOT expected on Supabase.';
  end if;
end $$;



-- ============================================================
-- SOURCE: 20260801000400_catalog.sql
-- ============================================================

-- ============================================================
-- 0004  Catalog
--
-- Pattern: products -> options -> option_values -> variants (SKUs)
--
-- The variant is the unit of sale. Carts and orders reference
-- variant_id, and a product with no choices still gets exactly one
-- default variant, so checkout logic stays uniform.
--
-- WHAT CHANGED FROM THE FLAT SCHEMA
--
-- product_option_values and variant_option_values now carry a
-- denormalized product_id. That column exists purely so the
-- composite foreign keys below can guarantee that every option
-- value attached to a variant belongs to the SAME product. The
-- previous single-column FKs happily let you build a MacBook
-- variant out of a T-shirt's "Size: XL" option value, and nothing
-- in the database would object. Same story for product_images,
-- where variant_id could point at another product's variant.
-- ============================================================


-- ------------------------------------------------------------
-- Categories (the navigational tree)
-- ------------------------------------------------------------

create table categories (
  id          uuid primary key default gen_random_uuid(),
  parent_id   uuid references categories(id) on delete set null,
  name        text not null,
  slug        text not null unique,
  position    int  not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint categories_no_self_parent check (id <> parent_id),
  constraint categories_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

comment on constraint categories_no_self_parent on categories is
  'Blocks the one-hop cycle only. Deeper cycles (A->B->A) are not '
  'expressible as a CHECK; the admin app must validate on reparent.';

-- ------------------------------------------------------------
-- Products
-- ------------------------------------------------------------

create table products (
  id           uuid primary key default gen_random_uuid(),
  category_id  uuid references categories(id) on delete set null,
  brand        text,
  name         text not null,                    -- "MacBook Air"
  slug         text not null unique,
  description  text,                             -- shared marketing copy
  hsn_code     text,                             -- for GST invoicing (India)
  gst_rate     numeric(4,2),                     -- e.g. 18.00
  status       text not null default 'draft'
               check (status in ('draft', 'active', 'archived')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint products_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint products_gst_rate_range
    check (gst_rate is null or (gst_rate >= 0 and gst_rate <= 100))
);

-- Composite-FK anchor: lets children prove they belong to a product.
alter table products add constraint products_id_self unique (id);

-- ------------------------------------------------------------
-- Options: the axes a product varies on
-- "Chip", "Memory", "Storage", "Colour"
-- ------------------------------------------------------------

create table product_options (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id) on delete cascade,
  name        text not null,                     -- "Colour"
  position    int  not null default 0,

  unique (product_id, name),
  -- Anchor for product_option_values' composite FK.
  unique (id, product_id)
);

-- ------------------------------------------------------------
-- Option values: the choices within each axis
-- "Midnight", "Silver", "Starlight"
-- ------------------------------------------------------------

create table product_option_values (
  id          uuid primary key default gen_random_uuid(),
  option_id   uuid not null,
  -- Denormalized so the composite FK can pin the product. Kept in
  -- step by the FK itself: you cannot set a product_id that
  -- disagrees with the option's product_id.
  product_id  uuid not null,
  value       text not null,                     -- "Midnight"
  position    int  not null default 0,

  foreign key (option_id, product_id)
    references product_options(id, product_id) on delete cascade,

  unique (option_id, value),
  unique (id, product_id)
);

-- ------------------------------------------------------------
-- Variants: the sellable unit
-- ------------------------------------------------------------

create table product_variants (
  id                uuid primary key default gen_random_uuid(),
  product_id        uuid not null references products(id) on delete cascade,
  sku               text not null unique,
  title             text,                        -- "M3 / 16GB / 512GB / Midnight"
  description       text,                        -- falls back to product
  specs             jsonb not null default '{}'::jsonb,
                    -- e.g. {"chip":"M3","ram_gb":16,"ssd_gb":512}
  price             numeric(12,2) not null check (price >= 0),
  compare_at_price  numeric(12,2),               -- MRP / strike-through
  cost_price        numeric(12,2),               -- margins; never expose to storefront
  currency          text not null default 'INR',
  stock             int not null default 0 check (stock >= 0),
  low_stock_threshold int not null default 0 check (low_stock_threshold >= 0),
  weight_grams      int check (weight_grams is null or weight_grams >= 0),
  barcode           text,
  is_default        boolean not null default false,

  -- 'out_of_stock' was removed as a status value. It duplicated
  -- `stock = 0` with nothing keeping the two in sync, so the pair
  -- drifted. Availability is now derived, never stored.
  status            text not null default 'active'
                    check (status in ('active', 'archived')),
  is_purchasable    boolean generated always as
                    (status = 'active' and stock > 0) stored,

  -- Canonical combo signature: sorted option_value_ids joined with
  -- '|', maintained by trigger (see the triggers migration). The
  -- partial unique index below is what stops two variants claiming
  -- the same combination -- plain FKs cannot enforce this.
  options_signature text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint variants_currency_iso check (currency ~ '^[A-Z]{3}$'),
  constraint variants_cost_price_nonneg
    check (cost_price is null or cost_price >= 0),
  -- A strike-through price below the selling price is a pricing bug
  -- and, in India, a consumer-protection problem.
  constraint variants_compare_at_above_price
    check (compare_at_price is null or compare_at_price >= price),

  -- Anchor for the composite FKs on variant_option_values and
  -- product_images.
  unique (id, product_id)
);

comment on column product_variants.currency is
  'Multi-currency is NOT implemented: there is no FX rate table and no '
  'per-currency price list. Keep every row on one currency until that '
  'is built, or carts and orders will silently mix denominations.';
comment on column product_variants.is_purchasable is
  'Derived availability. Storefront queries should filter on this rather '
  'than reimplementing the status/stock rule.';

create unique index uniq_variant_combo
  on product_variants(product_id, options_signature)
  where options_signature is not null;

-- Exactly one default variant per product. Without this a product
-- can have zero defaults (product page cannot preselect) or five
-- (it picks arbitrarily).
create unique index uniq_default_variant
  on product_variants(product_id)
  where is_default;

-- ------------------------------------------------------------
-- Which option values define a variant
-- "MacBook Air / M3 / 16GB / 512GB / Midnight" = 4 rows here
-- ------------------------------------------------------------

create table variant_option_values (
  variant_id       uuid not null,
  option_value_id  uuid not null,
  product_id       uuid not null,

  -- Both sides must resolve to the same product_id, so an option
  -- value from a different product simply cannot be attached.
  foreign key (variant_id, product_id)
    references product_variants(id, product_id) on delete cascade,
  foreign key (option_value_id, product_id)
    references product_option_values(id, product_id) on delete cascade,

  primary key (variant_id, option_value_id)
);

-- ------------------------------------------------------------
-- Images: product-level gallery, optionally pinned to one variant
-- (variant_id null = shared image shown for every configuration)
-- ------------------------------------------------------------

create table product_images (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id) on delete cascade,
  variant_id  uuid,
  url         text not null,
  alt_text    text,
  position    int not null default 0,

  -- MATCH SIMPLE: a NULL variant_id satisfies the constraint, so
  -- shared gallery images still work while a non-null variant_id is
  -- forced to belong to this same product.
  foreign key (variant_id, product_id)
    references product_variants(id, product_id) on delete cascade
);

-- ------------------------------------------------------------
-- Merchandising: curated collections
-- (distinct from categories -- "Diwali Sale", "New Arrivals")
-- ------------------------------------------------------------

create table collections (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  description text,
  image_url   text,
  is_active   boolean not null default true,
  position    int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint collections_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

create table collection_products (
  collection_id uuid not null references collections(id) on delete cascade,
  product_id    uuid not null references products(id) on delete cascade,
  position      int not null default 0,
  primary key (collection_id, product_id)
);

-- ------------------------------------------------------------
-- Cross-sells
-- ------------------------------------------------------------

create table product_relations (
  product_id          uuid not null references products(id) on delete cascade,
  related_product_id  uuid not null references products(id) on delete cascade,
  kind                text not null default 'related'
                      check (kind in ('related', 'upsell', 'cross_sell', 'accessory')),
  position            int not null default 0,
  primary key (product_id, related_product_id, kind),
  check (product_id <> related_product_id)
);



-- ============================================================
-- SOURCE: 20260801000500_commerce.sql
-- ============================================================

-- ============================================================
-- 0005  Commerce: orders, payments, carts, inventory, fulfilment
--
-- Line items snapshot everything at purchase time. Catalog rows get
-- repriced, renamed and archived -- orders must stay historically
-- exact.
-- ============================================================


-- ------------------------------------------------------------
-- Orders
-- ------------------------------------------------------------

create table orders (
  id               uuid primary key default gen_random_uuid(),
  order_number     text not null unique,         -- "ORD-2026-00042", see next_order_number()
  customer_id      uuid references customers(id) on delete set null,

  -- Contact is snapshotted, never joined for. A guest order has no
  -- customer row at all, and an anonymized customer keeps their
  -- order history but loses their PII -- in both cases the order
  -- still has to be reachable by support. The previous schema left
  -- the only guest contact buried inside the shipping_address blob.
  email            citext not null,
  phone            text,

  status           text not null default 'pending'
                   check (status in ('pending', 'paid', 'packed',
                                     'shipped', 'delivered',
                                     'cancelled', 'refunded')),
  subtotal         numeric(12,2) not null check (subtotal >= 0),
  discount_total   numeric(12,2) not null default 0 check (discount_total >= 0),
  shipping_total   numeric(12,2) not null default 0 check (shipping_total >= 0),
  tax_total        numeric(12,2) not null default 0 check (tax_total >= 0),   -- GST
  grand_total      numeric(12,2) not null check (grand_total >= 0),
  currency         text not null default 'INR',
  coupon_code      text,                         -- snapshot of applied discount code

  utm_source       text,                         -- 'instagram', 'google'...
  utm_medium       text,                         -- 'cpc', 'organic', 'whatsapp'
  utm_campaign     text,                         -- 'diwali-2026'

  risk_score       int check (risk_score is null or risk_score between 0 and 100),
  risk_flags       jsonb not null default '[]'::jsonb,  -- ["repeat_rto","blocklisted_pincode"]

  shipping_address jsonb not null,               -- snapshot, deliberately not a FK
  billing_address  jsonb,                        -- snapshot; null = same as shipping

  placed_at        timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint orders_currency_iso check (currency ~ '^[A-Z]{3}$'),
  constraint orders_phone_e164
    check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  -- Arithmetic the application can no longer get wrong. Every
  -- discrepancy here is a number a customer was shown or charged.
  constraint orders_totals_balance
    check (grand_total = subtotal - discount_total + shipping_total + tax_total),
  constraint orders_discount_within_subtotal
    check (discount_total <= subtotal)
);

comment on column orders.updated_at is
  'Required for incremental sync and "changed since" reporting. Orders move '
  'through seven statuses; without this there is no way to page through what '
  'changed.';

-- ------------------------------------------------------------
-- Order line items
-- ------------------------------------------------------------

create table order_items (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references orders(id) on delete cascade,
  variant_id     uuid references product_variants(id) on delete set null,
  product_name   text not null,                  -- snapshot: "MacBook Air"
  variant_title  text not null,                  -- snapshot: "M3 / 16GB / 512GB / Midnight"
  sku            text not null,                  -- snapshot
  unit_price     numeric(12,2) not null check (unit_price >= 0),
  quantity       int not null check (quantity > 0),
  -- Generated, so it cannot disagree with its own inputs.
  line_total     numeric(12,2) generated always as (unit_price * quantity) stored,

  -- Anchor for the composite FKs on shipment_items and return_items,
  -- which use it to prove a line item belongs to the same order.
  unique (id, order_id)
);

-- ------------------------------------------------------------
-- Payments
-- ------------------------------------------------------------

create table payments (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references orders(id) on delete cascade,
  provider      text not null,                   -- 'razorpay', 'cod', 'store_credit'...
  provider_ref  text,                            -- gateway payment/order id
  amount        numeric(12,2) not null check (amount > 0),
  status        text not null default 'created'
                check (status in ('created', 'authorized', 'captured',
                                  'failed', 'refunded')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Webhook idempotency. Razorpay (and every other gateway) retries
-- deliveries; without this a duplicate delivery can capture twice.
-- Partial, because COD and store-credit payments have no gateway ref.
create unique index uniq_payment_provider_ref
  on payments(provider, provider_ref)
  where provider_ref is not null;

-- ------------------------------------------------------------
-- Order timeline
-- Powers the admin timeline + customer tracking page, and is the
-- audit trail for disputes. Append-only (see triggers migration).
-- ------------------------------------------------------------

create table order_events (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders(id) on delete cascade,
  event       text not null,                     -- 'status_changed', 'note_added'...
  from_status text,
  to_status   text,
  note        text,
  actor_type  text not null default 'system'
              check (actor_type in ('system', 'customer', 'staff')),
  actor_id    uuid,                              -- customers.id or staff_users.id per actor_type
  created_at  timestamptz not null default now(),

  constraint order_events_actor_present
    check (actor_type = 'system' or actor_id is not null)
);

-- ------------------------------------------------------------
-- Cart
-- ------------------------------------------------------------

create table carts (
  id                 uuid primary key default gen_random_uuid(),
  customer_id        uuid references customers(id) on delete cascade,
  session_id         text,                       -- guest carts before login
  status             text not null default 'active'
                     check (status in ('active', 'converted', 'abandoned')),
  -- Closes the loop for abandoned-cart recovery: without it there is
  -- no way to tell a recovered cart from a still-open one.
  converted_order_id uuid references orders(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint carts_owner_present
    check (customer_id is not null or session_id is not null),
  constraint carts_converted_has_order
    check (status <> 'converted' or converted_order_id is not null)
);

-- One live cart per signed-in customer. Without this, "the cart" is
-- ambiguous after a guest cart merges into an account.
create unique index uniq_active_cart_per_customer
  on carts(customer_id)
  where status = 'active' and customer_id is not null;

comment on table carts is
  'Guest carts accumulate without bound. Run the retention job in '
  'supabase/jobs/retention.sql to sweep abandoned guest carts, or this '
  'becomes the largest table in the database.';

create table cart_items (
  id          uuid primary key default gen_random_uuid(),
  cart_id     uuid not null references carts(id) on delete cascade,
  variant_id  uuid not null references product_variants(id) on delete cascade,
  -- Upper bound is a fat-finger and abuse guard: quantity is an int,
  -- so without a cap a client can put two billion units in a cart and
  -- blow up every downstream total.
  quantity    int not null check (quantity > 0 and quantity <= 10000),
  created_at  timestamptz not null default now(),
  unique (cart_id, variant_id)
);

-- ------------------------------------------------------------
-- Inventory ledger
--
-- Source of truth for stock. product_variants.stock is a cached
-- total maintained by trigger in the SAME transaction as each
-- movement. Reserve on payment initiation ('reservation'), release
-- on failure/timeout ('release'), convert to 'sale' on capture.
-- ------------------------------------------------------------

create table inventory_movements (
  id             uuid primary key default gen_random_uuid(),
  variant_id     uuid not null references product_variants(id) on delete cascade,
  quantity       int not null check (quantity <> 0),   -- positive in, negative out
  reason         text not null
                 check (reason in ('purchase', 'sale', 'return', 'adjustment',
                                   'damage', 'reservation', 'release')),
  order_id       uuid references orders(id) on delete set null,

  -- A reservation that nothing ever releases strands stock forever.
  -- The sweeper job finds expired reservations by this column.
  expires_at     timestamptz,

  -- Which reservation this row consumes. Together with the unique
  -- index below this makes double-release structurally impossible:
  -- previously nothing stopped two 'release' rows for one hold,
  -- which silently inflated stock.
  reservation_id uuid references inventory_movements(id) on delete restrict,

  note           text,
  created_by     uuid references staff_users(id) on delete set null,
  created_at     timestamptz not null default now(),

  constraint inv_reservation_expires
    check (reason <> 'reservation' or expires_at is not null),
  constraint inv_reservation_is_negative
    check (reason <> 'reservation' or quantity < 0),
  constraint inv_consumer_has_reservation
    check (reservation_id is null or reason in ('release', 'sale'))
);

create unique index uniq_reservation_consumed
  on inventory_movements(reservation_id)
  where reservation_id is not null;

-- ------------------------------------------------------------
-- Fulfilment
-- ------------------------------------------------------------

create table shipments (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references orders(id) on delete cascade,
  carrier         text,                          -- 'Delhivery', 'Blue Dart', 'Shiprocket'
  service         text,                          -- 'surface', 'express'
  tracking_number text,
  tracking_url    text,
  status          text not null default 'label_created'
                  check (status in ('label_created', 'picked_up', 'in_transit',
                                    'out_for_delivery', 'delivered', 'rto', 'lost')),
  shipped_at      timestamptz,
  delivered_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint shipments_delivered_after_shipped
    check (delivered_at is null or shipped_at is null or delivered_at >= shipped_at),

  -- Anchor for shipment_items' composite FK.
  unique (id, order_id)
);

-- Carrier webhooks look up by (carrier, tracking_number). Unique so a
-- replayed carrier callback cannot create a second shipment.
create unique index uniq_shipment_tracking
  on shipments(carrier, tracking_number)
  where tracking_number is not null;

-- Supports partial fulfilment: one order can ship in several boxes.
--
-- order_id is denormalized so the two composite FKs force the
-- shipment and the line item to belong to the SAME order. Without
-- it you can put another customer's order item in your shipment.
--
-- The quantity ceiling (sum across shipments <= ordered quantity) is
-- enforced by trigger, since a CHECK cannot see sibling rows.
create table shipment_items (
  shipment_id    uuid not null,
  order_item_id  uuid not null,
  order_id       uuid not null,
  quantity       int not null check (quantity > 0),

  foreign key (shipment_id, order_id)
    references shipments(id, order_id) on delete cascade,
  foreign key (order_item_id, order_id)
    references order_items(id, order_id) on delete cascade,

  primary key (shipment_id, order_item_id)
);



-- ============================================================
-- SOURCE: 20260801000600_money.sql
-- ============================================================

-- ============================================================
-- 0006  Money: discounts, returns, refunds, GST invoicing, wallet
-- ============================================================


-- ------------------------------------------------------------
-- Discounts & coupons
-- ------------------------------------------------------------

create table discounts (
  id                     uuid primary key default gen_random_uuid(),
  code                   citext not null unique,   -- "DIWALI20", case-insensitive
  description            text,
  kind                   text not null
                         check (kind in ('percent', 'fixed', 'free_shipping')),
  value                  numeric(12,2) not null default 0 check (value >= 0),
  min_order_total        numeric(12,2) check (min_order_total is null or min_order_total >= 0),
  applies_to             text not null default 'order'
                         check (applies_to in ('order', 'collection', 'product')),
  collection_id          uuid references collections(id) on delete cascade,
  product_id             uuid references products(id) on delete cascade,

  max_uses               int check (max_uses is null or max_uses > 0),  -- null = unlimited
  max_uses_per_customer  int default 1 check (max_uses_per_customer is null
                                              or max_uses_per_customer > 0),

  -- Redemption counter, incremented in the same transaction as the
  -- redemption row (see enforce_discount_limits()). The CHECK below
  -- is what actually stops overuse: previously max_uses was advisory,
  -- so two concurrent checkouts could both claim the last use of a
  -- single-use code and the store ate the difference.
  used_count             int not null default 0 check (used_count >= 0),

  starts_at              timestamptz not null default now(),
  ends_at                timestamptz,
  is_active              boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint discounts_within_max_uses
    check (max_uses is null or used_count <= max_uses),
  constraint discounts_window_ordered
    check (ends_at is null or ends_at > starts_at),
  -- A percentage over 100 turns a coupon into a payout.
  constraint discounts_percent_range
    check (kind <> 'percent' or (value > 0 and value <= 100)),
  constraint discounts_fixed_positive
    check (kind <> 'fixed' or value > 0),
  -- The target must match the scope. Nothing previously stopped an
  -- applies_to='product' discount with a null product_id, which the
  -- application then had to interpret, differently in each code path.
  constraint discounts_target_matches_scope check (
    (applies_to = 'order'      and collection_id is null and product_id is null) or
    (applies_to = 'collection' and collection_id is not null and product_id is null) or
    (applies_to = 'product'    and product_id is not null and collection_id is null)
  )
);

-- Enforces usage limits and answers "who used what" for support.
create table discount_redemptions (
  id           uuid primary key default gen_random_uuid(),
  discount_id  uuid not null references discounts(id) on delete cascade,
  order_id     uuid not null references orders(id) on delete cascade,
  customer_id  uuid references customers(id) on delete set null,
  amount       numeric(12,2) not null check (amount >= 0),  -- what it actually saved
  created_at   timestamptz not null default now(),
  unique (discount_id, order_id)
);

-- ------------------------------------------------------------
-- Returns & refunds (RMA flow)
-- ------------------------------------------------------------

create table return_requests (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references orders(id) on delete cascade,
  customer_id  uuid references customers(id) on delete set null,
  reason       text not null,                    -- 'damaged', 'wrong_item'...
  status       text not null default 'requested'
               check (status in ('requested', 'approved', 'rejected',
                                 'pickup_scheduled', 'received', 'refunded', 'closed')),
  resolution   text check (resolution in ('refund', 'replacement', 'store_credit')),
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  resolved_at  timestamptz,

  -- Anchor for return_items' composite FK.
  unique (id, order_id)
);

-- order_id is denormalized so the composite FKs force the return and
-- the line item onto the SAME order. Previously a customer could file
-- a return referencing any order_item in the database, including
-- someone else's -- the RLS insert policy only checked the return's
-- own ownership, not the item's.
--
-- Quantity ceiling (sum of returns <= quantity ordered) is enforced
-- by trigger; a CHECK cannot see sibling rows.
create table return_items (
  return_id      uuid not null,
  order_item_id  uuid not null,
  order_id       uuid not null,
  quantity       int not null check (quantity > 0),
  condition      text,                           -- assessed on receipt at warehouse

  foreign key (return_id, order_id)
    references return_requests(id, order_id) on delete cascade,
  foreign key (order_item_id, order_id)
    references order_items(id, order_id) on delete cascade,

  primary key (return_id, order_item_id)
);

-- Refunds reference the original payment because gateways (Razorpay
-- and friends) refund against a specific payment id.
create table refunds (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references orders(id) on delete cascade,
  payment_id   uuid references payments(id) on delete set null,
  return_id    uuid references return_requests(id) on delete set null,
  amount       numeric(12,2) not null check (amount > 0),
  provider_ref text,                             -- gateway refund id
  status       text not null default 'initiated'
               check (status in ('initiated', 'processed', 'failed')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Same webhook-idempotency reasoning as payments: a replayed refund
-- callback must not create a second refund row.
create unique index uniq_refund_provider_ref
  on refunds(provider_ref)
  where provider_ref is not null;

-- ------------------------------------------------------------
-- GST invoicing
--
-- Invoices are immutable legal documents: numbers are sequential and
-- gap-free per financial year, rows are never deleted, and everything
-- is snapshotted (customer, addresses, tax breakup). Returns get a
-- credit_note referencing the original invoice.
-- ------------------------------------------------------------

-- Gap-free numbering. Postgres sequences leak numbers on rollback,
-- which GST rules do not allow. See next_invoice_number().
create table invoice_sequences (
  fy           text primary key,               -- '2026-27'
  last_number  int not null default 0 check (last_number >= 0)
);

create table invoices (
  id                 uuid primary key default gen_random_uuid(),
  invoice_number     text not null unique,     -- 'INV/2026-27/00042'
  order_id           uuid not null references orders(id) on delete restrict,
  kind               text not null default 'tax_invoice'
                     check (kind in ('tax_invoice', 'credit_note')),
  parent_invoice_id  uuid references invoices(id),  -- credit notes point at the original
  customer_name      text not null,            -- snapshot
  customer_gstin     text,                     -- B2B buyers claiming input credit
  billing_address    jsonb not null,           -- snapshot
  seller_gstin       text not null,            -- snapshot from store_settings.config
  place_of_supply    text not null,            -- state code; vs seller state decides
                                               -- the split: same state -> CGST + SGST,
                                               -- different -> IGST
  taxable_value      numeric(12,2) not null check (taxable_value >= 0),
  cgst_total         numeric(12,2) not null default 0 check (cgst_total >= 0),
  sgst_total         numeric(12,2) not null default 0 check (sgst_total >= 0),
  igst_total         numeric(12,2) not null default 0 check (igst_total >= 0),
  grand_total        numeric(12,2) not null check (grand_total >= 0),
  pdf_url            text,

  -- e-invoicing (mandatory above the GST turnover threshold). Null
  -- until the IRP returns them; populated by the e-invoice worker.
  irn                text unique,              -- Invoice Reference Number
  ack_no             text,
  ack_date           timestamptz,
  signed_qr          text,

  issued_at          timestamptz not null default now(),

  constraint invoices_gstin_format
    check (customer_gstin is null
           or customer_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'),
  constraint invoices_seller_gstin_format
    check (seller_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'),
  constraint invoices_pos_state_code
    check (place_of_supply ~ '^[0-9]{2}$'),
  -- CGST+SGST and IGST are mutually exclusive: intra-state or
  -- inter-state, never both.
  constraint invoices_tax_split_exclusive
    check ((igst_total = 0) or (cgst_total = 0 and sgst_total = 0)),
  -- Intra-state GST is always split evenly between centre and state.
  constraint invoices_cgst_equals_sgst
    check (cgst_total = sgst_total),
  constraint invoices_total_balances
    check (grand_total = taxable_value + cgst_total + sgst_total + igst_total),
  constraint invoices_credit_note_has_parent
    check (kind <> 'credit_note' or parent_invoice_id is not null),

  -- Anchor for invoice_lines' composite FK.
  unique (id, invoice_number)
);

create table invoice_lines (
  id             uuid primary key default gen_random_uuid(),
  invoice_id     uuid not null references invoices(id) on delete restrict,
  description    text not null,
  hsn_code       text,
  quantity       int not null check (quantity > 0),
  unit_price     numeric(12,2) not null check (unit_price >= 0),
  taxable_value  numeric(12,2) not null check (taxable_value >= 0),
  gst_rate       numeric(4,2) not null check (gst_rate >= 0 and gst_rate <= 100),
  cgst_amount    numeric(12,2) not null default 0 check (cgst_amount >= 0),
  sgst_amount    numeric(12,2) not null default 0 check (sgst_amount >= 0),
  igst_amount    numeric(12,2) not null default 0 check (igst_amount >= 0),
  line_total     numeric(12,2) not null check (line_total >= 0),

  constraint invoice_lines_tax_split_exclusive
    check ((igst_amount = 0) or (cgst_amount = 0 and sgst_amount = 0)),
  constraint invoice_lines_cgst_equals_sgst
    check (cgst_amount = sgst_amount),
  constraint invoice_lines_total_balances
    check (line_total = taxable_value + cgst_amount + sgst_amount + igst_amount)
);

-- ------------------------------------------------------------
-- Gift cards
--
-- The code is stored as a hash. A gift card code is a bearer
-- instrument: anyone who reads the column can spend it, so a leaked
-- backup, a support screenshot or an over-broad staff policy is a
-- direct cash loss. last4 exists so support can identify a card the
-- customer reads out without ever storing the full code.
--
-- balance is a cache over gift_card_transactions, maintained by
-- trigger in the same transaction, exactly like product_variants.
-- stock over inventory_movements. The previous schema declared the
-- ledger to be the source of truth and then let the balance column
-- drift freely with nothing reconciling the two.
-- ------------------------------------------------------------

create table gift_cards (
  id                 uuid primary key default gen_random_uuid(),
  code_hash          bytea not null unique,    -- digest(code, 'sha256')
  last4              text not null check (last4 ~ '^[A-Z0-9]{4}$'),
  initial_balance    numeric(12,2) not null check (initial_balance > 0),
  balance            numeric(12,2) not null check (balance >= 0),
  currency           text not null default 'INR',
  purchaser_id       uuid references customers(id) on delete set null,
  purchase_order_id  uuid references orders(id) on delete set null,
  recipient_email    citext,
  message            text,
  status             text not null default 'active'
                     check (status in ('active', 'redeemed', 'disabled', 'expired')),
  expires_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint gift_cards_currency_iso check (currency ~ '^[A-Z]{3}$'),
  constraint gift_cards_balance_within_initial check (balance <= initial_balance)
);

create table gift_card_transactions (
  id             uuid primary key default gen_random_uuid(),
  gift_card_id   uuid not null references gift_cards(id) on delete cascade,
  order_id       uuid references orders(id) on delete set null,
  delta          numeric(12,2) not null check (delta <> 0),  -- negative on redemption
  balance_after  numeric(12,2) not null check (balance_after >= 0),
  created_at     timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Store credit wallet
--
-- Append-only ledger: balance = sum(delta). There is deliberately no
-- cached balance column here -- see customer_credit_balances in the
-- views migration.
--
-- Fulfils the 'store_credit' return resolution and is the future home
-- for loyalty points. Spend it at checkout by adding a payments row
-- with provider = 'store_credit'.
-- ------------------------------------------------------------

create table credit_ledger (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references customers(id) on delete restrict,
  delta         numeric(12,2) not null check (delta <> 0),  -- positive credit, negative spend
  reason        text not null
                check (reason in ('return_credit', 'goodwill', 'promotion',
                                  'gift_card_redemption', 'order_payment',
                                  'expiry', 'adjustment')),
  order_id      uuid references orders(id) on delete set null,
  return_id     uuid references return_requests(id) on delete set null,
  gift_card_id  uuid references gift_cards(id) on delete set null,
  expires_at    timestamptz,
  note          text,
  created_by    uuid references staff_users(id) on delete set null,
  created_at    timestamptz not null default now()
);

comment on table credit_ledger is
  'ON DELETE RESTRICT on customer_id is deliberate. This ledger is money the '
  'business owes a person; a cascade would let deleting an account silently '
  'erase the liability. Use anonymize_customer() instead.';



-- ============================================================
-- SOURCE: 20260801000700_operations.sql
-- ============================================================

-- ============================================================
-- 0007  Operations: shipping, risk, engagement, messaging,
--       support, audit, settings, and platform plumbing
-- ============================================================


-- ------------------------------------------------------------
-- Shipping zones, rates & serviceability
--
-- serviceable_pincodes is seeded from your courier's serviceability
-- CSV export (Delhivery / Shiprocket publish these) and answers the
-- "deliver to 560001?" check on the product page.
-- ------------------------------------------------------------

create table shipping_zones (
  id        uuid primary key default gen_random_uuid(),
  name      text not null unique,   -- 'Karnataka', 'Metros', 'North East'
  position  int not null default 0
);

create table serviceable_pincodes (
  pincode      text primary key check (pincode ~ '^[1-9][0-9]{5}$'),
  zone_id      uuid references shipping_zones(id) on delete set null,
  cod_allowed  boolean not null default true,
  courier      text,                           -- preferred carrier for this pincode
  updated_at   timestamptz not null default now()
);

-- min/max_order_total was added so rate tiers can be made provably
-- non-overlapping. Previously two rows could both match one basket
-- and the rate the customer saw depended on plan order.
create table shipping_rates (
  id                uuid primary key default gen_random_uuid(),
  zone_id           uuid not null references shipping_zones(id) on delete cascade,
  min_weight_grams  int not null default 0 check (min_weight_grams >= 0),
  max_weight_grams  int,                       -- null = no cap
  min_order_total   numeric(12,2) not null default 0 check (min_order_total >= 0),
  max_order_total   numeric(12,2),             -- null = no cap
  rate              numeric(12,2) not null check (rate >= 0),
  cod_surcharge     numeric(12,2) not null default 0 check (cod_surcharge >= 0),
  delivery_days     int check (delivery_days is null or delivery_days > 0),
  is_active         boolean not null default true,

  constraint rates_weight_band_ordered
    check (max_weight_grams is null or max_weight_grams > min_weight_grams),
  constraint rates_value_band_ordered
    check (max_order_total is null or max_order_total > min_order_total),

  -- Exactly one active rate can match any (zone, weight, basket
  -- value) point. Needs btree_gist for the uuid equality operator.
  constraint rates_no_overlap exclude using gist (
    zone_id with =,
    int4range(min_weight_grams, max_weight_grams, '[)') with &&,
    numrange(min_order_total, max_order_total, '[)') with &&
  ) where (is_active)
);

-- ------------------------------------------------------------
-- COD risk
--
-- Block repeat RTO offenders before they cost you two-way courier
-- fees. Checkout computes orders.risk_score / risk_flags from this
-- plus history (e.g. RTO count for the phone in the last 90 days).
-- ------------------------------------------------------------

create table blocklist (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('phone', 'email', 'pincode', 'ip')),
  value       citext not null,
  reason      text,                            -- '3 RTOs in 60 days'
  added_by    uuid references staff_users(id) on delete set null,
  expires_at  timestamptz,                     -- null = permanent
  created_at  timestamptz not null default now(),
  unique (kind, value),

  -- Normalization is enforced, not hoped for. A blocklist storing
  -- '9876543210' while checkout looks up '+919876543210' blocks
  -- nobody, and you find out from the RTO bill.
  constraint blocklist_value_normalized check (
    case kind
      when 'phone'   then value ~ '^\+[1-9][0-9]{7,14}$'
      when 'pincode' then value ~ '^[1-9][0-9]{5}$'
      else true
    end
  )
);

-- ------------------------------------------------------------
-- Reviews & ratings
-- ------------------------------------------------------------

create table reviews (
  id             uuid primary key default gen_random_uuid(),
  product_id     uuid not null references products(id) on delete cascade,
  variant_id     uuid references product_variants(id) on delete set null,
  customer_id    uuid not null references customers(id) on delete cascade,
  order_item_id  uuid references order_items(id) on delete set null,  -- proof of purchase
  rating         int not null check (rating between 1 and 5),
  title          text,
  body           text,

  -- Generated, not client-supplied. This column is a trust signal
  -- shown to shoppers; when it was an ordinary boolean any customer
  -- could insert a review with is_verified = true and no purchase
  -- behind it. The linked order item is validated by trigger.
  is_verified    boolean generated always as (order_item_id is not null) stored,

  status         text not null default 'pending'
                 check (status in ('pending', 'approved', 'rejected')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (customer_id, product_id)               -- one review per product per customer
);

-- ------------------------------------------------------------
-- Engagement: wishlist + back-in-stock alerts
-- ------------------------------------------------------------

create table wishlist_items (
  customer_id uuid not null references customers(id) on delete cascade,
  variant_id  uuid not null references product_variants(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (customer_id, variant_id)
);

create table stock_alerts (
  id           uuid primary key default gen_random_uuid(),
  variant_id   uuid not null references product_variants(id) on delete cascade,
  customer_id  uuid references customers(id) on delete cascade,
  email        citext,                          -- for guests
  notified_at  timestamptz,                     -- null = still waiting
  created_at   timestamptz not null default now(),

  constraint stock_alerts_subject_present
    check (customer_id is not null or email is not null)
);

-- One pending alert per person per variant. Anonymous visitors can
-- insert here, so without these a single variant restock could fan
-- out thousands of duplicate emails to the same address -- from your
-- own sending domain, at your own reputation's expense.
create unique index uniq_pending_alert_customer
  on stock_alerts(variant_id, customer_id)
  where notified_at is null and customer_id is not null;

create unique index uniq_pending_alert_email
  on stock_alerts(variant_id, email)
  where notified_at is null and email is not null;

-- ------------------------------------------------------------
-- Price history (append-only; powers "price dropped" alerts)
-- ------------------------------------------------------------

create table price_history (
  id          uuid primary key default gen_random_uuid(),
  variant_id  uuid not null references product_variants(id) on delete cascade,
  old_price   numeric(12,2),
  new_price   numeric(12,2) not null,
  changed_by  uuid references staff_users(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Notifications & messaging
--
-- message_log doubles as a transactional outbox: insert as 'queued'
-- in the SAME transaction as the order, a worker sends it, and
-- provider webhooks flip status to delivered/bounced. Order
-- confirmations survive email-API hiccups that way.
-- ------------------------------------------------------------

create table notifications (
  id              uuid primary key default gen_random_uuid(),
  recipient_type  text not null check (recipient_type in ('customer', 'staff')),
  recipient_id    uuid not null,                 -- customers.id or staff_users.id
  kind            text not null,                 -- 'order_shipped', 'low_stock'...
  title           text not null,
  body            text,
  data            jsonb not null default '{}'::jsonb,  -- {"order_id": "..."}
  read_at         timestamptz,                   -- null = unread
  created_at      timestamptz not null default now()
);

create table message_log (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid references customers(id) on delete set null,
  order_id      uuid references orders(id) on delete set null,
  channel       text not null check (channel in ('email', 'sms', 'whatsapp', 'push')),
  template      text not null,                   -- 'order_confirmation', 'otp'...
  recipient     text not null,                   -- email/phone snapshot at send time
  payload       jsonb,                           -- variables rendered into the template
  status        text not null default 'queued'
                check (status in ('queued', 'sent', 'delivered', 'bounced', 'failed')),
  provider      text,                            -- 'resend', 'msg91', 'gupshup'...
  provider_ref  text,                            -- provider message id, matches webhooks
  error         text,
  attempts      int not null default 0 check (attempts >= 0),
  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);

-- Delivery webhooks arrive keyed by provider_ref and are retried.
create unique index uniq_message_provider_ref
  on message_log(provider, provider_ref)
  where provider_ref is not null;

-- ------------------------------------------------------------
-- Support tickets & enquiries
--
-- One unified inbox: contact form, email, WhatsApp and Instagram DMs
-- all land here. A contact-form submission is just a ticket with the
-- guest_* fields filled.
-- ------------------------------------------------------------

create table support_tickets (
  id                 uuid primary key default gen_random_uuid(),
  ticket_number      text not null unique,     -- 'TKT-2026-00042', see next_ticket_number()
  customer_id        uuid references customers(id) on delete set null,
  order_id           uuid references orders(id) on delete set null,
  channel            text not null default 'web'
                     check (channel in ('web', 'email', 'whatsapp', 'phone', 'instagram')),
  category           text not null default 'general'
                     check (category in ('order_issue', 'payment', 'shipping',
                                         'product_question', 'return_refund',
                                         'complaint', 'general')),
  subject            text not null,
  status             text not null default 'open'
                     check (status in ('open', 'pending_customer',
                                       'pending_internal', 'resolved', 'closed')),
  priority           text not null default 'normal'
                     check (priority in ('low', 'normal', 'high', 'urgent')),
  assigned_to        uuid references staff_users(id) on delete set null,
  guest_name         text,                     -- for enquiries without an account
  guest_email        citext,
  guest_phone        text,
  first_response_at  timestamptz,              -- SLA: time-to-first-reply
  resolved_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint tickets_requester_present
    check (customer_id is not null or guest_email is not null or guest_phone is not null)
);

-- The conversation thread. is_internal = true rows are staff-only
-- notes the customer never sees.
create table ticket_messages (
  id           uuid primary key default gen_random_uuid(),
  ticket_id    uuid not null references support_tickets(id) on delete cascade,
  sender_type  text not null check (sender_type in ('customer', 'staff', 'system')),
  sender_id    uuid,                           -- customers.id or staff_users.id
  body         text not null,
  is_internal  boolean not null default false,
  attachments  jsonb not null default '[]'::jsonb,  -- [{"url":"...","name":"..."}]
  created_at   timestamptz not null default now(),

  -- A customer-authored internal note is a contradiction: internal
  -- notes are staff-only by definition.
  constraint ticket_messages_internal_is_staff
    check (is_internal = false or sender_type = 'staff')
);

-- Structured product / bulk / quote enquiries ("price for 50 units?").
-- Kept separate from tickets because these are sales leads, not
-- problems -- converted_order_id closes the loop and gives you an
-- enquiry -> order conversion rate.
create table product_enquiries (
  id                  uuid primary key default gen_random_uuid(),
  product_id          uuid references products(id) on delete set null,
  variant_id          uuid references product_variants(id) on delete set null,
  customer_id         uuid references customers(id) on delete set null,
  guest_name          text,
  guest_email         citext,
  guest_phone         text,
  quantity            int check (quantity is null or quantity > 0),
  message             text not null,
  status              text not null default 'new'
                      check (status in ('new', 'replied', 'quoted', 'converted', 'closed')),
  assigned_to         uuid references staff_users(id) on delete set null,
  converted_order_id  uuid references orders(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint enquiries_requester_present
    check (customer_id is not null or guest_email is not null or guest_phone is not null),
  constraint enquiries_converted_has_order
    check (status <> 'converted' or converted_order_id is not null)
);

-- ------------------------------------------------------------
-- Audit log
--
-- Populated by audit_row(), attached in the triggers migration to
-- the tables where "who changed this and when" is a question you
-- will eventually have to answer under pressure.
-- ------------------------------------------------------------

create table audit_logs (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid references staff_users(id) on delete set null,
  actor_uid   uuid,                              -- raw auth.uid() at the time
  action      text not null,                     -- 'insert', 'update', 'delete'
  table_name  text not null,
  record_id   uuid,
  changes     jsonb,                             -- {"price": {"old": 999, "new": 899}}
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Store settings (single-row config, read by storefront + admin)
-- ------------------------------------------------------------

create table store_settings (
  id                   int primary key default 1 check (id = 1),
  store_name           text not null default 'My Store',
  support_email        citext,
  support_phone        text,
  seller_gstin         text,
  seller_state_code    text check (seller_state_code is null
                                   or seller_state_code ~ '^[0-9]{2}$'),
  free_shipping_above  numeric(12,2),
  flat_shipping_rate   numeric(12,2) default 0,
  cod_enabled          boolean not null default true,
  config               jsonb not null default '{}'::jsonb,
  updated_at           timestamptz not null default now()
);

comment on column store_settings.config is
  'NON-SECRET configuration only. Do not put gateway API keys, webhook '
  'secrets or SMTP credentials here: every active staff member can read this '
  'table under the current blanket policy, and it lands in every backup and '
  'every logical replica in plaintext. Use Supabase Vault or the deployment '
  'environment instead.';

insert into store_settings (id) values (1);

-- Note: free_shipping_above / flat_shipping_rate act as the fallback
-- when no shipping_rates row matches the pincode's zone.

-- ------------------------------------------------------------
-- Platform plumbing
--
-- Neither of these existed before, and between them they cover the
-- two ways money goes wrong at the edges: the client retrying a
-- request, and the provider retrying a callback.
-- ------------------------------------------------------------

-- Client-side retry protection. A shopper double-tapping "Pay", or a
-- mobile network replaying a POST, must not create a second order.
-- The handler claims a key, does the work, and stores the response;
-- a replay returns the stored response instead of re-executing.
create table idempotency_keys (
  key             text primary key,
  scope           text not null,               -- 'checkout', 'refund', 'gift_card_redeem'
  -- Detects the dangerous case: same key, different body. That is a
  -- client bug, and replaying the first response would hide it.
  request_hash    text not null,
  customer_id     uuid references customers(id) on delete set null,
  response_status int,
  response_body   jsonb,
  locked_at       timestamptz,                 -- set while in flight
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '24 hours'
);

-- Provider-side replay protection and a durable record of what was
-- received. Gateways retry until they get a 2xx, and they are not
-- always careful about it.
create table webhook_events (
  id                  uuid primary key default gen_random_uuid(),
  provider            text not null,           -- 'razorpay', 'delhivery', 'resend'
  event_id            text not null,           -- provider's own id for this delivery
  event_type          text,
  payload             jsonb not null,
  signature_verified  boolean not null default false,
  received_at         timestamptz not null default now(),
  processed_at        timestamptz,
  attempts            int not null default 0 check (attempts >= 0),
  error               text,

  unique (provider, event_id)
);

comment on table webhook_events is
  'Insert BEFORE acting on a callback. The unique (provider, event_id) is '
  'what makes a replayed delivery a no-op rather than a second capture.';



-- ============================================================
-- SOURCE: 20260801000800_triggers.sql
-- ============================================================

-- ============================================================
-- 0008  Functions & triggers: the schema's invariants
--
-- Everything here is enforced in the database rather than the
-- application, because these are the rules that cost money when
-- they are broken and because more than one client will eventually
-- write to these tables.
-- ============================================================


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



-- ============================================================
-- SOURCE: 20260801000900_indexes.sql
-- ============================================================

-- ============================================================
-- 0009  Indexes
--
-- Postgres does NOT index foreign keys automatically. Of the 78 FK
-- columns in the original schema, 47 had no index. That costs twice:
-- joins scan, and every ON DELETE SET NULL / CASCADE has to scan the
-- child table to find the rows it must touch.
--
-- Unique indexes that enforce a business rule live next to their
-- table (uniq_default_variant, uniq_payment_provider_ref, and so on).
-- This migration is purely about access paths.
-- ============================================================


-- ------------------------------------------------------------
-- Catalog
-- ------------------------------------------------------------

create index idx_categories_parent on categories(parent_id);

-- The primary storefront listing query. Had no index at all.
create index idx_products_category on products(category_id);

-- RLS forces `status = 'active'` onto EVERY storefront product read,
-- so the predicate belongs in the index rather than being re-checked
-- per row.
create index idx_products_active on products(category_id, created_at desc)
  where status = 'active';

create index idx_variants_product on product_variants(product_id);
create index idx_variants_purchasable on product_variants(product_id)
  where is_purchasable;
create index idx_variants_low_stock on product_variants(stock)
  where status = 'active' and stock <= low_stock_threshold;
create index idx_variants_barcode on product_variants(barcode)
  where barcode is not null;

create index idx_option_values_product on product_option_values(product_id);
create index idx_vov_option_value on variant_option_values(option_value_id);
create index idx_images_product on product_images(product_id, position);
create index idx_images_variant on product_images(variant_id)
  where variant_id is not null;

create index idx_collection_products_product on collection_products(product_id);
create index idx_product_relations_related on product_relations(related_product_id);

-- Fuzzy search. Turns "iphone chrger" into "iPhone charger" with a
-- plain `where name % $1`, no external search infrastructure.
create index idx_products_name_trgm on products using gin (name gin_trgm_ops);
create index idx_products_brand_trgm on products using gin (brand gin_trgm_ops);
create index idx_variants_sku_trgm on product_variants using gin (sku gin_trgm_ops);

-- ------------------------------------------------------------
-- Identity
-- ------------------------------------------------------------

create index idx_addresses_customer on addresses(customer_id);
create index idx_customers_created on customers(created_at desc);

-- ------------------------------------------------------------
-- Orders
-- ------------------------------------------------------------

create index idx_orders_customer on orders(customer_id, placed_at desc);

-- Every admin queue and every date-range report. Both were seq scans.
create index idx_orders_placed on orders(placed_at desc);
create index idx_orders_open on orders(status, placed_at desc)
  where status in ('pending', 'paid', 'packed', 'shipped');
create index idx_orders_updated on orders(updated_at desc);
create index idx_orders_email on orders(email);

create index idx_order_items_order on order_items(order_id);
-- Needed by ON DELETE SET NULL when a variant is archived, and by
-- "units sold per variant" reporting.
create index idx_order_items_variant on order_items(variant_id);

-- The order detail page joins payments on every load.
create index idx_payments_order on payments(order_id);
create index idx_payments_pending on payments(created_at)
  where status in ('created', 'authorized');

create index idx_order_events_order on order_events(order_id, created_at);

-- ------------------------------------------------------------
-- Cart
-- ------------------------------------------------------------

create index idx_carts_session on carts(session_id) where session_id is not null;
create index idx_carts_customer on carts(customer_id) where customer_id is not null;
-- Drives abandoned-cart recovery and the retention sweep.
create index idx_carts_abandoned on carts(updated_at)
  where status = 'active';
create index idx_cart_items_variant on cart_items(variant_id);

-- ------------------------------------------------------------
-- Inventory & fulfilment
-- ------------------------------------------------------------

create index idx_inventory_variant on inventory_movements(variant_id, created_at desc);
create index idx_inventory_order on inventory_movements(order_id)
  where order_id is not null;
create index idx_inventory_created_by on inventory_movements(created_by);
-- The reservation sweeper: find holds that expired without a release.
create index idx_inventory_expiring on inventory_movements(expires_at)
  where reason = 'reservation' and expires_at is not null;

create index idx_shipments_order on shipments(order_id);
create index idx_shipments_active on shipments(status, created_at desc)
  where status not in ('delivered', 'lost');
create index idx_shipment_items_order_item on shipment_items(order_item_id);

-- ------------------------------------------------------------
-- Returns, refunds, discounts
-- ------------------------------------------------------------

create index idx_returns_order on return_requests(order_id);
create index idx_returns_customer on return_requests(customer_id);
create index idx_returns_open on return_requests(status, created_at)
  where status in ('requested', 'approved', 'pickup_scheduled', 'received');
create index idx_return_items_order_item on return_items(order_item_id);

create index idx_refunds_order on refunds(order_id);
create index idx_refunds_payment on refunds(payment_id);
create index idx_refunds_return on refunds(return_id);

create index idx_discounts_collection on discounts(collection_id);
create index idx_discounts_product on discounts(product_id);
create index idx_discounts_live on discounts(code)
  where is_active;

create index idx_redemptions_order on discount_redemptions(order_id);
-- Checked on every checkout that carries a coupon, to enforce
-- max_uses_per_customer.
create index idx_redemptions_customer on discount_redemptions(discount_id, customer_id);

-- ------------------------------------------------------------
-- Invoicing
-- ------------------------------------------------------------

create index idx_invoices_order on invoices(order_id);
create index idx_invoices_parent on invoices(parent_invoice_id);
create index idx_invoices_issued on invoices(issued_at desc);
-- The e-invoice worker's queue.
create index idx_invoices_unsigned on invoices(issued_at)
  where irn is null and kind = 'tax_invoice';
create index idx_invoice_lines_invoice on invoice_lines(invoice_id);

-- ------------------------------------------------------------
-- Wallet
-- ------------------------------------------------------------

-- balance = sum(delta) per card was a full table scan without this.
create index idx_gift_card_txn_card on gift_card_transactions(gift_card_id, created_at desc);
create index idx_gift_card_txn_order on gift_card_transactions(order_id);
-- Backs the own_gift_cards RLS policy.
create index idx_gift_cards_purchaser on gift_cards(purchaser_id);
create index idx_gift_cards_purchase_order on gift_cards(purchase_order_id);
create index idx_gift_cards_expiring on gift_cards(expires_at)
  where status = 'active' and expires_at is not null;

create index idx_credit_customer on credit_ledger(customer_id, created_at desc);
create index idx_credit_order on credit_ledger(order_id);
create index idx_credit_return on credit_ledger(return_id);
create index idx_credit_gift_card on credit_ledger(gift_card_id);
create index idx_credit_expiring on credit_ledger(expires_at)
  where expires_at is not null;

-- ------------------------------------------------------------
-- Shipping & risk
-- ------------------------------------------------------------

create index idx_pincodes_zone on serviceable_pincodes(zone_id);
create index idx_rates_zone on shipping_rates(zone_id) where is_active;
create index idx_blocklist_lookup on blocklist(kind, value);

-- ------------------------------------------------------------
-- Engagement
-- ------------------------------------------------------------

create index idx_reviews_product on reviews(product_id, created_at desc)
  where status = 'approved';
create index idx_reviews_moderation on reviews(created_at)
  where status = 'pending';
create index idx_reviews_variant on reviews(variant_id);
create index idx_reviews_order_item on reviews(order_item_id);

-- The price-drop join the README advertises. wishlist_items' PK
-- leads with customer_id, so going the other way (variant -> who
-- wants it) had no index at all.
create index idx_wishlist_variant on wishlist_items(variant_id);

create index idx_stock_alerts_pending on stock_alerts(variant_id)
  where notified_at is null;
create index idx_stock_alerts_customer on stock_alerts(customer_id);

create index idx_price_history_variant on price_history(variant_id, created_at desc);
create index idx_price_history_changed_by on price_history(changed_by);

-- ------------------------------------------------------------
-- Messaging
-- ------------------------------------------------------------

create index idx_notifications_unread
  on notifications(recipient_type, recipient_id, created_at desc)
  where read_at is null;
create index idx_notifications_all
  on notifications(recipient_type, recipient_id, created_at desc);

-- The outbox drain.
create index idx_message_log_queued on message_log(created_at) where status = 'queued';
create index idx_message_log_order on message_log(order_id);
create index idx_message_log_customer on message_log(customer_id, created_at desc);

-- ------------------------------------------------------------
-- Support
-- ------------------------------------------------------------

create index idx_tickets_queue on support_tickets(priority, created_at)
  where status in ('open', 'pending_internal');
create index idx_tickets_customer on support_tickets(customer_id);
create index idx_tickets_order on support_tickets(order_id);
-- "My assigned tickets" is the first screen every agent opens.
create index idx_tickets_assigned on support_tickets(assigned_to, status)
  where assigned_to is not null;
create index idx_ticket_messages_thread on ticket_messages(ticket_id, created_at);

create index idx_enquiries_open on product_enquiries(status, created_at)
  where status in ('new', 'replied', 'quoted');
create index idx_enquiries_product on product_enquiries(product_id);
create index idx_enquiries_variant on product_enquiries(variant_id);
create index idx_enquiries_customer on product_enquiries(customer_id);
create index idx_enquiries_assigned on product_enquiries(assigned_to);
create index idx_enquiries_converted on product_enquiries(converted_order_id);

-- ------------------------------------------------------------
-- Audit & platform
-- ------------------------------------------------------------

create index idx_audit_record on audit_logs(table_name, record_id, created_at desc);
create index idx_audit_staff on audit_logs(staff_id, created_at desc);
create index idx_audit_created on audit_logs(created_at desc);

create index idx_idempotency_expiry on idempotency_keys(expires_at);
create index idx_idempotency_customer on idempotency_keys(customer_id);

-- The webhook retry queue.
create index idx_webhook_unprocessed on webhook_events(provider, received_at)
  where processed_at is null;



-- ============================================================
-- SOURCE: 20260801001000_views_rls_grants.sql
-- ============================================================

-- ============================================================
-- 0010  Views, Row Level Security, and grants
--
-- Assumptions (the standard Supabase wiring):
--   * customers.id   = auth.users.id for shoppers
--   * staff_users.id = auth.users.id for staff
--   * Server-side code (route handlers, edge functions, workers,
--     webhooks) uses the SERVICE KEY, which bypasses RLS.
--
-- These policies define what BROWSERS may do with the anon and
-- authenticated keys. Deny by default.
--
-- Server-side only, deliberately: order creation and payment
-- capture, invoice issuing, coupon validation, gift-card redemption
-- by code, guest contact forms, and anything touching staff tables.
--
-- ------------------------------------------------------------
-- THE RULE THIS FILE NOW FOLLOWS
--
-- An INSERT policy must constrain STATE, not just OWNERSHIP.
--
-- The previous version checked only "is this row mine?", and
-- PostgREST lets a client set every column it has been granted. So
-- a customer could insert a review with status='approved' and
-- is_verified=true and publish it straight to the storefront; file a
-- return already marked 'refunded'; or open every ticket at
-- priority='urgent'. Each policy below pins the columns a client has
-- no business choosing.
-- ============================================================


-- ------------------------------------------------------------
-- Helper: is the current user an active staff member?
--
-- SECURITY DEFINER so it can read staff_users even though that table
-- is locked down, which also avoids the policy recursion you would
-- otherwise get on staff_users itself.
--
-- search_path pins pg_temp LAST. With `set search_path = public`
-- alone, Postgres searches the temp schema first for relations, so
-- any user able to create a temp table could define pg_temp.
-- staff_users, have this function read it, and make themselves
-- staff. That is a real privilege escalation, and it is what the
-- Supabase linter's function_search_path_mutable rule is about.
-- ------------------------------------------------------------

create or replace function is_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from staff_users s
    where s.id = auth.uid() and s.is_active
  )
$$;

revoke execute on function is_staff() from public;
grant execute on function is_staff() to anon, authenticated;

-- ------------------------------------------------------------
-- 1. Deny by default: RLS on every table, forced.
--
-- FORCE matters. Without it the table owner bypasses RLS entirely,
-- so any migration, job or admin script connecting as the owner
-- silently runs with no policies applied.
-- ------------------------------------------------------------

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 2. Staff blanket.
--
-- ACCEPTED RISK, chosen deliberately: every active staff member gets
-- full access to every table, regardless of staff_users.role. A
-- warehouse packer's JWT can therefore read cost_price, all customer
-- PII, and store_settings, and can write to any table, by calling
-- PostgREST directly -- whatever the admin UI chooses to show.
--
-- The database draws the staff / non-staff line only. Per-role
-- enforcement is an application concern until this is replaced with
-- a role matrix. Two mitigations are already in place: append-only
-- triggers apply to staff too, and audit_row() records who changed
-- what on the sensitive tables.
-- ------------------------------------------------------------

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public'
  loop
    execute format(
      'create policy staff_all on public.%I for all
         to authenticated
         using (is_staff()) with check (is_staff())', t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 3. Column hiding via definer views.
--
-- RLS hides ROWS, not COLUMNS. product_variants carries cost_price
-- and store_settings carries seller GSTIN and config, so those
-- tables get no public policy at all -- the storefront reads these
-- views, which project only the safe columns.
--
-- security_invoker = false means the view runs as its owner and
-- bypasses the base table's RLS. That is the point, and it is also
-- why the WHERE clause here is load-bearing.
-- ------------------------------------------------------------

-- The join to products is the fix for a real leak. The previous
-- version filtered on the VARIANT's status only, so every variant of
-- every 'draft' and 'archived' PRODUCT -- SKU, title, specs, price --
-- was readable by anon with a single unfiltered select.
create or replace view storefront_variants
with (security_invoker = false) as
  select v.id, v.product_id, v.sku, v.title, v.description, v.specs,
         v.price, v.compare_at_price, v.currency, v.stock,
         v.weight_grams, v.is_default, v.status, v.is_purchasable,
         v.created_at
  from product_variants v
  join products p on p.id = v.product_id
  where v.status = 'active'
    and p.status = 'active';

create or replace view public_settings
with (security_invoker = false) as
  select store_name, support_email, support_phone,
         free_shipping_above, flat_shipping_rate, cod_enabled
  from store_settings;

-- Store credit balance without exposing the ledger's internals.
create or replace view customer_credit_balances
with (security_invoker = true) as
  select customer_id, sum(delta) as balance
  from credit_ledger
  where expires_at is null or expires_at > now()
  group by customer_id;

-- ------------------------------------------------------------
-- 4. Public catalog (anon + logged-in, read only)
-- ------------------------------------------------------------

create policy public_read on categories            for select using (true);
create policy public_read on collections           for select using (is_active);
create policy public_read on collection_products   for select using (true);
create policy public_read on products              for select using (status = 'active');
create policy public_read on product_options       for select using (true);
create policy public_read on product_option_values for select using (true);
create policy public_read on variant_option_values for select using (true);
create policy public_read on product_images        for select using (true);
create policy public_read on product_relations     for select using (true);
create policy public_read on shipping_zones        for select using (true);
create policy public_read on serviceable_pincodes  for select using (true);
create policy public_read on shipping_rates        for select using (is_active);
create policy public_read on reviews               for select using (status = 'approved');

-- ------------------------------------------------------------
-- 5. Customers and their own data
-- ------------------------------------------------------------

create policy own_profile_r on customers for select
  using (id = (select auth.uid()));
create policy own_profile_i on customers for insert
  with check (id = (select auth.uid()));
-- anonymized_at is set only by anonymize_customer(); a client that
-- could set it would be able to fake its own erasure record.
create policy own_profile_u on customers for update
  using (id = (select auth.uid()) and anonymized_at is null)
  with check (id = (select auth.uid()) and anonymized_at is null);

create policy own_addresses on addresses for all
  using (customer_id = (select auth.uid()))
  with check (customer_id = (select auth.uid()));

create policy own_wishlist on wishlist_items for all
  using (customer_id = (select auth.uid()))
  with check (customer_id = (select auth.uid()));

create policy own_prefs on communication_preferences for all
  using (customer_id = (select auth.uid()))
  with check (customer_id = (select auth.uid()));

-- Logged-in carts. Guest carts (customer_id null + session_id)
-- cannot be safely expressed in RLS -- there is no trustworthy
-- session identity in a JWT-less request -- so keep guest carts
-- client-side until login, or manage them through server routes.
create policy own_carts on carts for all
  using (customer_id = (select auth.uid()))
  with check (customer_id = (select auth.uid()));

create policy own_cart_items on cart_items for all
  using (exists (select 1 from carts c
                 where c.id = cart_id and c.customer_id = (select auth.uid())))
  with check (exists (select 1 from carts c
                      where c.id = cart_id and c.customer_id = (select auth.uid())));

-- ------------------------------------------------------------
-- 6. Orders: customers READ their own; only the server writes.
-- Order creation snapshots prices and moves stock -- that math is
-- never trusted to a browser.
-- ------------------------------------------------------------

create policy own_orders on orders for select
  using (customer_id = (select auth.uid()));

create policy own_order_items on order_items for select
  using (exists (select 1 from orders o
                 where o.id = order_id and o.customer_id = (select auth.uid())));

create policy own_payments on payments for select
  using (exists (select 1 from orders o
                 where o.id = order_id and o.customer_id = (select auth.uid())));

create policy own_shipments on shipments for select
  using (exists (select 1 from orders o
                 where o.id = order_id and o.customer_id = (select auth.uid())));

create policy own_shipment_items on shipment_items for select
  using (exists (select 1 from orders o
                 where o.id = order_id and o.customer_id = (select auth.uid())));

create policy own_order_events on order_events for select
  using (exists (select 1 from orders o
                 where o.id = order_id and o.customer_id = (select auth.uid())));

create policy own_invoices on invoices for select
  using (exists (select 1 from orders o
                 where o.id = order_id and o.customer_id = (select auth.uid())));

create policy own_invoice_lines on invoice_lines for select
  using (exists (select 1 from invoices i
                 join orders o on o.id = i.order_id
                 where i.id = invoice_id and o.customer_id = (select auth.uid())));

create policy own_refunds on refunds for select
  using (exists (select 1 from orders o
                 where o.id = order_id and o.customer_id = (select auth.uid())));

create policy own_redemptions on discount_redemptions for select
  using (customer_id = (select auth.uid()));

-- ------------------------------------------------------------
-- 7. Returns: customers may raise and watch their own.
--
-- status and resolution are pinned. Previously a customer could
-- insert a return already marked 'refunded' with resolution
-- 'refund', which is a state only the warehouse should be able to
-- reach, and which downstream ops tooling reads as authoritative.
--
-- return_items no longer needs an ownership subquery: its composite
-- FK to (order_item_id, order_id) makes attaching another order's
-- line item impossible at the schema level.
-- ------------------------------------------------------------

create policy own_returns_r on return_requests for select
  using (customer_id = (select auth.uid()));

create policy own_returns_i on return_requests for insert
  with check (
    customer_id = (select auth.uid())
    and status = 'requested'
    and resolution is null
    and resolved_at is null
    and exists (select 1 from orders o
                where o.id = order_id and o.customer_id = (select auth.uid()))
  );

create policy own_return_items_r on return_items for select
  using (exists (select 1 from return_requests r
                 where r.id = return_id and r.customer_id = (select auth.uid())));

create policy own_return_items_i on return_items for insert
  with check (
    condition is null          -- assessed at the warehouse, not claimed by the customer
    and exists (select 1 from return_requests r
                where r.id = return_id
                  and r.customer_id = (select auth.uid())
                  and r.status = 'requested')
  );

-- ------------------------------------------------------------
-- 8. Reviews: write your own; edit only while pending.
--
-- status is pinned to 'pending' on INSERT. Without that a customer
-- could self-approve straight onto the product page. is_verified is
-- a generated column so it cannot be set at all, and
-- validate_review_purchase() checks the order item really is theirs.
-- ------------------------------------------------------------

create policy own_reviews_r on reviews for select
  using (customer_id = (select auth.uid()));

create policy own_reviews_i on reviews for insert
  with check (customer_id = (select auth.uid()) and status = 'pending');

create policy own_reviews_u on reviews for update
  using (customer_id = (select auth.uid()) and status = 'pending')
  with check (customer_id = (select auth.uid()) and status = 'pending');

-- ------------------------------------------------------------
-- 9. Wallet, gift cards, alerts, notifications
-- ------------------------------------------------------------

create policy own_credit on credit_ledger for select
  using (customer_id = (select auth.uid()));

-- Customers see the cards THEY bought. Redemption by code is a
-- server-side lookup against code_hash: a table read here would let
-- someone enumerate other people's cards.
create policy own_gift_cards on gift_cards for select
  using (purchaser_id = (select auth.uid()));

create policy own_alerts_r on stock_alerts for select
  using (customer_id = (select auth.uid()));

-- notified_at is pinned null so a client cannot pre-mark its own
-- alert as sent. The unique indexes on stock_alerts cap fan-out to
-- one pending alert per address per variant; rate limiting the
-- anonymous branch is still the application's job.
create policy alerts_insert on stock_alerts for insert
  with check (
    notified_at is null
    and (
      customer_id = (select auth.uid())
      or ((select auth.uid()) is null and customer_id is null and email is not null)
    )
  );

create policy own_notifications_r on notifications for select
  using (recipient_type = 'customer' and recipient_id = (select auth.uid()));

-- Marking as read is the only legitimate customer write. The old
-- policy allowed rewriting title, body, kind and data as well.
create policy own_notifications_u on notifications for update
  using (recipient_type = 'customer' and recipient_id = (select auth.uid()))
  with check (
    recipient_type = 'customer'
    and recipient_id = (select auth.uid())
    and read_at is not null
  );

-- ------------------------------------------------------------
-- 10. Support tickets & enquiries
--
-- priority, status, assignment and the SLA timestamps are pinned.
-- Previously every customer could open tickets at priority
-- 'urgent', pre-set resolved_at, and assign work to a staff member.
-- ------------------------------------------------------------

create policy own_tickets_r on support_tickets for select
  using (customer_id = (select auth.uid()));

create policy own_tickets_i on support_tickets for insert
  with check (
    customer_id = (select auth.uid())
    and status = 'open'
    and priority = 'normal'
    and assigned_to is null
    and first_response_at is null
    and resolved_at is null
    -- Attaching someone else's order to your ticket would put their
    -- order id in front of an agent as if it were yours.
    and (order_id is null
         or exists (select 1 from orders o
                    where o.id = order_id and o.customer_id = (select auth.uid())))
  );

-- Internal notes stay internal: the is_internal = false filter is
-- what keeps staff-only remarks out of customer eyes.
create policy own_ticket_msgs_r on ticket_messages for select
  using (is_internal = false
    and exists (select 1 from support_tickets t
                where t.id = ticket_id and t.customer_id = (select auth.uid())));

create policy own_ticket_msgs_i on ticket_messages for insert
  with check (sender_type = 'customer'
    and sender_id = (select auth.uid())
    and is_internal = false
    and exists (select 1 from support_tickets t
                where t.id = ticket_id and t.customer_id = (select auth.uid())));

create policy own_enquiries_r on product_enquiries for select
  using (customer_id = (select auth.uid()));

create policy enquiries_insert on product_enquiries for insert
  with check (
    status = 'new'
    and assigned_to is null
    and converted_order_id is null
    and (
      customer_id = (select auth.uid())
      or ((select auth.uid()) is null
          and customer_id is null
          and (guest_email is not null or guest_phone is not null))
    )
  );

-- ------------------------------------------------------------
-- 11. Grants
--
-- Supabase's default privileges already grant anon/authenticated on
-- new public tables, so RLS is the real gate. The views are the
-- exception: they need explicit grants, and they must NOT be
-- readable through their base tables.
-- ------------------------------------------------------------

grant select on storefront_variants to anon, authenticated;
grant select on public_settings to anon, authenticated;
grant select on customer_credit_balances to authenticated;

-- ------------------------------------------------------------
-- Deliberately NOT public
-- ------------------------------------------------------------
-- discounts:            a public read lets anyone enumerate live
--                       coupon codes. Validate in a server route and
--                       return only the outcome.
-- product_variants:     staff-only; the storefront reads
--                       storefront_variants, which hides cost_price.
-- store_settings:       staff-only; storefront reads public_settings.
-- gift_card_transactions, credit_ledger writes, inventory_movements,
-- price_history, message_log, audit_logs, blocklist, staff_users,
-- invoice_sequences, idempotency_keys, webhook_events:
--                       staff or server only.
--
-- Every table without a policy above stays locked. That is the point
-- of enabling RLS everywhere: deny by default.



-- ============================================================
-- SOURCE: 20260801001100_auth_signup.sql
-- ============================================================

-- ============================================================
-- 0011  Signup: auth.users -> customers
--
-- Supabase Auth creates auth.users. Nothing created the matching
-- customers row, which meant a shopper could register successfully
-- and then discover they could not read their own orders --
-- `id = auth.uid()` matched nothing, so every policy denied them.
-- The symptom looks like broken API keys rather than a missing row,
-- which is why this belongs in the schema rather than in a setup
-- checklist someone might skip.
--
-- Guarded, like the identity FKs in 0003, so the same migration set
-- still applies to a vanilla Postgres where auth.users is absent.
-- ============================================================


do $$
begin
  if to_regclass('auth.users') is null then
    raise notice
      'auth.users not found -- skipping signup trigger. Expected on vanilla Postgres; NOT expected on Supabase.';
    return;
  end if;

  -- SECURITY DEFINER: the trigger fires as whichever role GoTrue is
  -- using, which has no rights on public.customers. search_path pins
  -- pg_temp LAST so the definer context cannot be hijacked by a
  -- shadowing temp table.
  create or replace function handle_new_user()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $fn$
  begin
    insert into customers (id, email, phone, full_name)
    values (
      new.id,
      nullif(new.email, ''),
      -- auth.users.phone is stored WITHOUT a leading '+'
      -- ('919876543210'), while customers.phone carries an E.164
      -- CHECK. Passing it through unchanged fails every phone
      -- signup, and the error surfaces inside GoTrue rather than in
      -- your application logs.
      case
        when new.phone is null or new.phone = '' then null
        when new.phone like '+%'                 then new.phone
        else '+' || new.phone
      end,
      new.raw_user_meta_data ->> 'full_name'
    )
    on conflict (id) do nothing;

    -- Consent defaults: transactional ON, marketing OFF. Creating the
    -- row here means "has this person opted in?" is always a lookup
    -- rather than a lookup plus a null check.
    insert into communication_preferences (customer_id)
    values (new.id)
    on conflict (customer_id) do nothing;

    return new;
  end $fn$;

  -- ON CONFLICT DO NOTHING above makes this safe to re-run, and safe
  -- when the application also creates the customer row itself.
  --
  -- Staff who sign up get a customers row too. That is intentional:
  -- the two tables are separate roles for one person, and someone
  -- who works at the shop may also buy from it.
  drop trigger if exists on_auth_user_created on auth.users;
  create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function handle_new_user();
end $$;



commit;
