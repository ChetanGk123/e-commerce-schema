-- ============================================================
-- E-commerce schema -- the squashed baseline
--
-- THIS FILE IS THE SOURCE OF TRUTH. It is not generated; dist/schema.sql
-- is generated FROM it by `make bundle`.
--
-- It was squashed on 2026-08-20 from the 25 migrations that came before,
-- which is the same thing the previous baseline was: this repo keeps one
-- squashed baseline and adds changes as new migrations beside it. Every
-- original is still in git history if you need to read one on its own.
--
-- CHANGING AN EXISTING DATABASE? Add a new migration beside this file.
-- This one only knows how to create things, never how to alter them, so
-- editing it changes what a FRESH install gets and nothing else -- every
-- database already built from it stays exactly as it was, silently.
--
-- The `-- SOURCE:` headers below are kept deliberately. Docs and code
-- comments cite migration filenames (apps/api/src/routes/auth.ts names
-- 20260801002800_signin_lockout.sql, for one), and those references still
-- lead somewhere because the names are searchable in here.
--
-- One transaction, top to bottom. If any statement fails, nothing is
-- created -- you get the complete schema or an untouched database.
--
-- Afterwards, two optional extras:
--   psql "$DATABASE_URL" -f supabase/jobs/retention.sql   (schedulers)
--   psql "$DATABASE_URL" -f supabase/seed.sql             (demo data)
-- ============================================================

begin;


-- ============================================================
-- SOURCE: 20260801000000_baseline.sql
-- ============================================================

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





-- ============================================================
-- SOURCE: 20260801001200_admin_rpc.sql
-- ============================================================

-- ============================================================
-- 0012  Admin RPCs
--
-- Operations that must be atomic and cannot be, from the client.
-- supabase-js has no transactions: it issues one PostgREST request per
-- call, so a five-statement sequence is five transactions and any
-- failure leaves the middle of it committed. Money and stock cannot be
-- run that way, so those sequences live here as single calls.
--
-- EVERY function below is SECURITY DEFINER, which bypasses RLS. That
-- makes the is_staff() guard load-bearing rather than decorative: these
-- are granted to `authenticated`, so without it any signed-in shopper
-- could cancel orders and issue invoices. The guard is the first
-- statement in every one.
--
-- search_path pins pg_temp LAST for the reason the base schema already
-- documents: with `set search_path = public` alone Postgres searches
-- the temp schema first, so anyone able to create a temp table could
-- shadow a table these functions read.
-- ============================================================


-- ------------------------------------------------------------
-- Shared guard
-- ------------------------------------------------------------

create or replace function require_staff()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare uid uuid;
begin
  uid := auth.uid();
  if uid is null or not is_staff() then
    -- 42501 = insufficient_privilege. PostgREST maps it to 403.
    raise exception 'staff access required' using errcode = '42501';
  end if;
  return uid;
end $$;

revoke execute on function require_staff() from public;
grant execute on function require_staff() to authenticated;

-- ------------------------------------------------------------
-- 1. Capture a COD payment
--
-- Converts the reservation into a sale. Two ledger rows, not one: the
-- reservation already took the stock down, and the ledger has to stay
-- honest about what happened rather than quietly rewriting history.
-- ------------------------------------------------------------

create or replace function admin_capture_cod(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := require_staff();
  o   orders%rowtype;
  res record;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'P0002';
  end if;
  if o.status <> 'pending' then
    raise exception 'order % is %, not pending', o.order_number, o.status
      using errcode = '55000';
  end if;

  -- Consume every outstanding reservation for this order. The unique
  -- index on reservation_id makes a double release impossible, so a
  -- retry of this function cannot invent stock.
  for res in
    select m.id, m.variant_id, m.quantity
    from inventory_movements m
    where m.order_id = p_order_id
      and m.reason = 'reservation'
      and not exists (
        select 1 from inventory_movements c where c.reservation_id = m.id)
  loop
    insert into inventory_movements (variant_id, quantity, reason, order_id, reservation_id)
    values (res.variant_id, -res.quantity, 'release', p_order_id, res.id);

    insert into inventory_movements (variant_id, quantity, reason, order_id, created_by)
    values (res.variant_id, res.quantity, 'sale', p_order_id, uid);
  end loop;

  update payments set status = 'captured', updated_at = now()
  where order_id = p_order_id and provider = 'cod' and status <> 'captured';

  update orders set status = 'paid', updated_at = now() where id = p_order_id;

  insert into order_events (order_id, event, from_status, to_status, actor_type, actor_id)
  values (p_order_id, 'payment_captured', o.status, 'paid', 'staff', uid);
end $$;

-- ------------------------------------------------------------
-- 2. Cancel an order
--
-- Releases outstanding holds so the stock goes back on the shelf
-- immediately rather than waiting for the reservation sweeper.
-- ------------------------------------------------------------

create or replace function admin_cancel_order(p_order_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := require_staff();
  o   orders%rowtype;
  res record;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'P0002';
  end if;
  if o.status in ('shipped', 'delivered', 'refunded', 'cancelled') then
    raise exception 'order % is % and cannot be cancelled', o.order_number, o.status
      using errcode = '55000';
  end if;

  for res in
    select m.id, m.variant_id, m.quantity
    from inventory_movements m
    where m.order_id = p_order_id
      and m.reason = 'reservation'
      and not exists (
        select 1 from inventory_movements c where c.reservation_id = m.id)
  loop
    insert into inventory_movements (variant_id, quantity, reason, order_id, reservation_id, created_by)
    values (res.variant_id, -res.quantity, 'release', p_order_id, res.id, uid);
  end loop;

  -- A paid order that already moved stock as 'sale' needs those units
  -- back too, or cancelling silently loses them.
  if o.status <> 'pending' then
    insert into inventory_movements (variant_id, quantity, reason, order_id, note, created_by)
    select m.variant_id, -sum(m.quantity), 'return', p_order_id,
           'cancelled order ' || o.order_number, uid
    from inventory_movements m
    where m.order_id = p_order_id and m.reason = 'sale'
    group by m.variant_id
    having sum(m.quantity) < 0;
  end if;

  update orders set status = 'cancelled', updated_at = now() where id = p_order_id;

  insert into order_events (order_id, event, from_status, to_status, note, actor_type, actor_id)
  values (p_order_id, 'status_changed', o.status, 'cancelled', p_reason, 'staff', uid);
end $$;

-- ------------------------------------------------------------
-- 3. Ship an order
--
-- p_items is [{"order_item_id": uuid, "quantity": int}, ...]. The
-- shipment-quantity trigger refuses the whole call if it would dispatch
-- more of a line than was ordered, counting across every box.
-- ------------------------------------------------------------

create or replace function admin_ship_order(
  p_order_id        uuid,
  p_items           jsonb,
  p_carrier         text default null,
  p_tracking_number text default null,
  p_tracking_url    text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := require_staff();
  o   orders%rowtype;
  sid uuid;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'P0002';
  end if;
  if o.status = 'pending' then
    raise exception 'order % is unpaid', o.order_number using errcode = '55000';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'p_items must be a non-empty array' using errcode = '22023';
  end if;

  insert into shipments (order_id, carrier, tracking_number, tracking_url, status, shipped_at)
  values (p_order_id, p_carrier, p_tracking_number, p_tracking_url, 'label_created', now())
  returning id into sid;

  insert into shipment_items (shipment_id, order_item_id, order_id, quantity)
  select sid, (e ->> 'order_item_id')::uuid, p_order_id, (e ->> 'quantity')::int
  from jsonb_array_elements(p_items) e;

  update orders set status = 'shipped', updated_at = now() where id = p_order_id;

  insert into order_events (order_id, event, from_status, to_status, actor_type, actor_id)
  values (p_order_id, 'shipment_created', o.status, 'shipped', 'staff', uid);

  return sid;
end $$;

-- ------------------------------------------------------------
-- 4. Issue a GST invoice
--
-- The number and the invoice MUST be created in the same transaction:
-- next_invoice_number() takes a row lock and a rollback takes the
-- number back with it. That is what makes numbering gap-free, which GST
-- requires and ordinary sequences cannot provide.
--
-- TWO ASSUMPTIONS, both stated because an accountant may need to
-- overrule them:
--
--   * place_of_supply is a PARAMETER. The order's address snapshot
--     stores a state NAME, and this schema has no state-name to
--     state-code table, so the caller resolves it. It defaults to the
--     seller's own state, which produces CGST+SGST.
--   * Shipping is invoiced as its own line at the highest GST rate
--     among the items (the composite-supply convention). Order-level
--     discount is apportioned across item lines by value.
-- ------------------------------------------------------------

create or replace function admin_issue_invoice(
  p_order_id        uuid,
  p_place_of_supply text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid        uuid := require_staff();
  o          orders%rowtype;
  s          store_settings%rowtype;
  pos        text;
  same_state boolean;
  inv_id     uuid;
  inv_no     text;
  max_rate   numeric(4,2);
  ship_base  numeric(12,2) := 0;
  ship_tax   numeric(12,2) := 0;
  v_lines    jsonb;
  tot        record;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'P0002';
  end if;
  if o.status = 'pending' then
    raise exception 'order % is unpaid', o.order_number using errcode = '55000';
  end if;

  if exists (select 1 from invoices where order_id = p_order_id and kind = 'tax_invoice') then
    raise exception 'order % already has a tax invoice', o.order_number
      using errcode = '23505';
  end if;

  select * into s from store_settings where id = 1;
  if s.seller_gstin is null then
    raise exception 'store_settings.seller_gstin is not set; invoicing cannot proceed'
      using errcode = '55000';
  end if;

  pos := coalesce(p_place_of_supply, s.seller_state_code);
  if pos is null then
    raise exception 'no place of supply and no seller_state_code' using errcode = '55000';
  end if;
  same_state := (pos = s.seller_state_code);

  -- Lines are computed BEFORE the invoice row exists. The obvious
  -- shape -- insert the invoice with zero totals, add lines, then
  -- update the totals -- is refused by protect_invoice(), and rightly:
  -- an invoice that can be updated after issue is not a legal document.
  -- So the arithmetic happens once, into jsonb, and both the header and
  -- the lines are written from it.
  --
  -- taxable_value carries each line's share of the order discount,
  -- because GST is due on what was actually charged.
  select jsonb_agg(jsonb_build_object(
           'description',   oi.product_name || coalesce(' / ' || oi.variant_title, ''),
           'hsn_code',      p.hsn_code,
           'quantity',      oi.quantity,
           'unit_price',    oi.unit_price,
           'taxable_value', net.taxable,
           'gst_rate',      coalesce(p.gst_rate, 0),
           'cgst_amount',   case when same_state then net.half else 0 end,
           'sgst_amount',   case when same_state then net.half else 0 end,
           'igst_amount',   case when same_state then 0 else net.full end,
           'line_total',    net.taxable
                            + case when same_state then 2 * net.half else net.full end))
    into v_lines
  from order_items oi
  left join product_variants v on v.id = oi.variant_id
  left join products p on p.id = v.product_id
  cross join lateral (
    select round(oi.line_total - (case when o.subtotal > 0
                                       then o.discount_total * oi.line_total / o.subtotal
                                       else 0 end), 2) as taxable
  ) base
  cross join lateral (
    select base.taxable,
           round(base.taxable * coalesce(p.gst_rate, 0) / 200, 2) as half,
           round(base.taxable * coalesce(p.gst_rate, 0) / 100, 2) as full
  ) net
  where oi.order_id = p_order_id;

  if v_lines is null then
    raise exception 'order % has no line items', o.order_number using errcode = '55000';
  end if;

  -- Shipping, at the highest item rate (composite supply).
  if o.shipping_total > 0 then
    select coalesce(max((e ->> 'gst_rate')::numeric), 0) into max_rate
    from jsonb_array_elements(v_lines) e;

    ship_base := o.shipping_total;
    ship_tax  := case when same_state then 2 * round(ship_base * max_rate / 200, 2)
                      else round(ship_base * max_rate / 100, 2) end;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'description',   'Shipping',
      'hsn_code',      null,
      'quantity',      1,
      'unit_price',    ship_base,
      'taxable_value', ship_base,
      'gst_rate',      max_rate,
      'cgst_amount',   case when same_state then round(ship_base * max_rate / 200, 2) else 0 end,
      'sgst_amount',   case when same_state then round(ship_base * max_rate / 200, 2) else 0 end,
      'igst_amount',   case when same_state then 0 else round(ship_base * max_rate / 100, 2) end,
      'line_total',    ship_base + ship_tax));
  end if;

  select sum(taxable_value) as taxable, sum(cgst_amount) as cgst,
         sum(sgst_amount) as sgst, sum(igst_amount) as igst, sum(line_total) as total
    into tot
  from jsonb_to_recordset(v_lines) as x(
    taxable_value numeric, cgst_amount numeric,
    sgst_amount numeric, igst_amount numeric, line_total numeric);

  -- Number and invoice in the same transaction: a rollback takes the
  -- number back with it, which is what keeps numbering gap-free.
  inv_no := next_invoice_number();

  insert into invoices (
    invoice_number, order_id, kind, customer_name, billing_address,
    seller_gstin, place_of_supply,
    taxable_value, cgst_total, sgst_total, igst_total, grand_total)
  values (
    inv_no, p_order_id, 'tax_invoice',
    coalesce(o.shipping_address ->> 'name', 'Customer'),
    coalesce(o.billing_address, o.shipping_address),
    s.seller_gstin, pos,
    tot.taxable, tot.cgst, tot.sgst, tot.igst, tot.total)
  returning id into inv_id;

  insert into invoice_lines (
    invoice_id, description, hsn_code, quantity, unit_price,
    taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount, line_total)
  select inv_id, x.description, x.hsn_code, x.quantity, x.unit_price,
         x.taxable_value, x.gst_rate, x.cgst_amount, x.sgst_amount,
         x.igst_amount, x.line_total
  from jsonb_to_recordset(v_lines) as x(
    description text, hsn_code text, quantity int, unit_price numeric,
    taxable_value numeric, gst_rate numeric, cgst_amount numeric,
    sgst_amount numeric, igst_amount numeric, line_total numeric);

  insert into order_events (order_id, event, note, actor_type, actor_id)
  values (p_order_id, 'invoice_issued', inv_no, 'staff', uid);

  return inv_id;
end $$;

-- ------------------------------------------------------------
-- 5. Receive a return
--
-- p_items is [{"order_item_id": uuid, "quantity": int,
--              "variant_id": uuid, "condition": text}, ...].
-- Resalable units go back to stock; damaged ones are recorded as
-- damage so the ledger explains where they went.
-- ------------------------------------------------------------

create or replace function admin_receive_return(
  p_return_id  uuid,
  p_items      jsonb,
  p_resolution text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid    uuid := require_staff();
  r      return_requests%rowtype;
  it     record;
  refund numeric(12,2) := 0;
  unit   numeric(12,2);
begin
  if p_resolution not in ('refund', 'replacement', 'store_credit') then
    raise exception 'unknown resolution %', p_resolution using errcode = '22023';
  end if;

  select * into r from return_requests where id = p_return_id for update;
  if not found then
    raise exception 'return % not found', p_return_id using errcode = 'P0002';
  end if;
  if r.status in ('received', 'refunded', 'closed', 'rejected') then
    raise exception 'return is already %', r.status using errcode = '55000';
  end if;

  for it in
    select (e ->> 'order_item_id')::uuid as order_item_id,
           (e ->> 'quantity')::int       as quantity,
           (e ->> 'variant_id')::uuid    as variant_id,
           coalesce(e ->> 'condition', 'resalable') as condition
    from jsonb_array_elements(p_items) e
  loop
    update return_items
    set condition = it.condition
    where return_id = p_return_id and order_item_id = it.order_item_id;

    if it.variant_id is not null then
      insert into inventory_movements (variant_id, quantity, reason, order_id, note, created_by)
      values (
        it.variant_id,
        case when it.condition = 'resalable' then it.quantity else -it.quantity end,
        case when it.condition = 'resalable' then 'return' else 'damage' end,
        r.order_id, 'RMA ' || p_return_id, uid);
    end if;

    select oi.unit_price into unit from order_items oi where oi.id = it.order_item_id;
    refund := refund + coalesce(unit, 0) * it.quantity;
  end loop;

  update return_requests
  set status = 'received', resolution = p_resolution, resolved_at = now(), updated_at = now()
  where id = p_return_id;

  -- Store credit is a ledger entry; there is no balance column to bump.
  -- A cash refund is left to the caller, because it has to reference the
  -- original payment the gateway will refund against.
  if p_resolution = 'store_credit' and r.customer_id is not null and refund > 0 then
    insert into credit_ledger (customer_id, delta, reason, order_id, return_id, created_by)
    values (r.customer_id, refund, 'return_credit', r.order_id, p_return_id, uid);
  end if;

  insert into order_events (order_id, event, note, actor_type, actor_id)
  values (r.order_id, 'return_received', p_resolution, 'staff', uid);
end $$;

-- ------------------------------------------------------------
-- Grants
--
-- anonymize_customer() was revoked from public in the base schema, so
-- the API cannot call it without this.
-- ------------------------------------------------------------

revoke execute on function admin_capture_cod(uuid)                        from public;
revoke execute on function admin_cancel_order(uuid, text)                 from public;
revoke execute on function admin_ship_order(uuid, jsonb, text, text, text) from public;
revoke execute on function admin_issue_invoice(uuid, text)                from public;
revoke execute on function admin_receive_return(uuid, jsonb, text)        from public;

grant execute on function admin_capture_cod(uuid)                         to authenticated;
grant execute on function admin_cancel_order(uuid, text)                  to authenticated;
grant execute on function admin_ship_order(uuid, jsonb, text, text, text) to authenticated;
grant execute on function admin_issue_invoice(uuid, text)                 to authenticated;
grant execute on function admin_receive_return(uuid, jsonb, text)         to authenticated;
grant execute on function anonymize_customer(uuid)                        to authenticated;

-- ------------------------------------------------------------
-- Reporting views
--
-- security_invoker = true so the caller's RLS still applies. A definer
-- view here would hand every signed-in shopper the store's revenue.
-- ------------------------------------------------------------

create or replace view admin_sales_daily
with (security_invoker = true) as
  select date_trunc('day', placed_at)::date as day,
         count(*)                            as orders,
         sum(grand_total)                    as revenue,
         sum(discount_total)                 as discounts,
         avg(grand_total)::numeric(12,2)     as average_order_value
  from orders
  where status not in ('cancelled', 'refunded')
  group by 1;

create or replace view admin_low_stock
with (security_invoker = true) as
  select v.id as variant_id, v.product_id, p.name as product_name,
         v.sku, v.title, v.stock, v.low_stock_threshold
  from product_variants v
  join products p on p.id = v.product_id
  where v.status = 'active' and v.stock <= v.low_stock_threshold;

grant select on admin_sales_daily to authenticated;
grant select on admin_low_stock   to authenticated;



-- ============================================================
-- SOURCE: 20260801001300_catalog.sql
-- ============================================================

-- ============================================================
-- 0013  Catalog: typo-tolerant search, and one shipping quote
--
-- Two reads the API cannot express through PostgREST, for opposite
-- reasons.
--
-- search_products: PostgREST has no operator for pg_trgm similarity.
-- Without this the storefront falls back to ILIKE, which cannot find
-- "iPhone charger" from "iphone chrger" -- the exact case the gin
-- trigram indexes were created for.
--
-- shipping_quote: expressible as three round trips, but the band
-- predicate has to mirror rates_no_overlap exactly or the customer is
-- charged the wrong amount. It lives beside that constraint instead.
--
-- Both are SECURITY INVOKER, deliberately. RLS then does the scoping
-- for free: anon sees only active products because public_read says
-- so, staff see drafts because staff_all says so, and one function
-- serves the storefront and the admin without a role flag that could
-- be got wrong.
-- ============================================================


-- ------------------------------------------------------------
-- Fuzzy catalog search
--
-- word_similarity, not similarity: similarity() compares whole
-- strings, so "macbook" against "MacBook Air 13-inch M3" scores low
-- and the product a shopper is obviously looking for does not come
-- back. word_similarity scores the query against the best matching
-- run inside the name, which is what a search box means.
--
-- `name %> q` is the commutator of `q <% name`, and it is the form
-- that uses idx_products_name_trgm.
--
-- Two arms, both served by the same gin index. `%>` catches typos;
-- ILIKE catches the substring queries word_similarity scores badly
-- ("air" inside "MacBook Air").
--
-- The threshold is pinned per call. pg_trgm.word_similarity_threshold
-- defaults to 0.6, and 0.6 rejects word_similarity('aple','Apple') =
-- 0.571 -- one dropped letter in a short brand name, which is the most
-- common typo there is. It cannot go in the function's SET clause:
-- pg_trgm is not preloaded, so at DDL time the GUC is a placeholder and
-- setting one needs superuser. set_config at runtime is not subject to
-- that, and is_local => it is scoped to the statement's transaction
-- rather than left behind on a pooled connection.
-- ------------------------------------------------------------

create or replace function search_products(p_q text, p_limit int default 20)
returns table (
  id          uuid,
  slug        text,
  name        text,
  brand       text,
  description text,
  category_id uuid,
  status      text,
  score       real
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  perform set_config('pg_trgm.word_similarity_threshold', '0.35', true);

  return query
  with q as (
    select btrim(coalesce(p_q, '')) as raw
  ),
  pat as (
    -- % and _ are wildcards. Unescaped, a search for "50%" matches the
    -- whole catalog -- not an injection, but the same shape of bug.
    select q.raw,
           -- E'' throughout: with standard_conforming_strings on, '\\' is
           -- TWO backslashes, so the plain form escapes nothing.
           '%' || replace(replace(replace(q.raw, E'\\', E'\\\\'),
                                  '%', E'\\%'), '_', E'\\_') || '%' as like_pat
    from q
  )
  select hit.id, hit.slug, hit.name, hit.brand, hit.description,
         hit.category_id, hit.status, hit.score
  from (
    select p.id, p.slug, p.name, p.brand, p.description,
           p.category_id, p.status,
           greatest(word_similarity(pat.raw, p.name),
                    word_similarity(pat.raw, coalesce(p.brand, '')))::real as score
    from products p
    cross join pat
    -- A one-character query matches most of the catalog and cannot use
    -- the trigram index, so it is not a search -- it is a table scan.
    where length(pat.raw) >= 2
      and (p.name  %> pat.raw
        or p.brand %> pat.raw
        or p.name  ilike pat.like_pat
        or p.brand ilike pat.like_pat)
  ) hit
  order by hit.score desc, hit.name
  -- Clamped: an unbounded limit from a query string is a free full scan.
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
end $$;

comment on function search_products(text, int) is
  'Typo-tolerant product search over name and brand. SECURITY INVOKER, so '
  'RLS decides visibility: anon gets active products, staff get drafts too.';

-- ------------------------------------------------------------
-- "Deliver to 560001?", and what it costs
--
-- Returns ZERO ROWS when the pincode is not serviceable. That is the
-- answer, not an error -- callers check for the empty result.
--
-- One row otherwise, because rates_no_overlap guarantees at most one
-- active band can match a (zone, weight, basket value) point. The
-- predicate below is half-open on both axes to match that constraint's
-- '[)' ranges. docs/schema_guide.md used BETWEEN, which is inclusive
-- at the top: a 500g parcel matched both the [0,500) and the [500,1000)
-- band, and the price the customer saw depended on the plan.
-- ------------------------------------------------------------

create or replace function shipping_quote(
  p_pincode      text,
  p_weight_grams int     default 0,
  p_order_total  numeric default 0
)
returns table (
  zone_id       uuid,
  cod_allowed   boolean,
  courier       text,
  rate          numeric(12,2),
  cod_surcharge numeric(12,2),
  delivery_days int,
  free_shipping boolean,
  rate_source   text
)
language sql
stable
set search_path = public, pg_temp
as $$
  with sp as (
    select * from serviceable_pincodes where pincode = p_pincode
  ),
  -- public_settings, not store_settings: the latter is staff-only, so a
  -- shopper calling this would silently get no settings and the wrong
  -- fallback rate.
  st as (
    select cod_enabled, free_shipping_above, flat_shipping_rate
    from public_settings
    limit 1
  ),
  band as (
    select sr.id, sr.rate, sr.cod_surcharge, sr.delivery_days
    from shipping_rates sr
    join sp on sp.zone_id = sr.zone_id
    where sr.is_active
      and p_weight_grams >= sr.min_weight_grams
      and (sr.max_weight_grams is null or p_weight_grams < sr.max_weight_grams)
      and p_order_total  >= sr.min_order_total
      and (sr.max_order_total is null or p_order_total < sr.max_order_total)
  ),
  free as (
    select st.free_shipping_above is not null
       and p_order_total >= st.free_shipping_above as yes
    from st
  )
  select
    sp.zone_id,
    -- Both have to agree: the store can switch COD off globally, and a
    -- single pincode can be barred while the store still offers it.
    sp.cod_allowed and coalesce(st.cod_enabled, false),
    sp.courier,
    case when coalesce(free.yes, false) then 0
         else coalesce(band.rate, st.flat_shipping_rate, 0) end::numeric(12,2),
    coalesce(band.cod_surcharge, 0)::numeric(12,2),
    band.delivery_days,
    coalesce(free.yes, false),
    case when coalesce(free.yes, false) then 'free_shipping'
         when band.id is not null       then 'zone_rate'
         else                                'flat_rate' end
  -- left joins throughout: a pincode with no zone, or a zone with no
  -- matching band, still answers "we deliver there" at the flat rate.
  from sp
  left join st   on true
  left join free on true
  left join band on true;
$$;

comment on function shipping_quote(text, int, numeric) is
  'Serviceability and price for one pincode. Zero rows means not '
  'serviceable. Checkout must price shipping through this function, or the '
  'quote the customer saw and the amount they are charged can disagree.';

revoke execute on function search_products(text, int)            from public;
revoke execute on function shipping_quote(text, int, numeric)    from public;
grant  execute on function search_products(text, int)            to anon, authenticated;
grant  execute on function shipping_quote(text, int, numeric)    to anon, authenticated;



-- ============================================================
-- SOURCE: 20260801001400_checkout.sql
-- ============================================================

-- ============================================================
-- 0014  Checkout
--
-- The sequence in docs/schema_guide.md section 20, as one call.
-- supabase-js issues one PostgREST request per statement, so running
-- that sequence from TypeScript is seven transactions: a failure at
-- step 5 leaves stock reserved, an order half-built, and a coupon
-- counted. There is no version of this that is safe outside a
-- function.
--
-- SECURITY DEFINER, and the owner (postgres) has BYPASSRLS, so this
-- runs with RLS off. That is required -- `orders` has no INSERT policy
-- for customers, deliberately, because order totals are never trusted
-- to a browser -- and it makes one rule load-bearing:
--
--     the customer is taken from auth.uid(), never from a parameter.
--
-- There is no p_customer_id. A caller cannot place an order as someone
-- else because there is nowhere to say who they are.
--
-- If these migrations are ever applied by a role WITHOUT BYPASSRLS,
-- checkout will start failing with row-level security errors rather
-- than doing something quietly wrong.
--
-- ERROR CONVENTION
--
-- Every refusal below carries a SQLSTATE Postgres itself never raises:
--
--     ECOM1  the request is wrong      -> the API answers 422
--     ECOM2  the request conflicts     -> the API answers 409
--
-- with a machine-readable `hint` and a message written for a customer.
-- That is what lets apps/api forward these strings verbatim while still
-- refusing to forward anything Postgres wrote: the SQLSTATE is proof of
-- authorship, so 'Coupon DIWALI20 is not valid.' reaches the shopper and
-- 'violates check constraint "orders_totals_balance"' never can.
-- ============================================================


-- ------------------------------------------------------------
-- Splitting an order discount across its lines
--
-- Extracted because two functions have to agree to the paisa or every
-- invoice fails to reconcile against the order it bills: checkout
-- computes tax_total before the order exists, admin_issue_invoice
-- computes invoice lines after. Same arithmetic, one implementation.
--
-- The last line absorbs the rounding remainder. Without that the
-- rounded shares do not add back up: subtotal 100.00 across three
-- lines of 33.34/33.33/33.33 with a 1.00 discount rounds to
-- 33.01/33.00/33.00 = 99.01, a paisa more than the 99.00 actually
-- charged, and the invoice total disagrees with the order.
-- ------------------------------------------------------------

create or replace function apportion_taxable(
  p_lines    jsonb,      -- [{ "line_total": n, "gst_rate": n, ... }]
  p_subtotal numeric,
  p_discount numeric
)
returns jsonb            -- the same array, each element gaining taxable_value
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(
           jsonb_agg(x.line || jsonb_build_object('taxable_value', x.taxable)
                     order by x.ord),
           '[]'::jsonb)
  from (
    select t.e as line,
           t.ord,
           b.taxable
           + case when t.ord = max(t.ord) over ()
                  then (p_subtotal - p_discount) - sum(b.taxable) over ()
                  else 0 end as taxable
    from jsonb_array_elements(p_lines) with ordinality as t(e, ord)
    cross join lateral (
      select round((t.e ->> 'line_total')::numeric
                   - case when p_subtotal > 0
                          then p_discount * (t.e ->> 'line_total')::numeric / p_subtotal
                          else 0 end, 2) as taxable
    ) b
  ) x;
$$;

revoke execute on function apportion_taxable(jsonb, numeric, numeric) from public;

-- ------------------------------------------------------------
-- Taking an order
--
-- p_items is [{"variant_id": uuid, "quantity": int}]. Everything else
-- about those items -- price, name, SKU, weight, GST rate -- is read
-- from the database. The request says what, never what it costs.
-- ------------------------------------------------------------

create or replace function checkout(
  p_idempotency_key  text,
  p_request_hash     text,
  p_email            text,
  p_phone            text,
  p_items            jsonb,
  p_shipping_address jsonb,
  p_payment_method   text,
  p_coupon_code      text default null,
  p_cart_id          uuid default null,
  p_hold_minutes     int  default 15
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid       uuid := auth.uid();
  ik        idempotency_keys%rowtype;
  claimed   text;
  d         discounts%rowtype;
  q         record;
  pin       text;
  v_lines   jsonb;
  n_items   int;
  weight_g  int           := 0;
  max_rate  numeric(4,2)  := 0;
  subtotal  numeric(12,2) := 0;
  discount  numeric(12,2) := 0;
  shipping  numeric(12,2) := 0;
  tax       numeric(12,2) := 0;
  grand     numeric(12,2);
  eligible  numeric(12,2) := 0;
  flags     jsonb := '[]'::jsonb;
  risk      int;
  o_id      uuid;
  o_number  text;
  pay_id    uuid;
  res       jsonb;
begin
  if p_payment_method not in ('razorpay', 'cod') then
    raise exception 'That payment method is not supported.'
      using errcode = 'ECOM1', hint = 'unsupported_payment_method';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Your cart is empty.'
      using errcode = 'ECOM1', hint = 'cart_empty';
  end if;

  -- 1. Claim the idempotency key FIRST.
  --
  -- Two concurrent identical requests do not both proceed: the second
  -- INSERT blocks on the unique index until the first commits or rolls
  -- back, then either replays the stored response or takes over.
  insert into idempotency_keys (key, scope, request_hash, customer_id, locked_at)
  values (p_idempotency_key, 'checkout', p_request_hash, uid, now())
  on conflict (key) do nothing
  returning key into claimed;

  if claimed is null then
    select * into ik from idempotency_keys where key = p_idempotency_key;

    -- Same key, different body is a client bug. Replaying the first
    -- response would hide it and charge for the wrong basket.
    if ik.request_hash is distinct from p_request_hash then
      raise exception 'This request was already submitted with a different basket.'
        using errcode = 'ECOM2', hint = 'idempotency_key_conflict';
    end if;
    if ik.completed_at is null then
      raise exception 'That checkout is still being processed. Try again in a moment.'
        using errcode = 'ECOM2', hint = 'checkout_in_flight';
    end if;
    return ik.response_body;
  end if;

  -- 2. Price the basket from the database.
  select jsonb_agg(jsonb_build_object(
           'variant_id',    v.id,
           'product_id',    p.id,
           'product_name',  p.name,
           'variant_title', coalesce(v.title, 'Default'),
           'sku',           v.sku,
           'unit_price',    v.price,
           'quantity',      req.quantity,
           'line_total',    round(v.price * req.quantity, 2),
           'gst_rate',      coalesce(p.gst_rate, 0))),
         count(*),
         coalesce(sum(round(v.price * req.quantity, 2)), 0),
         coalesce(sum(coalesce(v.weight_grams, 0) * req.quantity), 0),
         coalesce(max(coalesce(p.gst_rate, 0)), 0)
    into v_lines, n_items, subtotal, weight_g, max_rate
  from jsonb_to_recordset(p_items) as req(variant_id uuid, quantity int)
  join product_variants v on v.id = req.variant_id
  join products p on p.id = v.product_id
  where v.status = 'active' and p.status = 'active' and req.quantity > 0;

  -- A short count means something in the basket is archived, draft or
  -- gone. Naming which would let anyone enumerate unreleased products.
  if v_lines is null or n_items <> jsonb_array_length(p_items) then
    raise exception 'One or more items in your cart are no longer available.'
      using errcode = 'ECOM2', hint = 'items_unavailable';
  end if;

  -- 3. Coupon. Locked, because max_uses is enforced by a counter and
  --    two checkouts must not both claim the last use.
  if p_coupon_code is not null then
    select * into d from discounts
    where code = p_coupon_code
      and is_active
      and starts_at <= now()
      and (ends_at is null or ends_at > now())
    for update;

    -- One message for expired, inactive and non-existent alike: three
    -- messages is a way to enumerate live codes.
    if not found then
      raise exception 'Coupon % is not valid.', p_coupon_code
        using errcode = 'ECOM1', hint = 'invalid_coupon';
    end if;
    if d.min_order_total is not null and subtotal < d.min_order_total then
      raise exception 'Coupon % needs an order of at least %.',
        p_coupon_code, d.min_order_total
        using errcode = 'ECOM1', hint = 'coupon_minimum_not_met';
    end if;

    select coalesce(sum((e ->> 'line_total')::numeric), 0) into eligible
    from jsonb_array_elements(v_lines) e
    where d.applies_to = 'order'
       or (d.applies_to = 'product' and (e ->> 'product_id')::uuid = d.product_id)
       or (d.applies_to = 'collection' and exists (
             select 1 from collection_products cp
             where cp.collection_id = d.collection_id
               and cp.product_id = (e ->> 'product_id')::uuid));

    if d.kind = 'percent' then
      discount := round(eligible * d.value / 100, 2);
    elsif d.kind = 'fixed' then
      -- Capped at what it applies to, or orders_discount_within_subtotal
      -- refuses the insert.
      discount := least(d.value, eligible);
    end if;

    if discount = 0 and d.kind <> 'free_shipping' then
      raise exception 'Coupon % does not apply to anything in this order.',
        p_coupon_code using errcode = 'ECOM1', hint = 'coupon_not_applicable';
    end if;
  end if;

  -- 4. Shipping, through the same function that quoted it on the cart
  --    page. Computing it a second way here is how the quote and the
  --    charge come to disagree.
  pin := p_shipping_address ->> 'postal_code';
  select * into q from shipping_quote(pin, weight_g, subtotal - discount);
  if not found then
    raise exception 'We do not deliver to %.', coalesce(pin, 'that pincode')
      using errcode = 'ECOM1', hint = 'not_serviceable';
  end if;

  shipping := q.rate;
  if d.id is not null and d.kind = 'free_shipping' then
    -- Zero the shipping rather than adding to discount_total:
    -- orders_discount_within_subtotal caps the discount at the subtotal,
    -- and free shipping is not a discount on goods.
    shipping := 0;
  end if;

  -- 5. COD gating. The blocklist exists to stop repeat RTO offenders
  --    before they cost two-way courier fees; not consulting it here
  --    means it never blocks anybody.
  select coalesce(jsonb_agg(f), '[]'::jsonb) into flags
  from (
    select 'blocklisted_' || b.kind as f
    from blocklist b
    where (b.expires_at is null or b.expires_at > now())
      and ((b.kind = 'phone'   and b.value = p_phone)
        or (b.kind = 'email'   and b.value = p_email)
        or (b.kind = 'pincode' and b.value = pin))
  ) hits;

  risk := case when jsonb_array_length(flags) > 0 then 100 else null end;

  if p_payment_method = 'cod' then
    if jsonb_array_length(flags) > 0 then
      raise exception 'Cash on delivery is not available for this order.'
        using errcode = 'ECOM1', hint = 'cod_unavailable';
    end if;
    if not q.cod_allowed then
      raise exception 'Cash on delivery is not available for %.', pin
        using errcode = 'ECOM1', hint = 'cod_unavailable';
    end if;
    shipping := shipping + q.cod_surcharge;
  end if;

  -- 6. Tax. Prices are GST-exclusive here: grand_total = subtotal
  --    - discount + shipping + tax, and orders_totals_balance enforces it.
  --    Shipping is taxed at the highest item rate (composite supply),
  --    matching admin_issue_invoice.
  v_lines := apportion_taxable(v_lines, subtotal, discount);

  -- 2 * round(rate/200) rather than round(rate/100): the invoice must
  -- split intra-state tax into two EQUAL halves (invoice_lines_
  -- cgst_equals_sgst), so the amount has to be even in paise. Rounding
  -- to the full rate here would leave the invoice a paisa off.
  select coalesce(sum(2 * round((e ->> 'taxable_value')::numeric
                                * (e ->> 'gst_rate')::numeric / 200, 2)), 0)
    into tax
  from jsonb_array_elements(v_lines) e;

  tax   := tax + 2 * round(shipping * max_rate / 200, 2);
  grand := subtotal - discount + shipping + tax;

  -- 7. The order.
  insert into orders (customer_id, email, phone,
                      subtotal, discount_total, shipping_total, tax_total, grand_total,
                      coupon_code, shipping_address, risk_score, risk_flags)
  values (uid, p_email, p_phone,
          subtotal, discount, shipping, tax, grand,
          case when d.id is not null then p_coupon_code end,
          p_shipping_address, risk, flags)
  returning id, order_number into o_id, o_number;

  insert into order_items (order_id, variant_id, product_name, variant_title,
                           sku, unit_price, quantity)
  select o_id, (e ->> 'variant_id')::uuid, e ->> 'product_name',
         e ->> 'variant_title', e ->> 'sku',
         (e ->> 'unit_price')::numeric, (e ->> 'quantity')::int
  from jsonb_array_elements(v_lines) e;

  -- 8. Reserve the stock.
  --
  -- After the order, not before it as section 20 shows, because
  -- inventory_movements is append-only: order_id cannot be filled in
  -- later, and admin_capture_cod finds its reservations by order_id.
  -- The guard is unaffected -- this is one transaction, so a failed
  -- CHECK (stock >= 0) still takes the order with it.
  --
  -- expires_at is mandatory: a hold nothing releases strands that unit
  -- forever. release_expired_reservations() sweeps these.
  insert into inventory_movements (variant_id, quantity, reason, order_id, expires_at)
  select (e ->> 'variant_id')::uuid, -(e ->> 'quantity')::int, 'reservation',
         o_id, now() + make_interval(mins => p_hold_minutes)
  from jsonb_array_elements(v_lines) e;

  -- 9. Redemption. The trigger on this table increments used_count and
  --    refuses the row if it would exceed either limit.
  if d.id is not null and discount > 0 then
    insert into discount_redemptions (discount_id, order_id, customer_id, amount)
    values (d.id, o_id, uid, discount);
  end if;

  insert into payments (order_id, provider, amount, status)
  values (o_id, case when p_payment_method = 'cod' then 'cod' else 'razorpay' end,
          grand, 'created')
  returning id into pay_id;

  insert into order_events (order_id, event, to_status, actor_type, actor_id)
  values (o_id, 'order_placed', 'pending',
          case when uid is null then 'system' else 'customer' end, uid);

  -- 10. Outbox. Queued in the same transaction as the order, so a dead
  --     email provider cannot lose the confirmation or roll back the sale.
  insert into message_log (customer_id, order_id, channel, template, recipient, payload)
  values (uid, o_id, 'email', 'order_confirmation', p_email,
          jsonb_build_object('order_number', o_number, 'grand_total', grand));

  if p_cart_id is not null then
    update carts
    set status = 'converted', converted_order_id = o_id, updated_at = now()
    where id = p_cart_id and status = 'active';
  end if;

  res := jsonb_build_object(
    'order_id',       o_id,
    'order_number',   o_number,
    'status',         'pending',
    'payment_id',     pay_id,
    'payment_method', p_payment_method,
    'currency',       'INR',
    'subtotal',       subtotal,
    'discount_total', discount,
    'shipping_total', shipping,
    'tax_total',      tax,
    'grand_total',    grand,
    'reserved_until', (now() + make_interval(mins => p_hold_minutes)));

  -- 11. Store the response so a retry of step 1 replays it verbatim.
  update idempotency_keys
  set response_status = 201, response_body = res, completed_at = now()
  where key = p_idempotency_key;

  return res;
end $$;

revoke execute on function
  checkout(text, text, text, text, jsonb, jsonb, text, text, uuid, int) from public;
grant execute on function
  checkout(text, text, text, text, jsonb, jsonb, text, text, uuid, int)
  to anon, authenticated;

-- ------------------------------------------------------------
-- admin_issue_invoice, corrected
--
-- Replaced rather than edited in 0012, because 0012 has been applied
-- and a migration that changes after it runs is not a migration.
--
-- Two defects, both worth a paisa and both fatal to reconciliation --
-- an invoice whose total is not what the customer was charged is a
-- GST filing problem, not a rounding curiosity:
--
--  1. The discount was apportioned per line and each share rounded
--     independently, so the rounded shares did not add back up to
--     the discount actually taken. Now shared with checkout via
--     apportion_taxable(), which gives the remainder to the last line.
--
--  2. Same-state tax was 2 * round(taxable * rate/200, 2) while
--     inter-state was round(taxable * rate/100, 2). Those disagree by
--     a paisa on some values, so the identical supply was billed two
--     different totals depending on where the customer lives -- and
--     checkout, which cannot know the place of supply, could only
--     match one of them. Both now derive from the same half:
--     cgst = sgst = half, igst = 2 * half.
--
--     The halving is not a choice. invoice_lines_cgst_equals_sgst and
--     invoices_cgst_equals_sgst require the two to be exactly equal,
--     so the tax on a line has to be an even number of paise.
-- ------------------------------------------------------------

create or replace function admin_issue_invoice(
  p_order_id        uuid,
  p_place_of_supply text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid        uuid := require_staff();
  o          orders%rowtype;
  s          store_settings%rowtype;
  pos        text;
  same_state boolean;
  inv_id     uuid;
  inv_no     text;
  max_rate   numeric(4,2);
  ship_base  numeric(12,2) := 0;
  ship_tax   numeric(12,2) := 0;
  raw_lines  jsonb;
  v_lines    jsonb;
  tot        record;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'P0002';
  end if;
  if o.status = 'pending' then
    raise exception 'order % is unpaid', o.order_number using errcode = '55000';
  end if;

  if exists (select 1 from invoices where order_id = p_order_id and kind = 'tax_invoice') then
    raise exception 'order % already has a tax invoice', o.order_number
      using errcode = '23505';
  end if;

  select * into s from store_settings where id = 1;
  if s.seller_gstin is null then
    raise exception 'store_settings.seller_gstin is not set; invoicing cannot proceed'
      using errcode = '55000';
  end if;

  pos := coalesce(p_place_of_supply, s.seller_state_code);
  if pos is null then
    raise exception 'no place of supply and no seller_state_code' using errcode = '55000';
  end if;
  same_state := (pos = s.seller_state_code);

  -- Lines are computed BEFORE the invoice row exists. The obvious
  -- shape -- insert the invoice with zero totals, add lines, then
  -- update the totals -- is refused by protect_invoice(), and rightly:
  -- an invoice that can be updated after issue is not a legal document.
  select jsonb_agg(jsonb_build_object(
           'description', oi.product_name || coalesce(' / ' || oi.variant_title, ''),
           'hsn_code',    p.hsn_code,
           'quantity',    oi.quantity,
           'unit_price',  oi.unit_price,
           'line_total',  oi.line_total,
           'gst_rate',    coalesce(p.gst_rate, 0))
         order by oi.id)
    into raw_lines
  from order_items oi
  left join product_variants v on v.id = oi.variant_id
  left join products p on p.id = v.product_id
  where oi.order_id = p_order_id;

  if raw_lines is null then
    raise exception 'order % has no line items', o.order_number using errcode = '55000';
  end if;

  -- The same split checkout used to arrive at tax_total.
  raw_lines := apportion_taxable(raw_lines, o.subtotal, o.discount_total);

  select jsonb_agg(jsonb_build_object(
           'description',   e ->> 'description',
           'hsn_code',      e ->> 'hsn_code',
           'quantity',      (e ->> 'quantity')::int,
           'unit_price',    (e ->> 'unit_price')::numeric,
           'taxable_value', t.taxable,
           'gst_rate',      (e ->> 'gst_rate')::numeric,
           'cgst_amount',   case when same_state then t.half else 0 end,
           'sgst_amount',   case when same_state then t.half else 0 end,
           'igst_amount',   case when same_state then 0 else 2 * t.half end,
           'line_total',    t.taxable + 2 * t.half))
    into v_lines
  from jsonb_array_elements(raw_lines) e
  cross join lateral (
    -- One half, used three ways. igst is 2 * half rather than its own
    -- rounding, so intra-state and inter-state bill the same amount for
    -- the same supply -- and both match what checkout charged.
    select (e ->> 'taxable_value')::numeric as taxable,
           round((e ->> 'taxable_value')::numeric
                 * (e ->> 'gst_rate')::numeric / 200, 2) as half
  ) t;

  -- Shipping, at the highest item rate (composite supply).
  if o.shipping_total > 0 then
    select coalesce(max((e ->> 'gst_rate')::numeric), 0) into max_rate
    from jsonb_array_elements(v_lines) e;

    ship_base := o.shipping_total;
    ship_tax  := 2 * round(ship_base * max_rate / 200, 2);

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'description',   'Shipping',
      'hsn_code',      null,
      'quantity',      1,
      'unit_price',    ship_base,
      'taxable_value', ship_base,
      'gst_rate',      max_rate,
      'cgst_amount',   case when same_state then ship_tax / 2 else 0 end,
      'sgst_amount',   case when same_state then ship_tax / 2 else 0 end,
      'igst_amount',   case when same_state then 0 else ship_tax end,
      'line_total',    ship_base + ship_tax));
  end if;

  select sum(taxable_value) as taxable, sum(cgst_amount) as cgst,
         sum(sgst_amount) as sgst, sum(igst_amount) as igst, sum(line_total) as total
    into tot
  from jsonb_to_recordset(v_lines) as x(
    taxable_value numeric, cgst_amount numeric,
    sgst_amount numeric, igst_amount numeric, line_total numeric);

  -- Number and invoice in the same transaction: a rollback takes the
  -- number back with it, which is what keeps numbering gap-free.
  inv_no := next_invoice_number();

  insert into invoices (
    invoice_number, order_id, kind, customer_name, billing_address,
    seller_gstin, place_of_supply,
    taxable_value, cgst_total, sgst_total, igst_total, grand_total)
  values (
    inv_no, p_order_id, 'tax_invoice',
    coalesce(o.shipping_address ->> 'name', 'Customer'),
    coalesce(o.billing_address, o.shipping_address),
    s.seller_gstin, pos,
    tot.taxable, tot.cgst, tot.sgst, tot.igst, tot.total)
  returning id into inv_id;

  insert into invoice_lines (
    invoice_id, description, hsn_code, quantity, unit_price,
    taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount, line_total)
  select inv_id, x.description, x.hsn_code, x.quantity, x.unit_price,
         x.taxable_value, x.gst_rate, x.cgst_amount, x.sgst_amount,
         x.igst_amount, x.line_total
  from jsonb_to_recordset(v_lines) as x(
    description text, hsn_code text, quantity int, unit_price numeric,
    taxable_value numeric, gst_rate numeric, cgst_amount numeric,
    sgst_amount numeric, igst_amount numeric, line_total numeric);

  insert into order_events (order_id, event, note, actor_type, actor_id)
  values (p_order_id, 'invoice_issued', inv_no, 'staff', uid);

  return inv_id;
end $$;



-- ============================================================
-- SOURCE: 20260801001500_payments.sql
-- ============================================================

-- ============================================================
-- 0015  Payments and webhooks
--
-- Gateways retry until they get a 2xx, and they are not careful about
-- it. Everything here exists so that a delivery arriving twice -- or
-- arriving while the first one is still being processed -- changes the
-- world exactly once.
--
-- Two rules the shapes below enforce rather than document:
--
--   RECORD BEFORE ACTING. record_webhook() writes the delivery down
--   first. If processing then crashes, the row is still there with its
--   error, and the retry has something to be idempotent against. Acting
--   first and recording after means a crash in between captures twice.
--
--   PROCESSED, NOT SEEN, IS THE GATE. A duplicate delivery whose first
--   attempt failed must still be processed. So the question is never
--   "have I seen this?" but "did it finish?" -- processed_at, not the
--   unique index.
--
-- Granted to service_role only. A webhook has no user, so these run on
-- the service key; giving them to `authenticated` would let any signed-in
-- shopper mark their own order paid.
-- ============================================================


-- ------------------------------------------------------------
-- Write the delivery down
--
-- Returns is_new (did this insert, or collide with an earlier delivery)
-- and already_processed (did an earlier attempt finish). The caller
-- processes on `not already_processed`, whatever is_new says.
--
-- xmax = 0 is how a row that was just INSERTed is told apart from one
-- the ON CONFLICT clause UPDATEd: a fresh insert has no updating
-- transaction id.
-- ------------------------------------------------------------

create or replace function record_webhook(
  p_provider   text,
  p_event_id   text,
  p_event_type text,
  p_payload    jsonb,
  p_verified   boolean default false
)
returns table (
  id                uuid,
  is_new            boolean,
  already_processed boolean,
  attempts          int
)
language sql
set search_path = public, pg_temp
as $$
  insert into webhook_events (provider, event_id, event_type, payload,
                              signature_verified, attempts)
  values (p_provider, p_event_id, p_event_type, p_payload, p_verified, 1)
  on conflict (provider, event_id) do update
    set attempts = webhook_events.attempts + 1
  returning webhook_events.id,
            (xmax = 0),
            webhook_events.processed_at is not null,
            webhook_events.attempts;
$$;

create or replace function mark_webhook_processed(
  p_id    uuid,
  p_error text default null
)
returns void
language sql
set search_path = public, pg_temp
as $$
  update webhook_events
  set processed_at = case when p_error is null then now() else processed_at end,
      error        = p_error
  where id = p_id;
$$;

-- ------------------------------------------------------------
-- Capture
--
-- The same two-row ledger move admin_capture_cod makes, for a gateway
-- instead of a person: give the hold back, then take the units as a
-- sale. One row would be cheaper and would also be a lie -- the
-- reservation really did take that stock down, and the ledger has to say
-- what happened.
--
-- Idempotent three times over, because a gateway will test all three:
--   - a non-pending order returns false and changes nothing
--   - uniq_payment_provider_ref refuses a second payment row for the
--     same gateway reference
--   - the reservation_id unique index makes a double release impossible
-- ------------------------------------------------------------

create or replace function capture_payment(
  p_order_id     uuid,
  p_provider     text,
  p_provider_ref text,
  p_amount       numeric default null
)
returns boolean          -- true if this call is what moved the order
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o     orders%rowtype;
  res   record;
  pay   uuid;
  n_res int;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'P0002';
  end if;

  -- The replay lands here. Not an error: the gateway is doing exactly
  -- what it promised, and the answer is that there is nothing to do.
  if o.status <> 'pending' then
    return false;
  end if;

  -- A gateway that captures less than it was asked for is a dispute, not
  -- a checkout. Refusing is the only safe answer -- marking the order
  -- paid for the wrong amount is unrecoverable without a human.
  if p_amount is not null and p_amount <> o.grand_total then
    raise exception
      'gateway captured % against an order of %', p_amount, o.grand_total
      using errcode = 'ECOM2', hint = 'amount_mismatch';
  end if;

  n_res := 0;
  for res in
    select m.id, m.variant_id, m.quantity
    from inventory_movements m
    where m.order_id = p_order_id
      and m.reason = 'reservation'
      and not exists (
        select 1 from inventory_movements c where c.reservation_id = m.id)
  loop
    insert into inventory_movements (variant_id, quantity, reason, order_id, reservation_id)
    values (res.variant_id, -res.quantity, 'release', p_order_id, res.id);

    insert into inventory_movements (variant_id, quantity, reason, order_id)
    values (res.variant_id, res.quantity, 'sale', p_order_id);

    n_res := n_res + 1;
  end loop;

  -- The hold lapsed before the money landed.
  --
  -- Doing nothing here is the dangerous option, and it is the one the
  -- loop above does on its own: no reservation left to consume means no
  -- sale row, so the order goes to 'paid' with the stock never taken and
  -- the shortfall is invisible until someone counts the shelf.
  --
  -- So take it now. If the units are genuinely gone, stock >= 0 fires and
  -- this whole capture fails -- which is correct and is meant to be loud:
  -- the gateway has the customer's money and the store cannot ship. That
  -- is a person's decision (refund, or restock and re-run), not a retry's.
  if n_res = 0 then
    insert into inventory_movements (variant_id, quantity, reason, order_id, note)
    select oi.variant_id, -oi.quantity, 'sale', p_order_id,
           'reservation expired before capture'
    from order_items oi
    where oi.order_id = p_order_id and oi.variant_id is not null;
  end if;

  update payments
  set status = 'captured', provider_ref = coalesce(provider_ref, p_provider_ref),
      updated_at = now()
  where order_id = p_order_id and provider = p_provider and status <> 'captured'
  returning id into pay;

  -- COD captured through the gateway path, or a payment row that never
  -- got created: record it rather than losing the money's provenance.
  if pay is null then
    insert into payments (order_id, provider, provider_ref, amount, status)
    values (p_order_id, p_provider, p_provider_ref, o.grand_total, 'captured')
    on conflict do nothing;
  end if;

  update orders set status = 'paid', updated_at = now() where id = p_order_id;

  insert into order_events (order_id, event, from_status, to_status, note, actor_type)
  values (p_order_id, 'payment_captured', o.status, 'paid', p_provider, 'system');

  return true;
end $$;

-- ------------------------------------------------------------
-- Failure
--
-- Marks the attempt failed and leaves the stock hold alone, which looks
-- wrong next to schema_guide section 20's "on payment failure, release
-- only" and is not.
--
-- payment.failed is not terminal at Razorpay: a mistyped OTP fires it
-- and the customer retries in the same session. Releasing there would
-- hand their basket to someone else mid-checkout, and the retry would
-- have no hold at all. The reservation's own expires_at is the release
-- mechanism -- that is the entire reason it is mandatory -- and
-- release_expired_reservations() runs it. A terminal failure is a
-- cancellation, and admin_cancel_order() releases immediately.
-- ------------------------------------------------------------

create or replace function fail_payment(
  p_order_id     uuid,
  p_provider     text,
  p_provider_ref text default null,
  p_reason       text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare o orders%rowtype;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'P0002';
  end if;
  if o.status <> 'pending' then
    return false;                       -- already paid, or already cancelled
  end if;

  update payments
  set status = 'failed',
      provider_ref = coalesce(provider_ref, p_provider_ref),
      updated_at = now()
  where order_id = p_order_id and provider = p_provider and status = 'created';

  insert into order_events (order_id, event, note, actor_type)
  values (p_order_id, 'payment_failed', p_reason, 'system');

  return true;
end $$;

-- ------------------------------------------------------------
-- Attach the gateway's order id
--
-- Separate from capture so creating the gateway order is retryable: the
-- route asks for the existing ref first and only calls Razorpay if there
-- is not one, so a client that retries does not open a second gateway
-- order against the same basket.
-- ------------------------------------------------------------

create or replace function attach_payment_ref(
  p_order_id     uuid,
  p_provider     text,
  p_provider_ref text
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update payments
  set provider_ref = p_provider_ref, updated_at = now()
  where order_id = p_order_id and provider = p_provider and provider_ref is null;
$$;

revoke execute on function record_webhook(text, text, text, jsonb, boolean)  from public;
revoke execute on function mark_webhook_processed(uuid, text)                from public;
revoke execute on function capture_payment(uuid, text, text, numeric)        from public;
revoke execute on function fail_payment(uuid, text, text, text)              from public;
revoke execute on function attach_payment_ref(uuid, text, text)              from public;

-- service_role only. These move money and stock with no user present, so
-- there is no version of this that `authenticated` should reach.
grant execute on function record_webhook(text, text, text, jsonb, boolean)   to service_role;
grant execute on function mark_webhook_processed(uuid, text)                 to service_role;
grant execute on function capture_payment(uuid, text, text, numeric)         to service_role;
grant execute on function fail_payment(uuid, text, text, text)               to service_role;
grant execute on function attach_payment_ref(uuid, text, text)               to service_role;



-- ============================================================
-- SOURCE: 20260801001600_inventory.sql
-- ============================================================

-- ============================================================
-- 0016  Inventory and fulfilment
--
-- Two things happen here.
--
-- FIRST, the sweeper functions move out of supabase/jobs/retention.sql
-- and into a migration. That file said "NOT a migration" meaning "do not
-- RUN these on deploy", and the result was that nothing ever created
-- them: the live database had no release_expired_reservations() at all,
-- so every reservation whose payment never landed held its stock
-- permanently and nothing in the system would ever have said so.
--
-- The scheduling stays out of migrations, which is the part that was
-- always right. jobs/retention.sql now holds only the cron statements.
--
-- SECOND, the admin inventory surface. The whole of it is one function,
-- record_stock_movement(), and its allow-list is the reason it exists:
-- 'sale', 'reservation' and 'release' are not receivable here. A release
-- row consumes a hold, so an admin endpoint able to write one could
-- invent stock out of nothing.
-- ============================================================


-- ------------------------------------------------------------
-- Sweepers (moved from supabase/jobs/retention.sql)
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- Expired inventory reservations
--
-- The one job here that is about money rather than disk. A
-- reservation whose release worker died holds stock nobody can buy,
-- and nothing else in the system will ever notice. The unique index
-- on reservation_id makes a double release impossible, so this is
-- safe to run concurrently with the checkout path.
-- ------------------------------------------------------------

create or replace function release_expired_reservations()
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare released int := 0;
begin
  insert into inventory_movements (variant_id, quantity, reason, order_id,
                                   reservation_id, note)
  select r.variant_id,
         -r.quantity,          -- reservations are negative; invert to give back
         'release',
         r.order_id,
         r.id,
         'auto-released: reservation expired'
  from inventory_movements r
  where r.reason = 'reservation'
    and r.expires_at < now()
    and not exists (
      select 1 from inventory_movements c
      where c.reservation_id = r.id     -- already released or converted to a sale
    );

  get diagnostics released = row_count;
  return released;
end $$;

comment on function release_expired_reservations() is
  'Returns stranded stock to the sellable pool. Run every few minutes.';

-- ------------------------------------------------------------
-- Idempotency keys
--
-- These exist to absorb client retries over minutes, not months.
-- ------------------------------------------------------------

create or replace function sweep_idempotency_keys()
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare removed int := 0;
begin
  delete from idempotency_keys where expires_at < now();
  get diagnostics removed = row_count;
  return removed;
end $$;

-- ------------------------------------------------------------
-- Carts
--
-- Guest carts are created by anonymous traffic and cleaned up by
-- nothing else, so this table grows with your bot traffic rather
-- than your revenue. Signed-in carts are kept longer: they are a
-- genuine re-marketing asset.
-- ------------------------------------------------------------

create or replace function sweep_carts(
  guest_age    interval default '30 days',
  customer_age interval default '180 days'
)
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare removed int := 0;
begin
  -- Mark before deleting, so abandoned-cart reporting keeps a signal.
  update carts
  set status = 'abandoned'
  where status = 'active'
    and updated_at < now() - interval '7 days';

  delete from carts
  where status <> 'converted'
    and ((customer_id is null and updated_at < now() - guest_age)
      or (customer_id is not null and updated_at < now() - customer_age));

  get diagnostics removed = row_count;
  return removed;
end $$;

-- ------------------------------------------------------------
-- Webhook events
--
-- Keep long enough to answer "did that callback arrive?", not
-- forever. Unprocessed rows are never swept: those are incidents.
-- ------------------------------------------------------------

create or replace function sweep_webhook_events(keep interval default '90 days')
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare removed int := 0;
begin
  delete from webhook_events
  where processed_at is not null
    and received_at < now() - keep;
  get diagnostics removed = row_count;
  return removed;
end $$;

-- ------------------------------------------------------------
-- Notifications
--
-- message_log is deliberately NOT swept here: it is the evidence
-- that you did send the order confirmation the customer says never
-- arrived. Only the in-app feed is trimmed.
-- ------------------------------------------------------------

create or replace function sweep_notifications(keep interval default '90 days')
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare removed int := 0;
begin
  delete from notifications
  where read_at is not null
    and created_at < now() - keep;
  get diagnostics removed = row_count;
  return removed;
end $$;
-- ------------------------------------------------------------
-- Manual stock movements
--
-- Receiving, counting, writing off. Everything a warehouse does to the
-- ledger by hand, and nothing checkout does to it automatically.
--
-- created_by comes from auth.uid(), never from a parameter: an
-- adjustment nobody is attached to is an adjustment nobody has to
-- explain. The note is mandatory for the same reason -- "stock count
-- 2026-08-01: two units unaccounted for" is the difference between a
-- ledger and a rumour.
-- ------------------------------------------------------------

create or replace function record_stock_movement(
  p_variant_id uuid,
  p_quantity   int,
  p_reason     text,
  p_note       text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := require_staff();
  mid uuid;
begin
  if p_reason not in ('purchase', 'adjustment', 'damage', 'return') then
    raise exception
      'Stock can be received, adjusted, written off or returned here, not %.', p_reason
      using errcode = 'ECOM1', hint = 'reason_not_allowed';
  end if;
  if p_quantity = 0 then
    raise exception 'A movement of zero changes nothing.'
      using errcode = 'ECOM1', hint = 'zero_quantity';
  end if;
  if p_reason = 'purchase' and p_quantity < 0 then
    raise exception 'Receiving stock adds it. Use a positive quantity.'
      using errcode = 'ECOM1', hint = 'wrong_sign';
  end if;
  if p_reason = 'damage' and p_quantity > 0 then
    raise exception 'Writing off stock removes it. Use a negative quantity.'
      using errcode = 'ECOM1', hint = 'wrong_sign';
  end if;
  if p_note is null or btrim(p_note) = '' then
    raise exception 'Say why. Every manual movement needs a note.'
      using errcode = 'ECOM1', hint = 'note_required';
  end if;

  -- No stock arithmetic here. apply_inventory_movement() maintains
  -- product_variants.stock from this row, in this transaction, and the
  -- CHECK (stock >= 0) is what refuses an adjustment that would take a
  -- variant negative.
  insert into inventory_movements (variant_id, quantity, reason, note, created_by)
  values (p_variant_id, p_quantity, p_reason, btrim(p_note), uid)
  returning id into mid;

  return mid;
end $$;

-- ------------------------------------------------------------
-- Reservation monitor
--
-- The number that matters is `stranded`: holds that expired and were
-- never released. In a healthy system it is zero, because the sweeper
-- runs every few minutes. Any other number means the sweeper is not
-- running, and that stock is unsellable until someone notices.
--
-- `sweeper_schedule` is null when pg_cron is not installed, which is a
-- finding rather than an error -- it is exactly the state the live
-- database was in. `last_auto_release` is a proxy: a sweeper that runs
-- and finds nothing leaves no trace, so it answers "when did it last
-- have work" rather than "when did it last run".
-- ------------------------------------------------------------

create or replace function inventory_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  uid       uuid := require_staff();
  held      record;
  stranded  record;
  last_run  timestamptz;
  sched     text;
begin
  select count(*) as n, coalesce(sum(-m.quantity), 0) as units into held
  from inventory_movements m
  where m.reason = 'reservation'
    and (m.expires_at is null or m.expires_at >= now())
    and not exists (select 1 from inventory_movements c where c.reservation_id = m.id);

  select count(*) as n, coalesce(sum(-m.quantity), 0) as units,
         min(m.expires_at) as oldest into stranded
  from inventory_movements m
  where m.reason = 'reservation'
    and m.expires_at < now()
    and not exists (select 1 from inventory_movements c where c.reservation_id = m.id);

  select max(created_at) into last_run
  from inventory_movements
  where reason = 'release' and note = 'auto-released: reservation expired';

  if to_regclass('cron.job') is not null then
    execute $q$
      select schedule from cron.job
      where command ilike '%release_expired_reservations%' limit 1
    $q$ into sched;
  end if;

  return jsonb_build_object(
    'held_reservations',      held.n,
    'held_units',             held.units,
    'stranded_reservations',  stranded.n,
    'stranded_units',         stranded.units,
    'oldest_stranded_at',     stranded.oldest,
    'last_auto_release',      last_run,
    'sweeper_scheduled',      sched is not null,
    'sweeper_schedule',       sched,
    'sweeper_installed',      to_regproc('release_expired_reservations') is not null);
end $$;

revoke execute on function record_stock_movement(uuid, int, text, text) from public;
revoke execute on function inventory_health()                           from public;
grant  execute on function record_stock_movement(uuid, int, text, text) to authenticated;
grant  execute on function inventory_health()                           to authenticated;

-- The sweepers delete rows and move stock. Nothing signed-in should be
-- able to call them; they belong to cron and to an operator at a psql
-- prompt.
revoke execute on function release_expired_reservations()        from public;
revoke execute on function sweep_idempotency_keys()              from public;
revoke execute on function sweep_carts(interval, interval)       from public;
revoke execute on function sweep_webhook_events(interval)        from public;
revoke execute on function sweep_notifications(interval)         from public;



-- ============================================================
-- SOURCE: 20260801001700_returns_wallet.sql
-- ============================================================

-- ============================================================
-- 0017  Returns, refunds, store credit and gift cards
--
-- The phase where money goes back out, so every function here is
-- written to refuse rather than to reconcile. A refund that exceeds
-- what was captured, a return of more than was bought, a gift card
-- spent twice: none of them can be undone by an apology.
--
-- One schema gap is closed first, found by trying to use what B6 built:
-- payments.provider_payment_ref. Razorpay's refund API takes the PAYMENT
-- id, while provider_ref holds the gateway ORDER id -- which is what the
-- webhook resolves against. One column cannot be both, and without the
-- second one no refund can be issued at all.
--
-- api-plan B8 also asks for "provider ref unique" on refunds. The
-- baseline already has it (uniq_refund_provider_ref), so there is
-- nothing to add: a redelivered refund callback already cannot record
-- the same refund twice.
-- ============================================================


alter table payments add column if not exists provider_payment_ref text;

comment on column payments.provider_payment_ref is
  'The gateway PAYMENT id, as opposed to provider_ref which holds the gateway '
  'ORDER id. Refunds are issued against this one; webhooks resolve against the '
  'other. Kept apart because a refund issued against the wrong identifier '
  'fails at the gateway, and a webhook resolved against the wrong one silently '
  'captures the wrong order.';

-- ------------------------------------------------------------
-- capture_payment gains the payment id
--
-- Dropped and recreated rather than replaced: adding a parameter to
-- create-or-replace makes an overload, and two capture_payment
-- functions differing by one argument is exactly the ambiguity that
-- gets the wrong one called at 3am.
-- ------------------------------------------------------------

drop function if exists capture_payment(uuid, text, text, numeric);

create or replace function capture_payment(
  p_order_id           uuid,
  p_provider           text,
  p_provider_ref       text,
  p_amount             numeric default null,
  p_provider_payment_ref text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o     orders%rowtype;
  res   record;
  pay   uuid;
  n_res int;
begin
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'P0002';
  end if;

  if o.status <> 'pending' then
    return false;
  end if;

  if p_amount is not null and p_amount <> o.grand_total then
    raise exception
      'gateway captured % against an order of %', p_amount, o.grand_total
      using errcode = 'ECOM2', hint = 'amount_mismatch';
  end if;

  n_res := 0;
  for res in
    select m.id, m.variant_id, m.quantity
    from inventory_movements m
    where m.order_id = p_order_id
      and m.reason = 'reservation'
      and not exists (
        select 1 from inventory_movements c where c.reservation_id = m.id)
  loop
    insert into inventory_movements (variant_id, quantity, reason, order_id, reservation_id)
    values (res.variant_id, -res.quantity, 'release', p_order_id, res.id);

    insert into inventory_movements (variant_id, quantity, reason, order_id)
    values (res.variant_id, res.quantity, 'sale', p_order_id);

    n_res := n_res + 1;
  end loop;

  -- The hold lapsed before the money landed. Taking the stock now is
  -- the difference between an oversell that is loud and one that is
  -- invisible until somebody counts the shelf.
  if n_res = 0 then
    insert into inventory_movements (variant_id, quantity, reason, order_id, note)
    select oi.variant_id, -oi.quantity, 'sale', p_order_id,
           'reservation expired before capture'
    from order_items oi
    where oi.order_id = p_order_id and oi.variant_id is not null;
  end if;

  update payments
  set status = 'captured',
      provider_ref = coalesce(provider_ref, p_provider_ref),
      provider_payment_ref = coalesce(p_provider_payment_ref, provider_payment_ref),
      updated_at = now()
  where order_id = p_order_id and provider = p_provider and status <> 'captured'
  returning id into pay;

  if pay is null then
    insert into payments (order_id, provider, provider_ref, provider_payment_ref,
                          amount, status)
    values (p_order_id, p_provider, p_provider_ref, p_provider_payment_ref,
            o.grand_total, 'captured')
    on conflict do nothing;
  end if;

  update orders set status = 'paid', updated_at = now() where id = p_order_id;

  insert into order_events (order_id, event, from_status, to_status, note, actor_type)
  values (p_order_id, 'payment_captured', o.status, 'paid', p_provider, 'system');

  return true;
end $$;

-- ------------------------------------------------------------
-- A customer opens a return
--
-- SECURITY INVOKER, deliberately. RLS already says exactly the right
-- thing -- own_returns_i pins status to 'requested' and requires the
-- order to be the caller's, own_return_items_i pins condition to null
-- so a customer cannot grade their own goods -- and a definer function
-- would throw all of that away and have to reimplement it worse.
--
-- What it adds is the one thing RLS cannot: the request and its lines
-- in a single transaction. Two PostgREST calls means a return that
-- exists with no lines, which reads to staff as an empty claim.
-- ------------------------------------------------------------

create or replace function request_return(
  p_order_id uuid,
  p_items    jsonb,     -- [{"order_item_id": uuid, "quantity": int}]
  p_reason   text
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare rid uuid;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Choose at least one item to return.'
      using errcode = 'ECOM1', hint = 'no_items';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'Tell us why you are returning it.'
      using errcode = 'ECOM1', hint = 'reason_required';
  end if;

  insert into return_requests (order_id, customer_id, reason)
  values (p_order_id, auth.uid(), btrim(p_reason))
  returning id into rid;

  -- enforce_return_quantity() counts every other return of the same
  -- line, so returning two lots of one unit against a one-unit line is
  -- refused on the second.
  insert into return_items (return_id, order_item_id, order_id, quantity)
  select rid, (e ->> 'order_item_id')::uuid, p_order_id, (e ->> 'quantity')::int
  from jsonb_array_elements(p_items) e;

  return rid;
end $$;

-- ------------------------------------------------------------
-- Staff decide
-- ------------------------------------------------------------

create or replace function admin_review_return(
  p_return_id uuid,
  p_decision  text,     -- 'approved' | 'rejected' | 'pickup_scheduled'
  p_note      text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := require_staff();
  r   return_requests%rowtype;
begin
  if p_decision not in ('approved', 'rejected', 'pickup_scheduled') then
    raise exception 'Unknown decision %.', p_decision
      using errcode = 'ECOM1', hint = 'unknown_decision';
  end if;

  select * into r from return_requests where id = p_return_id for update;
  if not found then
    raise exception 'return % not found', p_return_id using errcode = 'P0002';
  end if;

  -- Once the goods are back, or the money has gone, the decision is
  -- made. Reopening it here would let a rejection undo a refund.
  if r.status in ('received', 'refunded', 'closed') then
    raise exception 'This return is already %.', r.status
      using errcode = 'ECOM2', hint = 'return_settled';
  end if;
  if r.status = 'rejected' and p_decision <> 'approved' then
    raise exception 'This return was already rejected.'
      using errcode = 'ECOM2', hint = 'return_settled';
  end if;

  update return_requests
  set status = p_decision,
      note = coalesce(p_note, note),
      updated_at = now(),
      resolved_at = case when p_decision = 'rejected' then now() else resolved_at end
  where id = p_return_id;

  insert into order_events (order_id, event, note, actor_type, actor_id)
  values (r.order_id, 'return_' || p_decision, p_note, 'staff', uid);
end $$;

-- ------------------------------------------------------------
-- Money back out
--
-- Records the intent, and nothing else. The gateway call happens
-- afterwards in the API, for the same reason checkout does not call
-- Razorpay inside its transaction: an HTTP call held open inside a
-- database transaction turns a gateway timeout into a rolled-back
-- refund the customer was already told about.
--
-- So a refunds row is written 'initiated' first. If the gateway call
-- then fails, the row survives as a visible, retryable record instead
-- of the refund vanishing.
-- ------------------------------------------------------------

create or replace function admin_refund(
  p_order_id  uuid,
  p_amount    numeric,
  p_return_id uuid default null,
  p_note      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid          uuid := require_staff();
  o            orders%rowtype;
  pay          payments%rowtype;
  already      numeric(12,2);
  refund_id    uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'A refund has to be for more than nothing.'
      using errcode = 'ECOM1', hint = 'invalid_amount';
  end if;

  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'P0002';
  end if;
  if o.status = 'pending' then
    raise exception 'Nothing has been captured for this order yet.'
      using errcode = 'ECOM2', hint = 'nothing_to_refund';
  end if;

  -- The captured payment is the only thing a refund can go back
  -- against: refunding to a different instrument is how money leaves
  -- without a trail.
  select * into pay from payments
  where order_id = p_order_id and status = 'captured'
  order by created_at limit 1;
  if not found then
    raise exception 'No captured payment to refund against.'
      using errcode = 'ECOM2', hint = 'no_captured_payment';
  end if;

  -- 'failed' refunds do not count: that money never left.
  select coalesce(sum(amount), 0) into already
  from refunds
  where order_id = p_order_id and status in ('initiated', 'processed');

  if already + p_amount > o.grand_total then
    raise exception
      'Refunding % would take the total refunded to % on an order of %.',
      p_amount, already + p_amount, o.grand_total
      using errcode = 'ECOM2', hint = 'over_refund';
  end if;

  insert into refunds (order_id, payment_id, return_id, amount, status)
  values (p_order_id, pay.id, p_return_id, p_amount, 'initiated')
  returning id into refund_id;

  insert into order_events (order_id, event, note, actor_type, actor_id)
  values (p_order_id, 'refund_initiated',
          coalesce(p_note, p_amount::text), 'staff', uid);

  return jsonb_build_object(
    'refund_id',            refund_id,
    'payment_id',           pay.id,
    'provider',             pay.provider,
    'provider_payment_ref', pay.provider_payment_ref,
    'amount',               p_amount,
    'refunded_to_date',     already + p_amount,
    'order_total',          o.grand_total,
    'fully_refunded',       (already + p_amount) >= o.grand_total);
end $$;

-- ------------------------------------------------------------
-- Settling a refund
--
-- Split from admin_refund so the gateway's answer can be recorded
-- whether it arrives inline or by webhook later.
-- ------------------------------------------------------------

create or replace function settle_refund(
  p_refund_id    uuid,
  p_status       text,        -- 'processed' | 'failed'
  p_provider_ref text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r  refunds%rowtype;
  o  orders%rowtype;
  paid_back numeric(12,2);
begin
  if p_status not in ('processed', 'failed') then
    raise exception 'A refund settles as processed or failed, not %.', p_status
      using errcode = 'ECOM1', hint = 'unknown_status';
  end if;

  select * into r from refunds where id = p_refund_id for update;
  if not found then
    raise exception 'refund % not found', p_refund_id using errcode = 'P0002';
  end if;
  if r.status <> 'initiated' then
    return;                    -- a redelivered callback; already settled
  end if;

  update refunds
  set status = p_status, provider_ref = coalesce(p_provider_ref, provider_ref),
      updated_at = now()
  where id = p_refund_id;

  if p_status <> 'processed' then
    return;
  end if;

  select * into o from orders where id = r.order_id for update;
  select coalesce(sum(amount), 0) into paid_back
  from refunds where order_id = r.order_id and status = 'processed';

  -- Only a full refund moves the order. A partial one leaves it where
  -- it is, because 'refunded' on a part-refunded order tells the
  -- warehouse to stop shipping goods the customer is still owed.
  if paid_back >= o.grand_total and o.status <> 'refunded' then
    update orders set status = 'refunded', updated_at = now() where id = o.id;
    insert into order_events (order_id, event, from_status, to_status, actor_type)
    values (o.id, 'refunded', o.status, 'refunded', 'system');
  end if;

  if r.return_id is not null then
    update return_requests
    set status = 'refunded', resolved_at = now(), updated_at = now()
    where id = r.return_id and status <> 'refunded';
  end if;
end $$;

-- ------------------------------------------------------------
-- Store credit
--
-- The ledger is append-only, and the balance is a view over it. There
-- is no balance column to correct, which is the point: a wrong entry
-- is fixed by a compensating entry, and both stay visible.
-- ------------------------------------------------------------

create or replace function admin_grant_credit(
  p_customer_id uuid,
  p_delta       numeric,
  p_reason      text,
  p_note        text,
  p_expires_at  timestamptz default null
)
returns numeric              -- the balance afterwards
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := require_staff();
  bal numeric(12,2);
begin
  -- return_credit and gift_card_redemption are written by the flows
  -- that earn them. Granting one by hand would invent a return or a
  -- card that does not exist.
  if p_reason not in ('goodwill', 'promotion', 'adjustment', 'expiry') then
    raise exception 'Credit can be granted as goodwill, promotion, adjustment or expiry, not %.',
      p_reason using errcode = 'ECOM1', hint = 'reason_not_allowed';
  end if;
  if p_delta = 0 then
    raise exception 'A credit entry of zero changes nothing.'
      using errcode = 'ECOM1', hint = 'zero_delta';
  end if;
  if p_note is null or btrim(p_note) = '' then
    raise exception 'Say why. Every credit entry needs a note.'
      using errcode = 'ECOM1', hint = 'note_required';
  end if;

  select coalesce(sum(delta), 0) into bal
  from credit_ledger
  where customer_id = p_customer_id
    and (expires_at is null or expires_at > now());

  if bal + p_delta < 0 then
    raise exception 'That would take the balance below zero (currently %).', bal
      using errcode = 'ECOM2', hint = 'insufficient_credit';
  end if;

  insert into credit_ledger (customer_id, delta, reason, note, expires_at, created_by)
  values (p_customer_id, p_delta, p_reason, btrim(p_note), p_expires_at, uid);

  return bal + p_delta;
end $$;

-- ------------------------------------------------------------
-- Gift card codes
--
-- NOTE THE search_path ON THE NEXT THREE FUNCTIONS. pgcrypto lives in
-- the `extensions` schema on Supabase, not in public -- the baseline's
-- `create extension if not exists pgcrypto` was a no-op because the
-- image had already installed it there. With `search_path = public,
-- pg_temp` alone, digest() and gen_random_bytes() are simply invisible
-- and every gift card operation fails with "function does not exist".
--
-- A schema named in search_path that does not exist is ignored, so
-- naming `extensions` is safe on a plain Postgres where pgcrypto went
-- into public. pg_temp stays LAST either way.
--
-- The alphabet drops 0/O, 1/I/L and everything else a person reads
-- back wrongly over the phone, because these get read back over the
-- phone. 16 characters of a 25-symbol alphabet is about 74 bits.
--
-- Rejection sampling rather than a plain modulo: 256 does not divide
-- by 25, so `byte % 25` favours the first six symbols. It would not
-- matter at this length, and it costs two lines not to have to think
-- about whether it matters.
-- ------------------------------------------------------------

create or replace function generate_gift_card_code()
returns text
language plpgsql
volatile
set search_path = public, extensions, pg_temp
as $$
declare
  alphabet text := 'ACDEFGHJKMNPQRTUVWXY34679';   -- 25 symbols
  n        int  := length(alphabet);
  cap      int  := 256 - (256 % n);               -- 250
  code     text := '';
  b        int;
begin
  while length(code) < 16 loop
    b := get_byte(gen_random_bytes(1), 0);
    if b < cap then
      code := code || substr(alphabet, 1 + (b % n), 1);
    end if;
  end loop;
  return code;
end $$;

-- ------------------------------------------------------------
-- Issue a gift card
--
-- Returns the plaintext code EXACTLY ONCE. Only digest(code,'sha256')
-- is stored, so this is the only moment the code exists anywhere the
-- store can see it -- lose it and the card has to be reissued. That is
-- the same bargain as a password, and for the same reason: a leaked
-- backup of gift_cards must not be a wallet full of money.
-- ------------------------------------------------------------

create or replace function admin_issue_gift_card(
  p_amount          numeric,
  p_recipient_email text default null,
  p_message         text default null,
  p_expires_at      timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  uid  uuid := require_staff();
  code text := generate_gift_card_code();
  gid  uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'A gift card has to be worth something.'
      using errcode = 'ECOM1', hint = 'invalid_amount';
  end if;

  insert into gift_cards (code_hash, last4, initial_balance, balance,
                          recipient_email, message, expires_at)
  values (digest(code, 'sha256'), right(code, 4), p_amount, p_amount,
          p_recipient_email, p_message, p_expires_at)
  returning id into gid;

  return jsonb_build_object(
    'gift_card_id', gid,
    'code',         code,          -- say it once
    'last4',        right(code, 4),
    'balance',      p_amount,
    'expires_at',   p_expires_at);
end $$;

-- ------------------------------------------------------------
-- Redeem a gift card
--
-- Converts the whole remaining balance into store credit for the
-- caller. Whole, not partial: a card with a balance and a customer
-- with a balance are two places money can be, and reconciling them is
-- work nobody asked for. The credit ledger already handles partial
-- spending.
--
-- SECURITY DEFINER because a customer must not be able to read
-- gift_cards -- own_gift_cards only shows cards they bought, and a
-- lookup by code has to happen where the caller cannot see the table.
--
-- Every failure says the same thing. "That card is expired" tells
-- someone guessing codes that they guessed one.
-- ------------------------------------------------------------

create or replace function redeem_gift_card(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  uid  uuid := auth.uid();
  card gift_cards%rowtype;
  bal  numeric(12,2);
begin
  if uid is null then
    raise exception 'Sign in to redeem a gift card.'
      using errcode = 'ECOM1', hint = 'sign_in_required';
  end if;
  if not exists (select 1 from customers c where c.id = uid) then
    raise exception 'Sign in to redeem a gift card.'
      using errcode = 'ECOM1', hint = 'sign_in_required';
  end if;

  select * into card from gift_cards
  where code_hash = digest(btrim(upper(coalesce(p_code, ''))), 'sha256')
  for update;

  if not found
     or card.status <> 'active'
     or card.balance <= 0
     or (card.expires_at is not null and card.expires_at <= now()) then
    raise exception 'That gift card cannot be redeemed.'
      using errcode = 'ECOM1', hint = 'invalid_gift_card';
  end if;

  -- Ledger first, and the trigger checks balance_after against what it
  -- computes. CHECK (balance >= 0) is what makes an overspend
  -- impossible rather than merely unlikely.
  insert into gift_card_transactions (gift_card_id, delta, balance_after)
  values (card.id, -card.balance, 0);

  update gift_cards set status = 'redeemed', updated_at = now() where id = card.id;

  insert into credit_ledger (customer_id, delta, reason, gift_card_id, note)
  values (uid, card.balance, 'gift_card_redemption', card.id,
          'gift card ending ' || card.last4);

  select coalesce(sum(delta), 0) into bal
  from credit_ledger
  where customer_id = uid and (expires_at is null or expires_at > now());

  return jsonb_build_object(
    'redeemed',      card.balance,
    'last4',         card.last4,
    'credit_balance', bal);
end $$;

revoke execute on function capture_payment(uuid, text, text, numeric, text) from public;
revoke execute on function settle_refund(uuid, text, text)                  from public;
revoke execute on function request_return(uuid, jsonb, text)                from public;
revoke execute on function admin_review_return(uuid, text, text)            from public;
revoke execute on function admin_refund(uuid, numeric, uuid, text)          from public;
revoke execute on function admin_grant_credit(uuid, numeric, text, text, timestamptz) from public;
revoke execute on function generate_gift_card_code()                        from public;
revoke execute on function admin_issue_gift_card(numeric, text, text, timestamptz) from public;
revoke execute on function redeem_gift_card(text)                           from public;

-- Capture and refund settlement act with no user present.
grant execute on function capture_payment(uuid, text, text, numeric, text) to service_role;
grant execute on function settle_refund(uuid, text, text)                  to service_role;

-- The staff-guarded ones are granted to `authenticated` because that
-- is the role a staff member's JWT carries; require_staff() inside
-- each is what actually contains them.
grant execute on function request_return(uuid, jsonb, text)                 to authenticated;
grant execute on function admin_review_return(uuid, text, text)             to authenticated;
grant execute on function admin_refund(uuid, numeric, uuid, text)           to authenticated;
grant execute on function admin_grant_credit(uuid, numeric, text, text, timestamptz) to authenticated;
grant execute on function admin_issue_gift_card(numeric, text, text, timestamptz)    to authenticated;
grant execute on function redeem_gift_card(text)                            to authenticated;



-- ============================================================
-- SOURCE: 20260801001800_invoicing.sql
-- ============================================================

-- ============================================================
-- 0018  GST invoicing: credit notes and the e-invoice stamp
--
-- An invoice is the one document here that a government reads. It
-- cannot be edited, it cannot be deleted, and its number cannot skip.
-- Everything below works around those three facts rather than against
-- them.
--
-- A mistake on an issued invoice is corrected by a CREDIT NOTE -- a
-- second document, positively valued, pointing at the first. That is
-- why admin_issue_credit_note exists and why there is no
-- admin_amend_invoice.
-- ============================================================


-- ------------------------------------------------------------
-- The e-invoice stamp is final once recorded
--
-- protect_invoice() already pinned the IRN. It did not pin ack_no,
-- ack_date or signed_qr, so the signed QR on a filed invoice could be
-- replaced after the fact while the IRN it belongs to stayed put --
-- which is precisely the tampering the signature exists to make
-- detectable.
--
-- pdf_url stays mutable on purpose: regenerating a PDF from unchanged
-- data is housekeeping, not an amendment.
-- ------------------------------------------------------------

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

  -- Once the IRP has answered, the whole stamp is the IRP's, not ours.
  if old.irn is not null and (
       new.irn       is distinct from old.irn
    or new.ack_no    is distinct from old.ack_no
    or new.ack_date  is distinct from old.ack_date
    or new.signed_qr is distinct from old.signed_qr) then
    raise exception
      'the e-invoice stamp is issued by the IRP and is final once recorded'
      using errcode = 'restrict_violation';
  end if;

  return new;
end $$;

-- ------------------------------------------------------------
-- Record what the IRP returned
--
-- Separate from issuing because the two happen minutes or hours
-- apart: the invoice is a legal document the moment it is numbered,
-- and the IRP is a third party that can be down.
-- ------------------------------------------------------------

create or replace function admin_stamp_einvoice(
  p_invoice_id uuid,
  p_irn        text,
  p_ack_no     text,
  p_ack_date   timestamptz,
  p_signed_qr  text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := require_staff();
  inv invoices%rowtype;
begin
  if p_irn is null or length(btrim(p_irn)) <> 64 then
    -- An IRN is the IRP's 64-character hash. A shorter one is a
    -- truncated paste, and it would be permanent.
    raise exception 'An IRN is 64 characters. That one is %.',
      coalesce(length(btrim(p_irn)), 0)
      using errcode = 'ECOM1', hint = 'invalid_irn';
  end if;

  select * into inv from invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'invoice % not found', p_invoice_id using errcode = 'P0002';
  end if;
  if inv.irn is not null then
    raise exception 'Invoice % is already stamped.', inv.invoice_number
      using errcode = 'ECOM2', hint = 'already_stamped';
  end if;

  update invoices
  set irn = btrim(p_irn), ack_no = p_ack_no,
      ack_date = coalesce(p_ack_date, now()), signed_qr = p_signed_qr
  where id = p_invoice_id;

  insert into order_events (order_id, event, note, actor_type, actor_id)
  values (inv.order_id, 'einvoice_stamped', inv.invoice_number, 'staff', uid);
end $$;

-- ------------------------------------------------------------
-- Credit note
--
-- The only way to correct an issued invoice. Positively valued and
-- of kind 'credit_note', which is how GST expects it: a negative
-- invoice is not a thing, a second document is.
--
-- Quantities are credited PRO RATA of the parent line's
-- taxable_value, not at unit_price * quantity. The parent line
-- already carries its share of the order discount, so crediting at
-- list price would refund tax on money the customer never paid.
--
-- Numbering comes from next_invoice_number(), the same series as tax
-- invoices. One consecutive series per financial year is what Rule 46
-- asks for; it does not require a separate one for credit notes. The
-- 'INV/' prefix on a credit note reads oddly and is left alone --
-- changing the format would renumber nothing and confuse everything
-- already filed.
-- ------------------------------------------------------------

create or replace function admin_issue_credit_note(
  p_parent_invoice_id uuid,
  p_lines             jsonb,     -- [{"invoice_line_id": uuid, "quantity": int}]
  p_reason            text,
  p_return_id         uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid         uuid := require_staff();
  parent      invoices%rowtype;
  s           store_settings%rowtype;
  same_state  boolean;
  credited    numeric(12,2);
  v_lines     jsonb;
  tot         record;
  note_id     uuid;
  note_no     text;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A credit note has to say what it is for.'
      using errcode = 'ECOM1', hint = 'reason_required';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Choose at least one line to credit.'
      using errcode = 'ECOM1', hint = 'no_lines';
  end if;

  select * into parent from invoices where id = p_parent_invoice_id for update;
  if not found then
    raise exception 'invoice % not found', p_parent_invoice_id using errcode = 'P0002';
  end if;
  if parent.kind <> 'tax_invoice' then
    raise exception 'A credit note is issued against a tax invoice, not against %.',
      parent.kind using errcode = 'ECOM1', hint = 'not_a_tax_invoice';
  end if;

  select * into s from store_settings where id = 1;
  same_state := (parent.place_of_supply = s.seller_state_code);

  -- Build the lines from the PARENT's, pro rata by quantity.
  select jsonb_agg(jsonb_build_object(
           'description',   pl.description,
           'hsn_code',      pl.hsn_code,
           'quantity',      req.quantity,
           'unit_price',    pl.unit_price,
           'taxable_value', t.taxable,
           'gst_rate',      pl.gst_rate,
           'cgst_amount',   case when same_state then t.half else 0 end,
           'sgst_amount',   case when same_state then t.half else 0 end,
           'igst_amount',   case when same_state then 0 else 2 * t.half end,
           'line_total',    t.taxable + 2 * t.half))
    into v_lines
  from jsonb_to_recordset(p_lines) as req(invoice_line_id uuid, quantity int)
  join invoice_lines pl on pl.id = req.invoice_line_id
                       and pl.invoice_id = p_parent_invoice_id
  cross join lateral (
    select round(pl.taxable_value * req.quantity / pl.quantity, 2) as taxable
  ) b
  cross join lateral (
    -- The same half that checkout and admin_issue_invoice use, so a
    -- credit note reverses exactly what was charged.
    select b.taxable,
           round(b.taxable * pl.gst_rate / 200, 2) as half
  ) t
  where req.quantity > 0 and req.quantity <= pl.quantity;

  if v_lines is null or jsonb_array_length(v_lines) <> jsonb_array_length(p_lines) then
    raise exception 'One or more lines are not on that invoice, or credit more than was billed.'
      using errcode = 'ECOM1', hint = 'invalid_lines';
  end if;

  select sum(taxable_value) as taxable, sum(cgst_amount) as cgst,
         sum(sgst_amount) as sgst, sum(igst_amount) as igst, sum(line_total) as total
    into tot
  from jsonb_to_recordset(v_lines) as x(
    taxable_value numeric, cgst_amount numeric,
    sgst_amount numeric, igst_amount numeric, line_total numeric);

  -- Credit notes against one invoice cannot exceed it. Crediting more
  -- than was charged is a refund of money that never arrived, and the
  -- return would be filed as input credit the buyer is not owed.
  select coalesce(sum(grand_total), 0) into credited
  from invoices where parent_invoice_id = p_parent_invoice_id and kind = 'credit_note';

  if credited + tot.total > parent.grand_total then
    raise exception
      'Crediting % would take the total credited to % against an invoice of %.',
      tot.total, credited + tot.total, parent.grand_total
      using errcode = 'ECOM2', hint = 'over_credit';
  end if;

  -- Number and document in one transaction: a rollback takes the
  -- number with it, which is what keeps the series gap-free.
  note_no := next_invoice_number();

  insert into invoices (
    invoice_number, order_id, kind, parent_invoice_id,
    customer_name, customer_gstin, billing_address,
    seller_gstin, place_of_supply,
    taxable_value, cgst_total, sgst_total, igst_total, grand_total)
  values (
    note_no, parent.order_id, 'credit_note', parent.id,
    parent.customer_name, parent.customer_gstin, parent.billing_address,
    parent.seller_gstin, parent.place_of_supply,
    tot.taxable, tot.cgst, tot.sgst, tot.igst, tot.total)
  returning id into note_id;

  insert into invoice_lines (
    invoice_id, description, hsn_code, quantity, unit_price,
    taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount, line_total)
  select note_id, x.description, x.hsn_code, x.quantity, x.unit_price,
         x.taxable_value, x.gst_rate, x.cgst_amount, x.sgst_amount,
         x.igst_amount, x.line_total
  from jsonb_to_recordset(v_lines) as x(
    description text, hsn_code text, quantity int, unit_price numeric,
    taxable_value numeric, gst_rate numeric, cgst_amount numeric,
    sgst_amount numeric, igst_amount numeric, line_total numeric);

  insert into order_events (order_id, event, note, actor_type, actor_id)
  values (parent.order_id, 'credit_note_issued',
          note_no || ': ' || btrim(p_reason), 'staff', uid);

  if p_return_id is not null then
    update return_requests set updated_at = now() where id = p_return_id;
  end if;

  return note_id;
end $$;

revoke execute on function admin_stamp_einvoice(uuid, text, text, timestamptz, text) from public;
revoke execute on function admin_issue_credit_note(uuid, jsonb, text, uuid)           from public;
grant  execute on function admin_stamp_einvoice(uuid, text, text, timestamptz, text) to authenticated;
grant  execute on function admin_issue_credit_note(uuid, jsonb, text, uuid)           to authenticated;



-- ============================================================
-- SOURCE: 20260801001900_support.sql
-- ============================================================

-- ============================================================
-- 0019  Customers, support and engagement
--
-- Opens with a security fix, because B10 is where the hole became
-- reachable.
--
-- anonymize_customer() is SECURITY DEFINER, takes a customer id, and
-- has no authorisation check of any kind. Migration 0012 granted it to
-- `authenticated` so the API could call it. Between them, any signed-in
-- shopper could scrub any other customer: name replaced, email
-- replaced, phone nulled, addresses and consent and wishlist and stock
-- alerts removed, every order address redacted. Irreversible, silent,
-- and reproducible in three lines of SQL.
--
-- The rest of this migration is the small amount that RLS cannot do on
-- its own: making a ticket and its first message one transaction, and
-- letting staff act on tickets in a way that keeps the SLA clock
-- honest.
-- ============================================================


-- ------------------------------------------------------------
-- Who is asking, and are they senior enough
-- ------------------------------------------------------------

create or replace function staff_has_role(variadic p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from staff_users s
    where s.id = auth.uid() and s.is_active and s.role = any(p_roles)
  )
$$;

comment on function staff_has_role(text[]) is
  'Role gate for the few operations where role is a real boundary rather '
  'than a UX hint. RLS still ignores staff_users.role everywhere else -- see '
  'the accepted risk in README.';

-- ------------------------------------------------------------
-- Erasure, with an owner
--
-- DPDP gives a person an erasure right over THEIR OWN data, so
-- self-service stays: a customer may scrub themselves. Anyone else
-- doing it is a staff decision, and not a junior one -- it destroys
-- personal data and cannot be undone, so it is owner or admin.
--
-- The check has to live in the function, not in the API. Every staff
-- member can reach PostgREST directly with their own JWT, so a guard
-- in a route handler is advice.
-- ------------------------------------------------------------

create or replace function anonymize_customer(p_customer_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Sign in first.'
      using errcode = 'ECOM1', hint = 'sign_in_required';
  end if;

  if uid <> p_customer_id and not staff_has_role('owner', 'admin') then
    -- Deliberately says nothing about whether that customer exists.
    raise exception 'You cannot erase that account.'
      using errcode = '42501', hint = 'forbidden';
  end if;

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

comment on function anonymize_customer(uuid) is
  'DPDP erasure. Scrubs PII while retaining orders, invoices and the credit '
  'ledger. A customer may erase themselves; anyone else needs the owner or '
  'admin role. Call this BEFORE removing the auth.users row -- customers.id '
  'has ON DELETE RESTRICT precisely so an unscrubbed removal fails loudly.';

-- ------------------------------------------------------------
-- Opening a ticket
--
-- SECURITY INVOKER, so own_tickets_i keeps doing the work it already
-- does: status pinned to 'open', priority to 'normal', assigned_to
-- null, and an attached order has to be the caller's own. A definer
-- function would discard all of that.
--
-- What it adds is atomicity. A ticket with no message is an agent
-- opening a blank conversation and having to ask what it is about.
-- ------------------------------------------------------------

create or replace function open_ticket(
  p_subject  text,
  p_body     text,
  p_category text default 'general',
  p_order_id uuid default null
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare tid uuid;
begin
  if p_subject is null or btrim(p_subject) = '' then
    raise exception 'A ticket needs a subject.'
      using errcode = 'ECOM1', hint = 'subject_required';
  end if;
  if p_body is null or btrim(p_body) = '' then
    raise exception 'Tell us what happened.'
      using errcode = 'ECOM1', hint = 'body_required';
  end if;

  insert into support_tickets (customer_id, order_id, subject, category)
  values (auth.uid(), p_order_id, btrim(p_subject), p_category)
  returning id into tid;

  -- own_ticket_msgs_i pins is_internal to false and sender to the
  -- caller, so a customer cannot open a ticket with a staff note on it.
  insert into ticket_messages (ticket_id, sender_type, sender_id, body)
  values (tid, 'customer', auth.uid(), btrim(p_body));

  return tid;
end $$;

-- ------------------------------------------------------------
-- Replying
--
-- first_response_at is the SLA clock, and it is stamped here rather
-- than left to the API because an agent who replies through PostgREST
-- directly would otherwise never start it. Internal notes do not stop
-- the clock: the customer has not been answered.
-- ------------------------------------------------------------

create or replace function admin_reply_ticket(
  p_ticket_id   uuid,
  p_body        text,
  p_is_internal boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := require_staff();
  t   support_tickets%rowtype;
  mid uuid;
begin
  if p_body is null or btrim(p_body) = '' then
    raise exception 'An empty reply is not a reply.'
      using errcode = 'ECOM1', hint = 'body_required';
  end if;

  select * into t from support_tickets where id = p_ticket_id for update;
  if not found then
    raise exception 'ticket % not found', p_ticket_id using errcode = 'P0002';
  end if;
  if t.status = 'closed' then
    raise exception 'Ticket % is closed. Reopen it first.', t.ticket_number
      using errcode = 'ECOM2', hint = 'ticket_closed';
  end if;

  insert into ticket_messages (ticket_id, sender_type, sender_id, body, is_internal)
  values (p_ticket_id, 'staff', uid, btrim(p_body), coalesce(p_is_internal, false))
  returning id into mid;

  update support_tickets
  set first_response_at = case
        when first_response_at is null and not coalesce(p_is_internal, false)
        then now() else first_response_at end,
      status = case
        when coalesce(p_is_internal, false) then status
        else 'pending_customer' end,
      updated_at = now()
  where id = p_ticket_id;

  return mid;
end $$;

-- ------------------------------------------------------------
-- Triaging
--
-- Priority, assignment and status are staff-only by RLS already
-- (own_tickets_i pins them at insert and there is no customer UPDATE
-- policy at all). This exists to keep resolved_at truthful, which a
-- raw UPDATE would not.
-- ------------------------------------------------------------

create or replace function admin_update_ticket(
  p_ticket_id   uuid,
  p_status      text default null,
  p_priority    text default null,
  p_assigned_to uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := require_staff();
  t   support_tickets%rowtype;
begin
  if p_status is not null
     and p_status not in ('open', 'pending_customer', 'pending_internal', 'resolved', 'closed') then
    raise exception 'Unknown ticket status %.', p_status
      using errcode = 'ECOM1', hint = 'unknown_status';
  end if;
  if p_priority is not null and p_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'Unknown priority %.', p_priority
      using errcode = 'ECOM1', hint = 'unknown_priority';
  end if;

  select * into t from support_tickets where id = p_ticket_id for update;
  if not found then
    raise exception 'ticket % not found', p_ticket_id using errcode = 'P0002';
  end if;

  update support_tickets
  set status      = coalesce(p_status, status),
      priority    = coalesce(p_priority, priority),
      assigned_to = coalesce(p_assigned_to, assigned_to),
      resolved_at = case
        when coalesce(p_status, status) in ('resolved', 'closed')
        then coalesce(resolved_at, now())
        -- Reopening clears it, or "time to resolution" counts the first
        -- attempt and ignores the three that followed.
        else null end,
      updated_at = now()
  where id = p_ticket_id;
end $$;

revoke execute on function staff_has_role(text[])                      from public;
revoke execute on function open_ticket(text, text, text, uuid)         from public;
revoke execute on function admin_reply_ticket(uuid, text, boolean)     from public;
revoke execute on function admin_update_ticket(uuid, text, text, uuid) from public;

grant execute on function staff_has_role(text[])                       to authenticated;
grant execute on function open_ticket(text, text, text, uuid)          to authenticated;
grant execute on function admin_reply_ticket(uuid, text, boolean)      to authenticated;
grant execute on function admin_update_ticket(uuid, text, text, uuid)  to authenticated;



-- ============================================================
-- SOURCE: 20260801002000_jobs.sql
-- ============================================================

-- ============================================================
-- 0020  The outbox drain
--
-- checkout() writes the order confirmation into message_log in the same
-- transaction as the order. That is the outbox pattern, and it is the
-- half that was already built: if the mail provider is down, the row
-- simply stays 'queued' and the sale is unaffected.
--
-- This is the other half -- something that picks those rows up. Without
-- it every confirmation ever queued sits there forever, which is the
-- state the live database is in right now: eight queued messages and
-- nothing that reads them.
--
-- The whole design question is how two API instances draining at once
-- avoid sending the same email twice. The answer is a claim: one
-- statement moves a batch to 'sending' under FOR UPDATE SKIP LOCKED, so
-- a second drainer sees neither the locked rows nor, afterwards, the
-- claimed ones.
--
-- That needs a state the CHECK constraint did not allow, so the
-- constraint gains one -- and with it the obligation to notice rows that
-- got stuck there when a drainer died mid-send. requeue_stalled_messages()
-- is that obligation, and it belongs with the other sweepers.
-- ============================================================


alter table message_log drop constraint message_log_status_check;

alter table message_log add constraint message_log_status_check
  check (status in ('queued', 'sending', 'sent', 'delivered', 'bounced', 'failed'));

-- When the current drainer took it, which is NOT created_at.
--
-- Rescuing stalled rows by age-since-queued would requeue a message that
-- was queued last week and claimed four seconds ago -- while a drainer
-- is still mid-send. The second copy would go out. The stall clock has
-- to start at the claim.
alter table message_log add column if not exists claimed_at timestamptz;

comment on column message_log.claimed_at is
  'Set by claim_outbox() each time a drainer takes the row. '
  'requeue_stalled_messages() measures from here, not from created_at.';

comment on column message_log.status is
  'queued -> sending -> sent -> delivered, or bounced/failed. `sending` is '
  'held only for the length of one provider call; requeue_stalled_messages() '
  'returns anything left there by a drainer that died.';

-- ------------------------------------------------------------
-- Claim a batch
--
-- FOR UPDATE SKIP LOCKED is what makes this safe to run from every API
-- instance at once: a row already being claimed elsewhere is skipped
-- rather than waited for, so two drainers split the queue instead of
-- queuing behind each other.
--
-- attempts is incremented at CLAIM time, not at failure. A message that
-- makes the process die on every attempt would otherwise look untried
-- forever, and that is exactly the message worth noticing.
-- ------------------------------------------------------------

create or replace function claim_outbox(p_limit int default 20)
returns table (
  id          uuid,
  channel     text,
  template    text,
  recipient   text,
  payload     jsonb,
  order_id    uuid,
  customer_id uuid,
  attempts    int
)
language sql
set search_path = public, pg_temp
as $$
  with claimed as (
    select m.id
    from message_log m
    where m.status = 'queued'
    order by m.created_at
    limit greatest(1, least(coalesce(p_limit, 20), 200))
    for update skip locked
  )
  update message_log m
  set status = 'sending', attempts = m.attempts + 1, claimed_at = now()
  from claimed c
  where m.id = c.id
  returning m.id, m.channel, m.template, m.recipient, m.payload,
            m.order_id, m.customer_id, m.attempts;
$$;

-- ------------------------------------------------------------
-- Record how it went
--
-- A failure goes back to 'queued', not to 'failed', until it has been
-- tried enough times to call it: a provider having a bad minute is not
-- a message that cannot be delivered. p_give_up_after is the line
-- between the two, and crossing it is the only way a row stops being
-- retried.
-- ------------------------------------------------------------

create or replace function settle_message(
  p_id             uuid,
  p_sent           boolean,
  p_provider       text default null,
  p_provider_ref   text default null,
  p_error          text default null,
  p_give_up_after  int default 5
)
returns text                      -- the status it landed on
language plpgsql
set search_path = public, pg_temp
as $$
declare m message_log%rowtype; next_status text;
begin
  select * into m from message_log where id = p_id for update;
  if not found then
    raise exception 'message % not found', p_id using errcode = 'P0002';
  end if;

  if p_sent then
    next_status := 'sent';
  elsif m.attempts >= p_give_up_after then
    next_status := 'failed';
  else
    next_status := 'queued';
  end if;

  update message_log
  set status       = next_status,
      provider     = coalesce(p_provider, provider),
      provider_ref = coalesce(p_provider_ref, provider_ref),
      error        = case when p_sent then null else p_error end,
      sent_at      = case when p_sent then now() else sent_at end
  where id = p_id;

  return next_status;
end $$;

-- ------------------------------------------------------------
-- Rescue whatever a dead drainer left behind
--
-- A row in 'sending' with nobody sending it is invisible to the claim
-- query forever. This is the only thing that gets it back, which is why
-- it is scheduled rather than left to a person to remember.
--
-- The interval has to be longer than the slowest provider call, or this
-- requeues a message that is still in flight and sends it twice.
-- ------------------------------------------------------------

create or replace function requeue_stalled_messages(p_older_than interval default '10 minutes')
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare n int;
begin
  update message_log
  set status = 'queued',
      error  = 'requeued after a drainer stalled'
  where status = 'sending'
    -- coalesce for rows claimed before claimed_at existed; a null there
    -- means we cannot tell how long it has been stuck, and leaving it
    -- stuck forever is worse than one duplicate.
    and coalesce(claimed_at, created_at) < now() - p_older_than;
  get diagnostics n = row_count;
  return n;
end $$;

-- ------------------------------------------------------------
-- What the operator needs to see
-- ------------------------------------------------------------

create or replace function outbox_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  uid    uuid := require_staff();
  counts jsonb;
  oldest timestamptz;
  stuck  int;
begin
  select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) into counts
  from (select status, count(*) as n from message_log group by status) s;

  select min(created_at) into oldest from message_log where status = 'queued';
  select count(*) into stuck from message_log
  where status = 'sending' and created_at < now() - interval '10 minutes';

  return jsonb_build_object(
    'by_status',        counts,
    'oldest_queued_at', oldest,
    'stalled_sending',  stuck);
end $$;

revoke execute on function claim_outbox(int)                                   from public;
revoke execute on function settle_message(uuid, boolean, text, text, text, int) from public;
revoke execute on function requeue_stalled_messages(interval)                  from public;
revoke execute on function outbox_health()                                     from public;

-- The drain runs with no user present, so it is service_role only.
-- Giving claim_outbox to `authenticated` would let any signed-in shopper
-- claim -- and therefore suppress -- other people's order confirmations.
grant execute on function claim_outbox(int)                                    to service_role;
grant execute on function settle_message(uuid, boolean, text, text, text, int) to service_role;
grant execute on function requeue_stalled_messages(interval)                   to service_role;
grant execute on function outbox_health()                                      to authenticated;



-- ============================================================
-- SOURCE: 20260801002100_message_templates.sql
-- ============================================================

-- ============================================================
-- 0021  Message templates
--
-- Email copy, moved out of the code and into the store.
--
-- `apps/api/src/mailer.ts` carried the copy in a switch statement, and
-- said so: "when these need design, they become provider-side templates
-- addressed by `template`, and this function goes away." Provider-side
-- turned out to be the wrong home. B17 made the provider swappable --
-- Resend or any SMTP host -- and templates living at the provider would
-- have to be re-authored on every switch, which is exactly the lock-in
-- that work removed.
--
-- So they live here instead. A template survives a provider change, a
-- redeploy, and a person leaving; and changing the wording of a password
-- reset stops being a code change.
--
-- ABSENCE IS MEANINGFUL. There are no seed rows, deliberately. A key
-- with no row here renders from the built-in default in mailer.ts, so a
-- fresh install sends correct email before anyone has opened the admin,
-- and DELETE is how you revert a template you have made worse. The
-- built-ins are the floor; this table only ever overrides them.
-- ============================================================

create table message_templates (
  key         text primary key,
  subject     text not null,
  body        text not null,
  -- What this email is for, shown beside the editor. Null means the API's
  -- own description for a known key is used.
  description text,
  updated_at  timestamptz not null default now(),

  constraint message_templates_key_format
    check (key ~ '^[a-z][a-z0-9_]*$'),

  -- An empty template is not a customisation, it is an outage: the
  -- customer gets a blank email and no way to know it was meant to
  -- carry a code.
  constraint message_templates_subject_present check (btrim(subject) <> ''),
  constraint message_templates_body_present    check (btrim(body) <> ''),

  -- HEADER INJECTION. A subject is one header line. A newline in it lets
  -- whoever edits this table append headers of their own -- Bcc most
  -- obviously -- to every message the template sends. nodemailer folds
  -- and escapes, but this must not depend on which provider adapter is
  -- in use, so the database refuses it for every caller including the
  -- service key.
  constraint message_templates_subject_single_line
    check (subject !~ '[\r\n]'),

  -- Long enough for real copy, short enough that a runaway paste cannot
  -- quietly become the thing every customer receives.
  constraint message_templates_sane_length
    check (length(subject) <= 200 and length(body) <= 20000)
);

comment on table message_templates is
  'Overrides for the built-in email copy in apps/api/src/mailer.ts, keyed '
  'by message_log.template. A missing row means "use the built-in", so '
  'deleting a row reverts it. Variables are {{snake_case}} and are '
  'substituted from message_log.payload; an unknown variable renders '
  'empty rather than leaving braces in a customer''s inbox.';

comment on column message_templates.subject is
  'Single line. A newline here would be a header injection into every '
  'message this template sends.';

create trigger trg_touch_message_templates before update on message_templates
  for each row execute function set_updated_at();

-- Copy that goes to customers is worth being able to attribute later --
-- "who changed the refund email, and when" is a real question after a
-- complaint.
create trigger trg_audit_message_templates
  after insert or update or delete on message_templates
  for each row execute function audit_row();

-- ------------------------------------------------------------
-- Access
--
-- The baseline enables RLS and attaches the staff blanket by looping
-- over pg_tables, which ran long before this table existed. A new table
-- inherits none of it, so both halves are spelled out here. Getting this
-- wrong is silent: with RLS enabled and no policy the table is simply
-- empty to everyone, and every email quietly falls back to its default.
-- ------------------------------------------------------------

alter table message_templates enable row level security;
alter table message_templates force row level security;

create policy staff_all on message_templates for all
  to authenticated
  using (is_staff()) with check (is_staff());

-- No public policy, and none is wanted. There is nothing secret in a
-- template, but the storefront has no reason to read them and the outbox
-- drain reads them on the service key, which RLS does not apply to.


-- ============================================================
-- SOURCE: 20260801002200_delivery.sql
-- ============================================================

-- ============================================================
-- 0022  Closing the order lifecycle
--
-- admin_ship_order() has created shipments since B7 and nothing could
-- ever move one afterwards. shipments.status had six values past
-- 'label_created' that no code path could reach, shipments.delivered_at
-- was never written, and orders.status could not become 'delivered' at
-- all -- so every order this store has ever fulfilled stayed "shipped"
-- permanently, and the return window, the delivery timeline and any
-- report keyed on delivery had nothing to read.
--
-- This is an RPC rather than two UPDATEs from the API for the reason
-- every other admin_* function is: it touches three tables and the order
-- must not be left half-moved if one of them fails.
-- ============================================================


-- ------------------------------------------------------------
-- Advance a shipment, and the order with it when that is warranted
--
-- THE ORDER FOLLOWS THE LAST SHIPMENT, NOT THIS ONE. An order can be
-- fulfilled in parts -- shipment_items exists precisely so it can -- so
-- marking one parcel delivered while another is still in transit must
-- not tell the customer their order arrived. The order moves only when
-- no shipment on it is still outstanding.
--
-- 'rto' and 'lost' deliberately do NOT move the order. A returned or
-- lost parcel needs a person to decide between a refund, a reship and a
-- claim; quietly picking one here would be the code making a commercial
-- decision it has no business making.
-- ------------------------------------------------------------

create or replace function admin_update_shipment(
  p_shipment_id uuid,
  p_status      text,
  p_at          timestamptz default null
)
returns text                    -- the order's status after this call
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid       uuid := require_staff();
  s         shipments%rowtype;
  o         orders%rowtype;
  ts        timestamptz := coalesce(p_at, now());
  remaining int;
begin
  if p_status not in ('label_created', 'picked_up', 'in_transit',
                      'out_for_delivery', 'delivered', 'rto', 'lost') then
    raise exception 'unknown shipment status %', p_status using errcode = '22023';
  end if;

  select * into s from shipments where id = p_shipment_id for update;
  if not found then
    raise exception 'shipment % not found', p_shipment_id using errcode = 'P0002';
  end if;

  -- Locked in the same order admin_ship_order takes them, so two staff
  -- acting on one order cannot deadlock against each other.
  select * into o from orders where id = s.order_id for update;

  if o.status in ('cancelled', 'refunded') then
    raise exception 'order % is %', o.order_number, o.status using errcode = '55000';
  end if;

  -- Already there. Idempotent rather than an error: a courier webhook
  -- redelivering "delivered" is the ordinary case, not a fault.
  if s.status = p_status then
    return o.status;
  end if;

  update shipments
     set status       = p_status,
         delivered_at = case when p_status = 'delivered' then ts else delivered_at end,
         -- shipments_delivered_after_shipped refuses a delivery that
         -- predates dispatch. A shipment created by admin_ship_order
         -- always has shipped_at, but one created any other way may not,
         -- and a null there would let the check pass on a lie.
         shipped_at   = case
                          when shipped_at is not null then shipped_at
                          when p_status in ('picked_up', 'in_transit',
                                            'out_for_delivery', 'delivered') then ts
                          else shipped_at
                        end,
         updated_at   = now()
   where id = p_shipment_id;

  if p_status <> 'delivered' then
    return o.status;
  end if;

  select count(*) into remaining
    from shipments
   where order_id = s.order_id
     and status not in ('delivered', 'rto', 'lost');

  if remaining > 0 then
    -- Part of the order is still on its way. Nothing to announce yet.
    return o.status;
  end if;

  update orders set status = 'delivered', updated_at = now() where id = o.id;

  insert into order_events (order_id, event, from_status, to_status, actor_type, actor_id)
  values (o.id, 'delivered', o.status, 'delivered', 'staff', uid);

  return 'delivered';
end $$;

revoke execute on function admin_update_shipment(uuid, text, timestamptz) from public;
grant  execute on function admin_update_shipment(uuid, text, timestamptz) to authenticated;



-- ============================================================
-- SOURCE: 20260801002300_role_matrix.sql
-- ============================================================

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



-- ============================================================
-- SOURCE: 20260801002400_category_tree.sql
-- ============================================================

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



-- ============================================================
-- SOURCE: 20260801002500_credit_at_checkout.sql
-- ============================================================

-- ============================================================
-- 0025  Store credit becomes spendable
--
-- credit_ledger has carried an 'order_payment' reason since the
-- baseline, and the table's own comment says "Spend it at checkout by
-- adding a payments row with provider = 'store_credit'". Nothing did.
-- Staff could grant credit, a return could resolve to it, a gift card
-- could be redeemed into it, and the customer could watch the balance on
-- /credit -- and never spend a rupee of it. api-plan B12 lists this as
-- still open.
--
-- Two changes, and the first is the one to read carefully.
-- ============================================================


-- ------------------------------------------------------------
-- 1. capture_payment() learns that an order can be paid in parts
--
-- Its amount check compared what the gateway captured against the
-- ORDER TOTAL: "a gateway that captures less than it was asked for is a
-- dispute, not a checkout". That reasoning is right and is kept. What
-- changes is the number it is right about -- once credit has already
-- paid part of the order, the gateway was never asked for the total,
-- and comparing against it would refuse every correct capture.
--
-- So it compares against what is still outstanding: the total, less
-- everything already captured against this order. With no credit in
-- play that is exactly grand_total, so nothing about the existing path
-- changes.
-- ------------------------------------------------------------

-- The four-argument capture_payment() from 20260801001500 was superseded
-- by the five-argument one in 20260801001700 and never dropped, so both
-- have been sitting there. Nothing noticed, because PostgREST calls it
-- with named parameters and only one candidate takes five. A positional
-- four-argument call is ambiguous between them -- which is exactly how
-- this was found, when checkout() below tried to make one.
drop function if exists capture_payment(uuid, text, text, numeric);

create or replace function capture_payment(
  p_order_id           uuid,
  p_provider           text,
  p_provider_ref       text,
  p_amount             numeric default null,
  p_provider_payment_ref text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o     orders%rowtype;
  res   record;
  pay   uuid;
  n_res int;
  due   numeric(12,2);
begin
  select * into o from orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'P0002';
  end if;

  if o.status <> 'pending' then
    return false;
  end if;

  -- What this provider was actually asked for.
  --
  -- This compared against grand_total, and the reasoning behind it is
  -- kept: a gateway that captures less than it was asked for is a
  -- dispute, not a checkout. What changes is the number it is right
  -- about. Once store credit has already paid part of the order the
  -- gateway was never asked for the total, and comparing against it
  -- would refuse every correct capture. With no credit in play `due` is
  -- exactly grand_total, so the existing path is unchanged.
  select o.grand_total - coalesce(sum(p.amount), 0) into due
  from payments p
  where p.order_id = p_order_id and p.status = 'captured';

  if p_amount is not null and p_amount <> due then
    raise exception
      'gateway captured % against an outstanding %', p_amount, due
      using errcode = 'ECOM2', hint = 'amount_mismatch';
  end if;

  n_res := 0;
  for res in
    select m.id, m.variant_id, m.quantity
    from inventory_movements m
    where m.order_id = p_order_id
      and m.reason = 'reservation'
      and not exists (
        select 1 from inventory_movements c where c.reservation_id = m.id)
  loop
    insert into inventory_movements (variant_id, quantity, reason, order_id, reservation_id)
    values (res.variant_id, -res.quantity, 'release', p_order_id, res.id);

    insert into inventory_movements (variant_id, quantity, reason, order_id)
    values (res.variant_id, res.quantity, 'sale', p_order_id);

    n_res := n_res + 1;
  end loop;

  -- The hold lapsed before the money landed. Taking the stock now is
  -- the difference between an oversell that is loud and one that is
  -- invisible until somebody counts the shelf.
  if n_res = 0 then
    insert into inventory_movements (variant_id, quantity, reason, order_id, note)
    select oi.variant_id, -oi.quantity, 'sale', p_order_id,
           'reservation expired before capture'
    from order_items oi
    where oi.order_id = p_order_id and oi.variant_id is not null;
  end if;

  update payments
  set status = 'captured',
      provider_ref = coalesce(provider_ref, p_provider_ref),
      provider_payment_ref = coalesce(p_provider_payment_ref, provider_payment_ref),
      updated_at = now()
  where order_id = p_order_id and provider = p_provider and status <> 'captured'
  returning id into pay;

  if pay is null then
    insert into payments (order_id, provider, provider_ref, provider_payment_ref,
                          amount, status)
    values (p_order_id, p_provider, p_provider_ref, p_provider_payment_ref,
            o.grand_total, 'captured')
    on conflict do nothing;
  end if;

  update orders set status = 'paid', updated_at = now() where id = p_order_id;

  insert into order_events (order_id, event, from_status, to_status, note, actor_type)
  values (p_order_id, 'payment_captured', o.status, 'paid', p_provider, 'system');

  return true;
end $$;

-- ------------------------------------------------------------
-- 2. Spending it, inside the checkout transaction
--
-- WHY THIS IS NOT A SECOND CALL. The balance has to be read, checked
-- and debited in the same transaction that creates the order, for the
-- same reason the coupon redemption and the stock reservation are:
-- two checkouts a millisecond apart would otherwise both read the same
-- balance and both spend it.
--
-- The lock is on the customers row rather than on credit_ledger. The
-- ledger has no row to lock when the balance is being read (SELECT does
-- not block INSERT), so locking the owner is what actually serialises
-- two concurrent spends by the same person.
--
-- ponytail: one lock per customer, which serialises that customer's
-- concurrent checkouts and nobody else's. Fine at any volume a person
-- generates; revisit only if a single account is placing orders
-- concurrently on purpose.
--
-- The balance rule is copied from customer_credit_balances, expiry and
-- all. If the two ever disagree, the customer's screen and the amount
-- they can spend disagree, which is the kind of bug that arrives as an
-- angry support ticket rather than as an exception.
-- ------------------------------------------------------------

create or replace function apply_store_credit(
  p_order_id uuid,
  p_customer uuid,
  p_grand    numeric
)
returns numeric               -- how much credit was actually spent
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  bal     numeric(12,2);
  applied numeric(12,2);
begin
  if p_customer is null then
    -- A guest has no ledger to spend from. Not an error: the caller asked
    -- for credit and there is none, which is the same as asking for more
    -- than the balance.
    return 0;
  end if;

  perform 1 from customers where id = p_customer for update;

  select coalesce(sum(delta), 0) into bal
  from credit_ledger
  where customer_id = p_customer
    and (expires_at is null or expires_at > now());

  applied := least(bal, p_grand);
  if applied <= 0 then
    return 0;
  end if;

  insert into credit_ledger (customer_id, delta, reason, order_id, note)
  values (p_customer, -applied, 'order_payment', p_order_id,
          'spent at checkout');

  -- 'created', not 'captured': capture_payment() is what moves an order
  -- to paid, and letting it do that here too keeps one function
  -- responsible for converting reservations into sales.
  insert into payments (order_id, provider, amount, status)
  values (p_order_id, 'store_credit', applied, 'created');

  return applied;
end $$;

revoke execute on function apply_store_credit(uuid, uuid, numeric) from public;
-- checkout() is definer and calls this; nothing else should.
revoke execute on function apply_store_credit(uuid, uuid, numeric) from authenticated;

-- ------------------------------------------------------------
-- 3. checkout(), with one more parameter and one more branch
--
-- Replaced whole because Postgres has no way to edit part of a function.
-- The diff against 20260801001400_checkout.sql is: the p_use_credit
-- parameter, the credit/o_status locals, the block that spends credit
-- before the gateway payment row is sized, and credit_applied in the
-- result.
-- ------------------------------------------------------------

-- A different argument list is a different function, so without this the
-- old ten-parameter checkout() would still exist beside the new one and
-- PostgREST would have two candidates to resolve between. Not a coin toss
-- to leave lying at a payment boundary.
drop function if exists
  checkout(text, text, text, text, jsonb, jsonb, text, text, uuid, int);

create or replace function checkout(
  p_idempotency_key  text,
  p_request_hash     text,
  p_email            text,
  p_phone            text,
  p_items            jsonb,
  p_shipping_address jsonb,
  p_payment_method   text,
  p_coupon_code      text default null,
  p_cart_id          uuid default null,
  p_hold_minutes     int  default 15,
  -- Spend the caller's store credit against this order, as much of it as
  -- the balance and the total allow. Ignored for guests, who have no
  -- ledger. Opt-in: a customer with a balance may well be saving it.
  p_use_credit       boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid       uuid := auth.uid();
  ik        idempotency_keys%rowtype;
  claimed   text;
  d         discounts%rowtype;
  q         record;
  pin       text;
  v_lines   jsonb;
  n_items   int;
  weight_g  int           := 0;
  max_rate  numeric(4,2)  := 0;
  subtotal  numeric(12,2) := 0;
  discount  numeric(12,2) := 0;
  shipping  numeric(12,2) := 0;
  tax       numeric(12,2) := 0;
  grand     numeric(12,2);
  eligible  numeric(12,2) := 0;
  flags     jsonb := '[]'::jsonb;
  risk      int;
  o_id      uuid;
  o_number  text;
  pay_id    uuid;
  credit    numeric(12,2) := 0;
  o_status  text := 'pending';
  res       jsonb;
begin
  if p_payment_method not in ('razorpay', 'cod') then
    raise exception 'That payment method is not supported.'
      using errcode = 'ECOM1', hint = 'unsupported_payment_method';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Your cart is empty.'
      using errcode = 'ECOM1', hint = 'cart_empty';
  end if;

  -- 1. Claim the idempotency key FIRST.
  --
  -- Two concurrent identical requests do not both proceed: the second
  -- INSERT blocks on the unique index until the first commits or rolls
  -- back, then either replays the stored response or takes over.
  insert into idempotency_keys (key, scope, request_hash, customer_id, locked_at)
  values (p_idempotency_key, 'checkout', p_request_hash, uid, now())
  on conflict (key) do nothing
  returning key into claimed;

  if claimed is null then
    select * into ik from idempotency_keys where key = p_idempotency_key;

    -- Same key, different body is a client bug. Replaying the first
    -- response would hide it and charge for the wrong basket.
    if ik.request_hash is distinct from p_request_hash then
      raise exception 'This request was already submitted with a different basket.'
        using errcode = 'ECOM2', hint = 'idempotency_key_conflict';
    end if;
    if ik.completed_at is null then
      raise exception 'That checkout is still being processed. Try again in a moment.'
        using errcode = 'ECOM2', hint = 'checkout_in_flight';
    end if;
    return ik.response_body;
  end if;

  -- 2. Price the basket from the database.
  select jsonb_agg(jsonb_build_object(
           'variant_id',    v.id,
           'product_id',    p.id,
           'product_name',  p.name,
           'variant_title', coalesce(v.title, 'Default'),
           'sku',           v.sku,
           'unit_price',    v.price,
           'quantity',      req.quantity,
           'line_total',    round(v.price * req.quantity, 2),
           'gst_rate',      coalesce(p.gst_rate, 0))),
         count(*),
         coalesce(sum(round(v.price * req.quantity, 2)), 0),
         coalesce(sum(coalesce(v.weight_grams, 0) * req.quantity), 0),
         coalesce(max(coalesce(p.gst_rate, 0)), 0)
    into v_lines, n_items, subtotal, weight_g, max_rate
  from jsonb_to_recordset(p_items) as req(variant_id uuid, quantity int)
  join product_variants v on v.id = req.variant_id
  join products p on p.id = v.product_id
  where v.status = 'active' and p.status = 'active' and req.quantity > 0;

  -- A short count means something in the basket is archived, draft or
  -- gone. Naming which would let anyone enumerate unreleased products.
  if v_lines is null or n_items <> jsonb_array_length(p_items) then
    raise exception 'One or more items in your cart are no longer available.'
      using errcode = 'ECOM2', hint = 'items_unavailable';
  end if;

  -- 3. Coupon. Locked, because max_uses is enforced by a counter and
  --    two checkouts must not both claim the last use.
  if p_coupon_code is not null then
    select * into d from discounts
    where code = p_coupon_code
      and is_active
      and starts_at <= now()
      and (ends_at is null or ends_at > now())
    for update;

    -- One message for expired, inactive and non-existent alike: three
    -- messages is a way to enumerate live codes.
    if not found then
      raise exception 'Coupon % is not valid.', p_coupon_code
        using errcode = 'ECOM1', hint = 'invalid_coupon';
    end if;
    if d.min_order_total is not null and subtotal < d.min_order_total then
      raise exception 'Coupon % needs an order of at least %.',
        p_coupon_code, d.min_order_total
        using errcode = 'ECOM1', hint = 'coupon_minimum_not_met';
    end if;

    select coalesce(sum((e ->> 'line_total')::numeric), 0) into eligible
    from jsonb_array_elements(v_lines) e
    where d.applies_to = 'order'
       or (d.applies_to = 'product' and (e ->> 'product_id')::uuid = d.product_id)
       or (d.applies_to = 'collection' and exists (
             select 1 from collection_products cp
             where cp.collection_id = d.collection_id
               and cp.product_id = (e ->> 'product_id')::uuid));

    if d.kind = 'percent' then
      discount := round(eligible * d.value / 100, 2);
    elsif d.kind = 'fixed' then
      -- Capped at what it applies to, or orders_discount_within_subtotal
      -- refuses the insert.
      discount := least(d.value, eligible);
    end if;

    if discount = 0 and d.kind <> 'free_shipping' then
      raise exception 'Coupon % does not apply to anything in this order.',
        p_coupon_code using errcode = 'ECOM1', hint = 'coupon_not_applicable';
    end if;
  end if;

  -- 4. Shipping, through the same function that quoted it on the cart
  --    page. Computing it a second way here is how the quote and the
  --    charge come to disagree.
  pin := p_shipping_address ->> 'postal_code';
  select * into q from shipping_quote(pin, weight_g, subtotal - discount);
  if not found then
    raise exception 'We do not deliver to %.', coalesce(pin, 'that pincode')
      using errcode = 'ECOM1', hint = 'not_serviceable';
  end if;

  shipping := q.rate;
  if d.id is not null and d.kind = 'free_shipping' then
    -- Zero the shipping rather than adding to discount_total:
    -- orders_discount_within_subtotal caps the discount at the subtotal,
    -- and free shipping is not a discount on goods.
    shipping := 0;
  end if;

  -- 5. COD gating. The blocklist exists to stop repeat RTO offenders
  --    before they cost two-way courier fees; not consulting it here
  --    means it never blocks anybody.
  select coalesce(jsonb_agg(f), '[]'::jsonb) into flags
  from (
    select 'blocklisted_' || b.kind as f
    from blocklist b
    where (b.expires_at is null or b.expires_at > now())
      and ((b.kind = 'phone'   and b.value = p_phone)
        or (b.kind = 'email'   and b.value = p_email)
        or (b.kind = 'pincode' and b.value = pin))
  ) hits;

  risk := case when jsonb_array_length(flags) > 0 then 100 else null end;

  if p_payment_method = 'cod' then
    if jsonb_array_length(flags) > 0 then
      raise exception 'Cash on delivery is not available for this order.'
        using errcode = 'ECOM1', hint = 'cod_unavailable';
    end if;
    if not q.cod_allowed then
      raise exception 'Cash on delivery is not available for %.', pin
        using errcode = 'ECOM1', hint = 'cod_unavailable';
    end if;
    shipping := shipping + q.cod_surcharge;
  end if;

  -- 6. Tax. Prices are GST-exclusive here: grand_total = subtotal
  --    - discount + shipping + tax, and orders_totals_balance enforces it.
  --    Shipping is taxed at the highest item rate (composite supply),
  --    matching admin_issue_invoice.
  v_lines := apportion_taxable(v_lines, subtotal, discount);

  -- 2 * round(rate/200) rather than round(rate/100): the invoice must
  -- split intra-state tax into two EQUAL halves (invoice_lines_
  -- cgst_equals_sgst), so the amount has to be even in paise. Rounding
  -- to the full rate here would leave the invoice a paisa off.
  select coalesce(sum(2 * round((e ->> 'taxable_value')::numeric
                                * (e ->> 'gst_rate')::numeric / 200, 2)), 0)
    into tax
  from jsonb_array_elements(v_lines) e;

  tax   := tax + 2 * round(shipping * max_rate / 200, 2);
  grand := subtotal - discount + shipping + tax;

  -- 7. The order.
  insert into orders (customer_id, email, phone,
                      subtotal, discount_total, shipping_total, tax_total, grand_total,
                      coupon_code, shipping_address, risk_score, risk_flags)
  values (uid, p_email, p_phone,
          subtotal, discount, shipping, tax, grand,
          case when d.id is not null then p_coupon_code end,
          p_shipping_address, risk, flags)
  returning id, order_number into o_id, o_number;

  insert into order_items (order_id, variant_id, product_name, variant_title,
                           sku, unit_price, quantity)
  select o_id, (e ->> 'variant_id')::uuid, e ->> 'product_name',
         e ->> 'variant_title', e ->> 'sku',
         (e ->> 'unit_price')::numeric, (e ->> 'quantity')::int
  from jsonb_array_elements(v_lines) e;

  -- 8. Reserve the stock.
  --
  -- After the order, not before it as section 20 shows, because
  -- inventory_movements is append-only: order_id cannot be filled in
  -- later, and admin_capture_cod finds its reservations by order_id.
  -- The guard is unaffected -- this is one transaction, so a failed
  -- CHECK (stock >= 0) still takes the order with it.
  --
  -- expires_at is mandatory: a hold nothing releases strands that unit
  -- forever. release_expired_reservations() sweeps these.
  insert into inventory_movements (variant_id, quantity, reason, order_id, expires_at)
  select (e ->> 'variant_id')::uuid, -(e ->> 'quantity')::int, 'reservation',
         o_id, now() + make_interval(mins => p_hold_minutes)
  from jsonb_array_elements(v_lines) e;

  -- 9. Redemption. The trigger on this table increments used_count and
  --    refuses the row if it would exceed either limit.
  if d.id is not null and discount > 0 then
    insert into discount_redemptions (discount_id, order_id, customer_id, amount)
    values (d.id, o_id, uid, discount);
  end if;

  -- 9b. Store credit, before the gateway row, because the gateway is
  --     owed whatever credit does not cover. Inside this transaction for
  --     the same reason the redemption above is: two checkouts a
  --     millisecond apart would otherwise read the same balance and both
  --     spend it. apply_store_credit() takes the lock that stops that.
  if p_use_credit then
    credit := apply_store_credit(o_id, uid, grand);
  end if;

  if grand - credit > 0 then
    insert into payments (order_id, provider, amount, status)
    values (o_id, case when p_payment_method = 'cod' then 'cod' else 'razorpay' end,
            grand - credit, 'created')
    returning id into pay_id;
  else
    -- Credit covered the lot, so there is nothing for a gateway to do
    -- and nothing to wait for. capture_payment() is what moves an order
    -- to paid and converts the reservations into sales; calling it here
    -- rather than repeating those ledger moves is what keeps one
    -- function responsible for them.
    perform capture_payment(o_id, 'store_credit', null, grand);
    o_status := 'paid';
    select id into pay_id
    from payments where order_id = o_id and provider = 'store_credit';
  end if;

  insert into order_events (order_id, event, to_status, actor_type, actor_id)
  values (o_id, 'order_placed', 'pending',
          case when uid is null then 'system' else 'customer' end, uid);

  -- 10. Outbox. Queued in the same transaction as the order, so a dead
  --     email provider cannot lose the confirmation or roll back the sale.
  insert into message_log (customer_id, order_id, channel, template, recipient, payload)
  values (uid, o_id, 'email', 'order_confirmation', p_email,
          jsonb_build_object('order_number', o_number, 'grand_total', grand));

  if p_cart_id is not null then
    update carts
    set status = 'converted', converted_order_id = o_id, updated_at = now()
    where id = p_cart_id and status = 'active';
  end if;

  res := jsonb_build_object(
    'order_id',       o_id,
    'order_number',   o_number,
    'status',         o_status,
    'payment_id',     pay_id,
    'payment_method', p_payment_method,
    'credit_applied', credit,
    'currency',       'INR',
    'subtotal',       subtotal,
    'discount_total', discount,
    'shipping_total', shipping,
    'tax_total',      tax,
    'grand_total',    grand,
    'reserved_until', (now() + make_interval(mins => p_hold_minutes)));

  -- 11. Store the response so a retry of step 1 replays it verbatim.
  update idempotency_keys
  set response_status = 201, response_body = res, completed_at = now()
  where key = p_idempotency_key;

  return res;
end $$;

revoke execute on function
  checkout(text, text, text, text, jsonb, jsonb, text, text, uuid, int, boolean) from public;
grant execute on function
  checkout(text, text, text, text, jsonb, jsonb, text, text, uuid, int, boolean)
  to anon, authenticated;



-- ============================================================
-- SOURCE: 20260801002600_customer_cancel.sql
-- ============================================================

-- ============================================================
-- 0026  A customer can cancel their own unpaid order
--
-- admin_cancel_order() has existed since B3 and calls require_staff(),
-- so the only way to cancel was to contact the shop. For an order placed
-- two minutes ago that has not been paid for, that is a support ticket
-- for something the customer should simply be able to do -- and while it
-- sits unanswered the reservation holds stock nobody is going to buy.
--
-- Deliberately narrower than the staff version, in one way that matters:
-- PENDING ONLY. admin_cancel_order will cancel a paid order and return
-- the sold units to stock, which is the right power for staff and the
-- wrong one to hand a customer -- money has changed hands by then, and
-- unwinding that is a refund decision with a person attached. A paid
-- order still goes through support, and returns exist for after
-- delivery.
-- ============================================================


create or replace function cancel_own_order(
  p_order_id uuid,
  p_reason   text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  o   orders%rowtype;
  res record;
begin
  if uid is null then
    raise exception 'sign in to cancel an order' using errcode = '42501';
  end if;

  -- Ownership is in the WHERE clause, not left to RLS: this function is
  -- security definer, so RLS does not apply to it at all, and a lookup
  -- by id alone would let anyone cancel any order by guessing one.
  select * into o from orders
  where id = p_order_id and customer_id = uid
  for update;

  if not found then
    -- Same answer for "no such order" and "not yours". Telling them
    -- apart turns this into a way to test whether an order id exists.
    raise exception 'order not found' using errcode = 'P0002';
  end if;

  if o.status <> 'pending' then
    raise exception
      'That order can no longer be cancelled here. Contact support.'
      using errcode = 'ECOM1', hint = 'order_not_cancellable';
  end if;

  -- Pending means nothing was ever captured, so there are no 'sale' rows
  -- to reverse -- only the holds checkout took. That is the whole reason
  -- this function is short where admin_cancel_order is not.
  for res in
    select m.id, m.variant_id, m.quantity
    from inventory_movements m
    where m.order_id = p_order_id
      and m.reason = 'reservation'
      and not exists (
        select 1 from inventory_movements c where c.reservation_id = m.id)
  loop
    insert into inventory_movements (variant_id, quantity, reason, order_id, reservation_id)
    values (res.variant_id, -res.quantity, 'release', p_order_id, res.id);
  end loop;

  update orders set status = 'cancelled', updated_at = now() where id = p_order_id;

  insert into order_events (order_id, event, from_status, to_status, note, actor_type, actor_id)
  values (p_order_id, 'status_changed', o.status, 'cancelled', p_reason, 'customer', uid);
end $$;

revoke execute on function cancel_own_order(uuid, text) from public;
grant  execute on function cancel_own_order(uuid, text) to authenticated;



-- ============================================================
-- SOURCE: 20260801002700_ops_alerts.sql
-- ============================================================

-- ============================================================
-- 0027  The two conditions that should reach a person, reaching one
--
-- /admin/outbox and /admin/webhooks both compute exactly what is wrong
-- and both wait to be asked. A mail queue that stopped draining and a
-- payment callback that could not be applied are the two failures in
-- this system that are silent, unbounded and expensive -- and the only
-- thing standing between them and a week of nobody noticing is somebody
-- deciding to open an admin page.
--
-- This does not add a monitoring stack. It puts the alert where staff
-- already look, using the notifications table that has existed since the
-- baseline with nothing writing staff rows into it.
--
-- WHAT THIS IS NOT: paging. A notification is seen when someone opens
-- the admin, which is better than never and worse than a phone ringing.
-- The API also logs each of these at error level with a stable message,
-- which is the hook for a log shipper that can page. Wire that up before
-- trusting this alone.
-- ============================================================


-- ------------------------------------------------------------
-- Raise an operational alert, once
--
-- One row per active owner and admin -- not every staff member, because
-- an alert everyone receives is one nobody owns.
--
-- The cooldown is what makes this callable from a loop that runs every
-- minute. Without it a stuck outbox would insert an alert per staff
-- member per tick, and the notification feed would become the outage.
-- ------------------------------------------------------------

create or replace function raise_ops_alert(
  p_kind     text,
  p_title    text,
  p_body     text default null,
  p_data     jsonb default '{}'::jsonb,
  p_cooldown interval default '6 hours'
)
returns int                     -- how many people were told
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  raised int;
begin
  -- Already shouting about this. Unread rather than merely recent: if a
  -- person has seen it and not fixed it, repeating it every six hours
  -- adds nothing they do not know.
  if exists (
    select 1 from notifications
    where kind = p_kind
      and recipient_type = 'staff'
      and read_at is null
      and created_at > now() - p_cooldown
  ) then
    return 0;
  end if;

  insert into notifications (recipient_type, recipient_id, kind, title, body, data)
  select 'staff', s.id, p_kind, p_title, p_body, p_data
  from staff_users s
  where s.is_active and s.role in ('owner', 'admin');

  get diagnostics raised = row_count;
  return raised;
end $$;

revoke execute on function raise_ops_alert(text, text, text, jsonb, interval) from public;
-- The jobs loop calls this on the service key. No user has a reason to.
revoke execute on function raise_ops_alert(text, text, text, jsonb, interval) from authenticated;



-- ============================================================
-- SOURCE: 20260801002800_signin_lockout.sql
-- ============================================================

-- ============================================================
-- 0028  Per-account sign-in lockout
--
-- apps/api's rate limiter counts requests per IP address. That stops one
-- machine hammering /auth/sign-in, and it does nothing whatever about the
-- attack this endpoint actually attracts: a stolen credential list
-- replayed a few attempts at a time from a thousand different addresses.
-- Every one of those addresses stays comfortably inside its own budget.
-- The account being drilled is the only thing they have in common, so
-- that is where the count has to live.
--
-- Why the database rather than another Map in process memory:
--
--   IT HAS TO BE SHARED. Two API containers behind a load balancer means
--   two independent counters, twice the attempts, and a locked account
--   that unlocks itself the moment the attacker is routed to the other
--   one.
--
--   IT HAS TO SURVIVE A RESTART. A lockout that a redeploy clears is a
--   lockout with a published expiry.
--
--   SOMEBODY HAS TO BE ABLE TO SEE IT. A control nobody can look at is
--   half a control. Staff can read this table, and jobs.ts raises an ops
--   alert when several accounts are locked at once -- which is what a
--   stuffing run looks like from in here. The audit entry said the real
--   problem was that the attack is *invisible*; the lock alone would not
--   have fixed that.
--
-- WHAT THIS COSTS, said plainly: anyone who knows your email address can
-- lock you out of your own account for fifteen minutes. That is the
-- standing objection to per-account lockout and it is a real one. Three
-- things bound it -- the lock expires on its own, a completed password
-- reset clears it immediately, and fifteen minutes is an annoyance
-- rather than a denial of service. A lock that held until an admin
-- intervened would trade a small attack for a larger one.
-- ============================================================


-- ------------------------------------------------------------
-- The counter
--
-- Keyed on the address that was typed, whether or not it belongs to an
-- account here. That is deliberate: counting only real accounts would
-- make the lockout itself an enumeration oracle -- ten attempts, and the
-- difference between 401 and 429 tells you who banks here. The cost is
-- that this table holds addresses that have never had an account, which
-- is why sweep_auth_attempts() drops a row an hour after it goes quiet.
--
-- citext, like blocklist.value and customers.email. A lockout that
-- stores Alice@example.com and checks alice@example.com locks nobody,
-- and you find out from the incident report.
-- ------------------------------------------------------------

create table if not exists auth_attempts (
  email        citext primary key,
  failures     int not null default 0,
  last_at      timestamptz not null default now(),
  locked_until timestamptz
);

-- The count jobs.ts runs every sixty seconds, over the one table that
-- grows precisely when you cannot afford a sequential scan of it.
create index if not exists idx_auth_attempts_locked
  on auth_attempts(locked_until) where locked_until is not null;

comment on table auth_attempts is
  'Consecutive failed sign-ins per email address, for the lockout in '
  'apps/api/src/routes/auth.ts. Rows are transient -- swept an hour '
  'after the last attempt -- and include addresses with no account.';

alter table auth_attempts enable row level security;
alter table auth_attempts force row level security;

-- Read-only, and not to everyone: this is a list of addresses somebody
-- is currently trying passwords against, which is the same class of PII
-- the role matrix already denies a warehouse account on `customers`.
-- There is no write policy at all -- the definer functions below are the
-- only way in, and they run as the owner.
create policy auth_attempts_staff_r on auth_attempts
  for select to authenticated
  using (has_staff_role('owner', 'admin', 'manager', 'support'));

-- ------------------------------------------------------------
-- Is this address locked right now
--
-- Called before the credentials go anywhere near GoTrue. Checking
-- afterwards would still spend the upstream call, and GoTrue's own rate
-- limit is a shared resource an attacker would otherwise get to exhaust
-- on everyone else's behalf.
-- ------------------------------------------------------------

create or replace function auth_lock_check(p_email citext)
returns timestamptz              -- when the lock lifts; null if not locked
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.locked_until
  from auth_attempts a
  where a.email = p_email and a.locked_until > now();
$$;

-- ------------------------------------------------------------
-- Record a failure
--
-- Ten consecutive failures inside fifteen minutes locks the address for
-- fifteen minutes. Ten because somebody mistyping their own password
-- gives up at three or four, and a password manager holding a stale
-- entry is worth a few more; a credential list needs thousands.
--
-- The window is idle-based rather than fixed: fifteen quiet minutes and
-- the next failure starts a fresh run. Two typos on Monday and two on
-- Friday are not an attack, and treating them as one is how a lockout
-- ends up firing on the people it was built to protect.
--
-- Setting the lock resets the counter. Without that, the first mistake
-- after a lock expires would re-lock the account immediately, which
-- turns a fifteen-minute inconvenience into a permanent one for anybody
-- being targeted.
-- ------------------------------------------------------------

create or replace function auth_record_failure(p_email citext)
returns timestamptz              -- non-null when this failure locked it
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a auth_attempts%rowtype;
begin
  insert into auth_attempts (email, failures, last_at)
  values (p_email, 1, now())
  on conflict (email) do update
    set failures = case
          when auth_attempts.last_at < now() - interval '15 minutes' then 1
          else auth_attempts.failures + 1
        end,
        last_at  = now()
  returning * into a;

  if a.failures >= 10 then
    update auth_attempts
    set failures = 0, locked_until = now() + interval '15 minutes'
    where email = p_email
    returning auth_attempts.locked_until into a.locked_until;
    return a.locked_until;
  end if;

  return null;
end $$;

-- ------------------------------------------------------------
-- Forget an address
--
-- Called on a successful sign-in, and on a completed password reset.
-- The second one is the escape hatch that makes the self-inflicted
-- lockout survivable: the victim of somebody else's ten attempts is not
-- told to wait, they are told to reset, and the reset works.
-- ------------------------------------------------------------

create or replace function auth_clear_failures(p_email citext)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from auth_attempts where email = p_email;
$$;

-- ------------------------------------------------------------
-- Prune
--
-- An hour past whichever happened later, the last attempt or the end of
-- the lock. Under a spray this table grows with the attacker's word
-- list, so the sweeper is not housekeeping -- it is the thing that stops
-- the defence from becoming the memory exhaustion.
-- ------------------------------------------------------------

create or replace function sweep_auth_attempts()
returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare removed int := 0;
begin
  delete from auth_attempts
  where greatest(last_at, coalesce(locked_until, last_at)) < now() - interval '1 hour';
  get diagnostics removed = row_count;
  return removed;
end $$;

revoke execute on function auth_lock_check(citext)     from public;
revoke execute on function auth_record_failure(citext) from public;
revoke execute on function auth_clear_failures(citext) from public;
revoke execute on function sweep_auth_attempts()       from public;

-- service_role only. Every one of these is called by the API with no
-- user present, and auth_clear_failures in particular is a lockout
-- release: `authenticated` reaching it would make the whole thing
-- optional for anyone holding a token.
grant execute on function auth_lock_check(citext)      to service_role;
grant execute on function auth_record_failure(citext)  to service_role;
grant execute on function auth_clear_failures(citext)  to service_role;
grant execute on function sweep_auth_attempts()        to service_role;



-- ============================================================
-- SOURCE: 20260801002900_storage_gc.sql
-- ============================================================

-- ============================================================
-- 0029  Collecting images nothing points at any more
--
-- T1 of docs/image-management.md.
--
-- product_images has two ON DELETE CASCADE foreign keys:
--
--   product_id               -> products(id)
--   (variant_id, product_id) -> product_variants(id, product_id)
--
-- So deleting a product or a variant deletes its image rows, and the API
-- is not involved and cannot be -- there is no product-delete route, and
-- this store is administered in psql. A product with twelve photographs
-- is deleted, twelve rows disappear, twelve objects stay in the bucket
-- being billed, and nothing anywhere says so.
--
-- That is why this lives in the database. The instruction to delete an
-- object has to be recorded where the deletion actually happens, which
-- is here, not in a route handler that never ran.
--
-- Same shape as message_log and claim_outbox: enqueue inside the
-- transaction that caused it, drain outside. An HTTP call to storage
-- must not sit inside the transaction deleting the row -- it would hold
-- that transaction open for a network round trip, and a rollback cannot
-- un-delete an object.
--
-- WHY THIS STORES A URL AND NOT AN OBJECT PATH. The plan said parse the
-- path here, mirroring pathFromUrl() in storage.ts. That was wrong.
-- Which URLs belong to our bucket is decided by STORAGE_PUBLIC_URL and
-- STORAGE_BUCKET, which are environment, and the database has neither.
-- Duplicating that logic in SQL would give two parsers free to disagree
-- -- and disagreeing means either deleting somebody else's URL or
-- silently leaking our own. So the trigger records the URL verbatim and
-- apps/api decides what it means, using the one pathFromUrl() that
-- already exists.
-- ============================================================


create table if not exists storage_gc_queue (
  id         uuid primary key default gen_random_uuid(),
  -- The URL as it was stored on the row, not an object path. See above.
  url        text not null unique,
  queued_at  timestamptz not null default now(),
  attempts   int not null default 0,
  last_error text
);

comment on table storage_gc_queue is
  'Objects whose last product_images row was deleted. Drained by the '
  'jobs tick in apps/api/src/jobs.ts, which is where the environment '
  'knows which URLs belong to our bucket. See docs/image-management.md.';

-- The trigger asks "does any row still use this URL" once per deleted
-- row. Without this that is a sequential scan per photograph, on the
-- exact statement that deletes a product with a full gallery.
create index if not exists idx_product_images_url on product_images(url);

alter table storage_gc_queue enable row level security;
alter table storage_gc_queue force row level security;

-- Staff can watch the backlog. No write policy at all: the trigger below
-- is security definer and the sweeper runs as service_role, so there is
-- no version of this a signed-in shopper reaches.
create policy storage_gc_queue_staff_r on storage_gc_queue
  for select to authenticated
  using (has_staff_role('owner', 'admin', 'manager', 'support'));

-- ------------------------------------------------------------
-- Enqueue on delete
--
-- Statement-level with a transition table, not per row. A cascade
-- deleting a twelve-image gallery is one statement, and twelve separate
-- trigger invocations inserting twelve rows is the pattern this schema
-- avoids everywhere else.
--
-- THE `not exists` IS NOT DEFENSIVE PADDING. Two product_images rows may
-- carry the same URL -- nothing forbids it, and a hand-written insert in
-- psql is exactly how it happens. Deleting one of them must not queue an
-- object the other still displays. The check runs against the table as
-- it stands AFTER the delete, so it asks the right question: is anybody
-- still using this?
-- ------------------------------------------------------------

create or replace function enqueue_deleted_images()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into storage_gc_queue (url)
  select distinct d.url
  from deleted d
  where d.url is not null
    and d.url <> ''
    and not exists (select 1 from product_images p where p.url = d.url)
  -- Already queued. The same object cannot need deleting twice, and a
  -- second row would only be a second failed attempt to delete nothing.
  on conflict (url) do nothing;

  return null;
end $$;

drop trigger if exists trg_gc_product_images on product_images;

create trigger trg_gc_product_images
  after delete on product_images
  referencing old table as deleted
  for each statement
  execute function enqueue_deleted_images();

revoke execute on function enqueue_deleted_images() from public;



-- ============================================================
-- SOURCE: 20260801003000_storage_gc_claim.sql
-- ============================================================

-- ============================================================
-- 0030  Draining the image collection queue
--
-- T2 of docs/image-management.md. 0029 records what to collect; this is
-- how a worker takes a batch and reports back.
--
-- The same shape as claim_outbox / settle_message, for the same reason:
-- the work is an HTTP call to storage and must happen outside the
-- transaction that queued it. A rollback cannot un-delete an object, and
-- holding a transaction open across a network round trip is how a
-- database runs out of connections.
--
-- ONE DIFFERENCE FROM THE OUTBOX, and it is deliberate. A message_log
-- row is claimed by moving it to 'sending' so a second drainer cannot
-- take it. There is no such status here and none is needed: removing the
-- same object twice is idempotent -- the second attempt gets "not
-- found", which is the state being asked for anyway. Two drainers racing
-- costs one wasted HTTP call rather than a duplicate email, so the
-- cheaper design is also the correct one.
--
-- attempts is incremented ON CLAIM rather than on failure, so a worker
-- that dies mid-batch still burns an attempt. A row that reliably kills
-- the process would otherwise be retried forever.
-- ============================================================


-- ------------------------------------------------------------
-- Claim a batch
--
-- The cancellation at the top is the important half. Between a row being
-- queued and this running, somebody can add an image pointing at the
-- same object -- re-uploading a photograph that was removed by mistake,
-- or a hand-written insert reusing a URL. Collecting it then would take
-- a picture off a live product page, and this queue row is the only
-- thing that still says to.
--
-- Checked here rather than at queue time because it has to be true at
-- the moment of claiming, not at the moment of queueing.
-- ------------------------------------------------------------

create or replace function claim_storage_gc(
  p_limit   int default 50,
  p_give_up int default 20
)
returns table (id uuid, url text, attempts int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from storage_gc_queue q
  where exists (select 1 from product_images p where p.url = q.url);

  return query
  with claimed as (
    select q.id
    from storage_gc_queue q
    where q.attempts < p_give_up
    order by q.queued_at
    limit greatest(1, least(coalesce(p_limit, 50), 500))
    for update skip locked
  )
  update storage_gc_queue q
  set attempts = q.attempts + 1
  from claimed c
  where q.id = c.id
  returning q.id, q.url, q.attempts;
end $$;

-- ------------------------------------------------------------
-- Report back
--
-- `gone` rather than `deleted`: the caller is asserting the object is no
-- longer in the bucket, which is true both when this call removed it and
-- when it was already absent. A storage 404 is success -- the desired
-- end state -- and treating it as failure would keep a row retrying
-- against something that cannot be removed twice.
--
-- Failure leaves the row with its incremented attempts and an error to
-- read. It retries next tick until p_give_up, then sits there for a
-- person; nothing here quietly discards evidence of a problem.
-- ------------------------------------------------------------

create or replace function settle_storage_gc(
  p_id    uuid,
  p_gone  boolean,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_gone then
    delete from storage_gc_queue where id = p_id;
  else
    update storage_gc_queue
    set last_error = left(p_error, 500)
    where id = p_id;
  end if;
end $$;

revoke execute on function claim_storage_gc(int, int)             from public;
revoke execute on function settle_storage_gc(uuid, boolean, text) from public;

-- service_role only. The sweeper runs with no user present, and
-- settle_storage_gc removes queue rows -- reachable by `authenticated`,
-- it would let any signed-in shopper cancel the collection of every
-- object in the bucket.
grant execute on function claim_storage_gc(int, int)              to service_role;
grant execute on function settle_storage_gc(uuid, boolean, text)  to service_role;



-- ============================================================
-- SOURCE: 20260801003100_referenced_objects.sql
-- ============================================================

-- ============================================================
-- 0031  Everything the database still points at
--
-- T5 of docs/image-management.md, and the input to the reconciler.
--
-- The reconciler lists the bucket, subtracts this, and removes the
-- remainder -- unattended, against a bucket with no backup. So this
-- function is not a convenience view. **It is the definition of "in
-- use", and anything it forgets to mention is a file that gets
-- collected.**
--
-- Which is why it exists at all, rather than the reconciler writing two
-- queries inline: a new column holding image URLs must be added HERE, in
-- one place. Adding it late is not a missing feature, it is data loss.
-- If you are adding such a column, add it to this function in the same
-- migration, before the column holds anything.
--
-- WHAT IS IN:
--   product_images.url      the main one
--   collections.image_url   free text on a merchandising collection
--
-- WHAT IS DELIBERATELY OUT:
--   invoices.pdf_url        nothing writes it. Invoices are rendered as
--                           HTML and printed by the browser, so no PDF is
--                           ever stored (decision 2, 2026-08-20). Out on
--                           purpose; if that ever changes, this function
--                           changes first.
--   shipments.tracking_url  a courier's URL. Not ours, never was.
--
-- Returns URLs rather than object paths, for the same reason 0029 does:
-- which URLs belong to our bucket is decided by STORAGE_PUBLIC_URL and
-- STORAGE_BUCKET, which are environment the database does not have. One
-- parser, in apps/api, or the two drift -- and here the drift is
-- measured in deleted photographs.
-- ============================================================


create or replace function referenced_objects()
returns table (url text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- union, not union all: one URL used by two rows is one reference, and
  -- the caller only ever asks "is this in use".
  select p.url from product_images p
  where p.url is not null and p.url <> ''
  union
  select c.image_url from collections c
  where c.image_url is not null and c.image_url <> ''
$$;

comment on function referenced_objects() is
  'Every URL the database still points at. The reconciler removes what '
  'is NOT in here, so a column of image URLs missing from this function '
  'is a column whose images get collected. See docs/image-management.md.';

revoke execute on function referenced_objects() from public;

-- service_role only. The reconciler runs with no user present, and this
-- is a complete map of every asset the store holds.
grant execute on function referenced_objects() to service_role;



-- ============================================================
-- SOURCE: 20260801003200_orphan_sightings.sql
-- ============================================================

-- ============================================================
-- 0032  An orphan has to be seen twice before it is collected
--
-- T7 of docs/image-management.md, and rail 1 of six.
--
-- Two decisions taken on 2026-08-20 are fine apart and sharp together:
-- the reconciler removes objects UNATTENDED, and the bucket has NO
-- BACKUP. There is no human between a mistake and permanent loss, so the
-- mistake has to be made unlikely rather than recoverable.
--
-- The mistake in question is not exotic. referenced_objects() returning
-- fewer rows than it should -- a migration mid-flight, a renamed column,
-- a revoked grant, a table momentarily unreadable -- makes real images
-- look unreferenced, and the reconciler then does exactly what it was
-- told.
--
-- So: a path is recorded the first time it looks orphaned, and collected
-- only if it STILL looks orphaned a confirmation window later. A query
-- that breaks produces a first sighting and nothing more; the next pass,
-- with the query working again, finds the path referenced and forgets
-- it. That window is what an unbacked bucket buys instead of a restore.
--
-- Deliberately NOT a queue. This is a memory of observations, and an
-- observation that stops being true has to be forgotten -- which is why
-- every pass clears sightings it did not re-observe. An image restored
-- from a backup, re-uploaded by hand, or re-attached to another product
-- starts its week again from zero.
-- ============================================================


create table if not exists storage_orphan_sightings (
  -- The object path, not a URL: by the time a path reaches here apps/api
  -- has already resolved it against the bucket, and there is nothing
  -- left to interpret.
  path          text primary key,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

comment on table storage_orphan_sightings is
  'Objects that looked unreferenced on some pass. Collected only after '
  'they still look unreferenced a confirmation window later, and '
  'forgotten the moment a pass does not see them. docs/image-management.md.';

alter table storage_orphan_sightings enable row level security;
alter table storage_orphan_sightings force row level security;

create policy storage_orphan_sightings_staff_r on storage_orphan_sightings
  for select to authenticated
  using (has_staff_role('owner', 'admin', 'manager', 'support'));

-- ------------------------------------------------------------
-- Record one pass, and say what is now safe to collect
--
-- Three things in one statement, so a pass cannot half-apply:
--
--   FORGET what this pass did not see. A path that has stopped looking
--   orphaned is not "still pending" -- it is in use, and its clock must
--   reset rather than pause. This is the line that makes a broken
--   referenced_objects() harmless.
--
--   REMEMBER what it did see, keeping the ORIGINAL first_seen_at. The
--   entire mechanism is that first sighting; refreshing it every pass
--   would mean nothing ever ages into being collectable.
--
--   RETURN only what has been waiting long enough.
--
-- An empty p_paths is a legitimate answer -- a bucket with no orphans --
-- and correctly forgets everything. It is the empty REFERENCE set that
-- is dangerous, and apps/api refuses that before calling this.
-- ------------------------------------------------------------

create or replace function record_orphan_sightings(
  p_paths   text[],
  p_confirm interval default '7 days'
)
returns table (path text, first_seen_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
-- The RETURNS TABLE names (path, first_seen_at) are in scope for the
-- whole body, so `on conflict (path)` below is ambiguous between the
-- output variable and the column. Prefer the column: every bare mention
-- of `path` here means the table's.
#variable_conflict use_column
begin
  delete from storage_orphan_sightings s
  where s.path <> all (coalesce(p_paths, array[]::text[]));

  insert into storage_orphan_sightings (path)
  select distinct unnest(coalesce(p_paths, array[]::text[]))
  on conflict (path) do update set last_seen_at = now();

  return query
  select s.path, s.first_seen_at
  from storage_orphan_sightings s
  where s.first_seen_at < now() - p_confirm
  order by s.first_seen_at;
end $$;

-- ------------------------------------------------------------
-- Forget the ones that were collected
--
-- Called with what was actually removed, never with what was planned. A
-- path whose deletion failed keeps its sighting and its original
-- first_seen_at, so it is still confirmed next pass and gets retried
-- rather than starting its week over.
-- ------------------------------------------------------------

create or replace function forget_orphan_sightings(p_paths text[])
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare removed int := 0;
begin
  delete from storage_orphan_sightings
  where path = any (coalesce(p_paths, array[]::text[]));
  get diagnostics removed = row_count;
  return removed;
end $$;

revoke execute on function record_orphan_sightings(text[], interval) from public;
revoke execute on function forget_orphan_sightings(text[])           from public;

-- service_role only. The reconciler runs with no user present, and
-- record_orphan_sightings is what decides an object may be collected.
grant execute on function record_orphan_sightings(text[], interval)  to service_role;
grant execute on function forget_orphan_sightings(text[])            to service_role;



-- ============================================================
-- SOURCE: 20260801003300_job_runs.sql
-- ============================================================

-- ============================================================
-- 0033  Work that happens weekly, not every minute
--
-- T8 of docs/image-management.md.
--
-- The jobs tick runs every sixty seconds. The image reconciler must run
-- about once a week, and pg_cron cannot own it because it makes HTTP
-- calls to storage. So the cadence has to live somewhere both durable
-- and shared -- durable because a restart must not reset the clock, and
-- shared because N API containers each ticking every sixty seconds would
-- otherwise all start the weekly pass at once. Every one of those would
-- list the entire bucket (a request per folder) and race the others to
-- remove the same objects.
--
-- Hence a claim, rather than a timestamp somebody reads and then acts
-- on. Reading "is it due" and writing "I am doing it" as two statements
-- is the same bug at a different scale.
--
-- THE FIRST CALL DOES NOT CLAIM. Registering a job returns false, so a
-- freshly deployed store does not immediately run an unattended,
-- irreversible collection pass against a bucket it has only just started
-- filling. The clock starts at deploy; the first real pass is an
-- interval later.
-- ============================================================


create table if not exists job_runs (
  job         text primary key,
  last_run_at timestamptz not null default now()
);

comment on table job_runs is
  'Last time each periodic job ran. claim_job_run() is the only thing '
  'that should write here -- reading and then writing separately is a '
  'race as soon as more than one container is ticking.';

alter table job_runs enable row level security;
alter table job_runs force row level security;

create policy job_runs_staff_r on job_runs
  for select to authenticated
  using (has_staff_role('owner', 'admin', 'manager', 'support'));

-- ------------------------------------------------------------
-- Claim the next run, atomically
--
-- One statement, so two containers cannot both win. The WHERE on the
-- conflict clause is what makes it a claim rather than a read: the
-- update happens only if the job is actually due, and a caller that
-- loses gets no row back at all.
--
-- xmax = 0 tells a fresh INSERT from an ON CONFLICT UPDATE -- the same
-- trick record_webhook() uses in 0015. A fresh insert is a registration,
-- not a claim, so it answers false.
-- ------------------------------------------------------------

create or replace function claim_job_run(p_job text, p_every interval)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare claimed boolean;
begin
  insert into job_runs (job) values (p_job)
  on conflict (job) do update
    set last_run_at = now()
    where job_runs.last_run_at < now() - p_every
  returning (xmax <> 0) into claimed;

  -- No row returned means the conflict clause declined: either somebody
  -- else has it, or it is simply not due yet.
  return coalesce(claimed, false);
end $$;

revoke execute on function claim_job_run(text, interval) from public;
grant  execute on function claim_job_run(text, interval) to service_role;



-- ============================================================
-- SOURCE: 20260801003400_collection_images.sql
-- ============================================================

-- ============================================================
-- 0034  One definition of "in use", and collections use it too
--
-- T10 of docs/image-management.md, plus a bug the task uncovered.
--
-- THE BUG. 0029's trigger asks "is any product_images row still using
-- this URL" before queueing an object for collection, and 0030's claim
-- asks the same. Both were written when product_images was the only
-- table holding image URLs. It is not: collections.image_url has always
-- been free text, and an admin pasting a product's photograph into a
-- collection's hero image is not exotic -- it is the obvious way to make
-- the collection look like the thing it collects.
--
-- In that state, removing the product image queued an object the
-- collection still displayed, and the sweeper duly removed it. A broken
-- image on a live merchandising page, caused by a delete that looked
-- entirely unrelated.
--
-- 0031 already defines "in use" for precisely this reason, and its
-- comment says a column missing from it is a column whose images get
-- collected. The trigger and the claim were that column, in function
-- form. Both now ask referenced_objects(), so there is one answer and
-- adding a table changes one place.
--
-- THE FEATURE. Collections get what product images already have:
-- replacing or removing the picture queues the old object. Without it
-- every re-branded collection leaves its previous hero image in the
-- bucket until the reconciler finds it a week later -- which works, and
-- is a week of paying for something nothing points at.
-- ============================================================


-- ------------------------------------------------------------
-- product_images, now asking the shared question
-- ------------------------------------------------------------

create or replace function enqueue_deleted_images()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into storage_gc_queue (url)
  select distinct d.url
  from deleted d
  where d.url is not null
    and d.url <> ''
    -- referenced_objects(), not product_images: a URL a collection still
    -- points at is in use, however it came to be shared.
    and not exists (select 1 from referenced_objects() r where r.url = d.url)
  on conflict (url) do nothing;

  return null;
end $$;

-- ------------------------------------------------------------
-- collections
--
-- TWO FUNCTIONS, NOT ONE, and the reason is a Postgres rule worth
-- knowing: "transition tables cannot be specified for triggers with
-- column lists". `after update of image_url ... referencing old table`
-- is rejected outright, so a statement-level trigger cannot also be
-- narrowed to a column.
--
-- Given the choice, the transition table wins. Narrowing to the column
-- was only an optimisation -- avoiding the question on every unrelated
-- edit -- and the same saving is available by comparing old to new,
-- which needs both transition tables. That is possible on UPDATE and not
-- on DELETE, where there is no new row, hence two functions rather than
-- one that guesses which tables exist.
--
-- `is distinct from` rather than `<>`: a picture being cleared to null
-- is exactly the case that orphans an object, and `<>` answers null
-- there, which is not true.
-- ------------------------------------------------------------

create or replace function enqueue_replaced_collection_image()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into storage_gc_queue (url)
  select distinct o.image_url
  from old_rows o
  join new_rows n on n.id = o.id
  where o.image_url is not null
    and o.image_url <> ''
    -- Unchanged means nothing was let go of. A collection renamed forty
    -- times keeps its picture and asks nothing.
    and o.image_url is distinct from n.image_url
    and not exists (select 1 from referenced_objects() r where r.url = o.image_url)
  on conflict (url) do nothing;

  return null;
end $$;

create or replace function enqueue_deleted_collection_image()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into storage_gc_queue (url)
  select distinct o.image_url
  from old_rows o
  where o.image_url is not null
    and o.image_url <> ''
    and not exists (select 1 from referenced_objects() r where r.url = o.image_url)
  on conflict (url) do nothing;

  return null;
end $$;

drop trigger if exists trg_gc_collection_image_upd on collections;
drop trigger if exists trg_gc_collection_image_del on collections;

create trigger trg_gc_collection_image_upd
  after update on collections
  referencing old table as old_rows new table as new_rows
  for each statement
  execute function enqueue_replaced_collection_image();

create trigger trg_gc_collection_image_del
  after delete on collections
  referencing old table as old_rows
  for each statement
  execute function enqueue_deleted_collection_image();

revoke execute on function enqueue_replaced_collection_image() from public;
revoke execute on function enqueue_deleted_collection_image()  from public;

-- ------------------------------------------------------------
-- The claim, asking the same question
--
-- Identical reasoning: between queueing and sweeping the object may have
-- become referenced again -- by a re-upload, or by a collection adopting
-- it. Only referenced_objects() knows about both.
-- ------------------------------------------------------------

create or replace function claim_storage_gc(
  p_limit   int default 50,
  p_give_up int default 20
)
returns table (id uuid, url text, attempts int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  delete from storage_gc_queue q
  where exists (select 1 from referenced_objects() r where r.url = q.url);

  return query
  with claimed as (
    select q.id
    from storage_gc_queue q
    where q.attempts < p_give_up
    order by q.queued_at
    limit greatest(1, least(coalesce(p_limit, 50), 500))
    for update skip locked
  )
  update storage_gc_queue q
  set attempts = q.attempts + 1
  from claimed c
  where q.id = c.id
  returning q.id, q.url, q.attempts;
end $$;



-- ============================================================
-- SOURCE: 20260801003500_pdf_url_unused.sql
-- ============================================================

-- ============================================================
-- 0035  invoices.pdf_url is deliberately never written
--
-- T11 of docs/image-management.md, and a smaller change than the task
-- proposed.
--
-- Decision 2 of 2026-08-20: invoices are rendered as HTML and printed by
-- the browser. No PDF is ever stored, so nothing writes this column and
-- nothing will under that decision.
--
-- The task said drop it or comment it. DROPPING IT IS THE WRONG TRADE,
-- and the reasons are written here so it is not re-proposed:
--
--   It is named in protect_invoice()'s mutable_fields, in that
--   function's error message, and in two invariants that exist
--   specifically to prove a filed invoice is immutable EXCEPT here.
--   Dropping the column means editing the guard on GST legal records and
--   deleting invariants -- a wide, delicate change whose entire benefit
--   is the absence of an always-null column.
--
--   The decision is reversible in a way the column is not free to
--   recreate. Archiving signed e-invoice PDFs is a plausible statutory
--   requirement; if that day comes, this column and its existing
--   exemption in protect_invoice() are exactly right, and re-adding both
--   is more work than leaving them.
--
-- What WAS misleading is fixed: routes/invoicing.ts published `pdfUrl`
-- on every invoice, telling every client there was a file to fetch. That
-- field is gone from the response.
-- ============================================================


comment on column invoices.pdf_url is
  'Unused by decision (2026-08-20): invoices are rendered as HTML and '
  'printed by the browser, so no PDF is stored. Kept rather than dropped '
  'because protect_invoice() and two invariants name it, and archiving '
  'signed e-invoice PDFs would want exactly this column back. Not '
  'exposed by the API. See docs/image-management.md T11.';



commit;
