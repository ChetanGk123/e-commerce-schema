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

begin;

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

commit;
