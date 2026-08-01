-- ============================================================
-- 0005  Commerce: orders, payments, carts, inventory, fulfilment
--
-- Line items snapshot everything at purchase time. Catalog rows get
-- repriced, renamed and archived -- orders must stay historically
-- exact.
-- ============================================================

begin;

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

commit;
