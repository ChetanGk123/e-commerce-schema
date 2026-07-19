-- ============================================================
-- E-commerce schema -- complete, single file, runs top to bottom
-- Postgres / Supabase-compatible
--
-- Catalog pattern: products -> options -> option_values -> variants (SKUs)
-- Covers: catalog, customers, cart, orders & payments, staff & audit,
-- collections, discounts, inventory ledger, fulfilment, returns &
-- refunds, reviews, wishlist, stock alerts, order timeline,
-- notifications & messaging, support tickets & enquiries, GST
-- invoicing, gift cards & store credit, shipping zones & COD risk,
-- cross-sells & price history, settings
-- ============================================================

-- ---------------------------------------------
-- Catalog
-- ---------------------------------------------

create table categories (
  id          uuid primary key default gen_random_uuid(),
  parent_id   uuid references categories(id) on delete set null,
  name        text not null,
  slug        text not null unique,
  position    int  not null default 0
);

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
  updated_at   timestamptz not null default now()
);

-- The axes a product varies on: "Chip", "Memory", "Storage", "Colour"
create table product_options (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id) on delete cascade,
  name        text not null,                     -- "Colour"
  position    int  not null default 0,
  unique (product_id, name)
);

-- The choices within each axis: "Midnight", "Silver", "Starlight"
create table product_option_values (
  id          uuid primary key default gen_random_uuid(),
  option_id   uuid not null references product_options(id) on delete cascade,
  value       text not null,                     -- "Midnight"
  position    int  not null default 0,
  unique (option_id, value)
);

-- The sellable unit. Everything a customer buys is a variant --
-- even a product with no choices gets exactly one default variant.
create table product_variants (
  id                uuid primary key default gen_random_uuid(),
  product_id        uuid not null references products(id) on delete cascade,
  sku               text not null unique,
  title             text,                        -- "M3 / 16GB / 512GB / Midnight"
  description       text,                        -- variant-specific copy; falls back to product
  specs             jsonb not null default '{}'::jsonb,
                    -- e.g. {"chip":"M3","ram_gb":16,"ssd_gb":512,"battery_hrs":18}
  price             numeric(12,2) not null check (price >= 0),
  compare_at_price  numeric(12,2),               -- MRP / strike-through price
  cost_price        numeric(12,2),               -- for margins; never expose to storefront
  currency          char(3) not null default 'INR',
  stock             int not null default 0 check (stock >= 0),
  weight_grams      int,                         -- useful for shipping rate APIs
  barcode           text,
  is_default        boolean not null default false,
  status            text not null default 'active'
                    check (status in ('active', 'out_of_stock', 'archived')),
  -- Canonical combo signature: sorted option_value_ids joined with '|',
  -- set by app code (or a trigger) on insert/update. The unique index
  -- below is what stops two variants claiming the same combination --
  -- plain FKs cannot enforce this.
  options_signature text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index idx_variants_product on product_variants(product_id);
create unique index uniq_variant_combo
  on product_variants(product_id, options_signature)
  where options_signature is not null;

-- Which option values define a variant.
-- "MacBook Air / M3 / 16GB / 512GB / Midnight" = 4 rows here.
create table variant_option_values (
  variant_id       uuid not null references product_variants(id) on delete cascade,
  option_value_id  uuid not null references product_option_values(id) on delete cascade,
  primary key (variant_id, option_value_id)
);

-- Images: product-level gallery, optionally pinned to one variant
-- (variant_id null = shared image shown for every configuration).
create table product_images (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id) on delete cascade,
  variant_id  uuid references product_variants(id) on delete cascade,
  url         text not null,
  alt_text    text,
  position    int not null default 0
);

create index idx_images_product on product_images(product_id);
create index idx_images_variant on product_images(variant_id);

-- ---------------------------------------------
-- Customers
-- ---------------------------------------------

create table customers (
  id          uuid primary key default gen_random_uuid(),
  -- On Supabase, make this reference auth.users(id) instead:
  -- id uuid primary key references auth.users(id) on delete cascade
  email       text unique,
  phone       text unique,
  full_name   text,
  created_at  timestamptz not null default now()
);

create table addresses (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references customers(id) on delete cascade,
  label        text,                             -- "Home", "Office"
  line1        text not null,
  line2        text,
  city         text not null,
  state        text not null,
  postal_code  text not null,
  country      char(2) not null default 'IN',
  is_default   boolean not null default false
);

-- ---------------------------------------------
-- Cart
-- ---------------------------------------------

create table carts (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid references customers(id) on delete cascade,
  session_id   text,                             -- guest carts before login
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index idx_carts_session on carts(session_id);

create table cart_items (
  id          uuid primary key default gen_random_uuid(),
  cart_id     uuid not null references carts(id) on delete cascade,
  variant_id  uuid not null references product_variants(id) on delete cascade,
  quantity    int not null check (quantity > 0),
  unique (cart_id, variant_id)
);

-- ---------------------------------------------
-- Orders
-- ---------------------------------------------

create table orders (
  id               uuid primary key default gen_random_uuid(),
  order_number     text not null unique,         -- human-friendly: "ORD-2026-00042"
  customer_id      uuid references customers(id) on delete set null,
  status           text not null default 'pending'
                   check (status in ('pending', 'paid', 'packed',
                                     'shipped', 'delivered',
                                     'cancelled', 'refunded')),
  subtotal         numeric(12,2) not null,
  discount_total   numeric(12,2) not null default 0,
  shipping_total   numeric(12,2) not null default 0,
  tax_total        numeric(12,2) not null default 0,   -- GST
  grand_total      numeric(12,2) not null,
  currency         char(3) not null default 'INR',
  coupon_code      text,                         -- snapshot of applied discount code
  utm_source       text,                         -- attribution: 'instagram', 'google'...
  utm_medium       text,                         -- 'cpc', 'organic', 'whatsapp'
  utm_campaign     text,                         -- 'diwali-2026'
  risk_score       int,                          -- 0-100, computed at checkout
  risk_flags       jsonb not null default '[]'::jsonb,  -- ["repeat_rto","blocklisted_pincode"]
  shipping_address jsonb not null,               -- snapshot, deliberately not a FK
  placed_at        timestamptz not null default now()
);

create index idx_orders_customer on orders(customer_id);

-- Line items snapshot everything at purchase time. Catalog rows get
-- repriced, renamed, and archived -- orders must stay historically exact.
create table order_items (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references orders(id) on delete cascade,
  variant_id     uuid references product_variants(id) on delete set null,
  product_name   text not null,                  -- snapshot: "MacBook Air"
  variant_title  text not null,                  -- snapshot: "M3 / 16GB / 512GB / Midnight"
  sku            text not null,                  -- snapshot
  unit_price     numeric(12,2) not null,         -- price at time of purchase
  quantity       int not null check (quantity > 0),
  line_total     numeric(12,2) not null
);

create index idx_order_items_order on order_items(order_id);

create table payments (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references orders(id) on delete cascade,
  provider      text not null,                   -- 'razorpay', 'cod', ...
  provider_ref  text,                            -- gateway payment/order id
  amount        numeric(12,2) not null,
  status        text not null default 'created'
                check (status in ('created', 'authorized', 'captured',
                                  'failed', 'refunded')),
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------
-- Staff & admin (powers the admin console)
-- ---------------------------------------------

create table staff_users (
  id          uuid primary key default gen_random_uuid(),
  -- On Supabase: reference auth.users(id) and gate admin routes on this table
  email       text not null unique,
  full_name   text,
  role        text not null default 'support'
              check (role in ('owner', 'admin', 'manager', 'support', 'warehouse')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Generic audit log for admin actions on any table
create table audit_logs (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid references staff_users(id) on delete set null,
  action      text not null,                     -- 'update', 'delete', 'price_change'...
  table_name  text not null,
  record_id   uuid,
  changes     jsonb,                             -- {"price": {"old": 999, "new": 899}}
  created_at  timestamptz not null default now()
);

create index idx_audit_record on audit_logs(table_name, record_id);

-- ---------------------------------------------
-- Merchandising: curated collections
-- (distinct from categories -- "Diwali Sale", "New Arrivals")
-- ---------------------------------------------

create table collections (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  description text,
  image_url   text,
  is_active   boolean not null default true,
  position    int not null default 0
);

create table collection_products (
  collection_id uuid not null references collections(id) on delete cascade,
  product_id    uuid not null references products(id) on delete cascade,
  position      int not null default 0,
  primary key (collection_id, product_id)
);

-- ---------------------------------------------
-- Discounts & coupons
-- ---------------------------------------------

create table discounts (
  id                     uuid primary key default gen_random_uuid(),
  code                   text not null unique,   -- "DIWALI20"
  description            text,
  kind                   text not null
                         check (kind in ('percent', 'fixed', 'free_shipping')),
  value                  numeric(12,2) not null default 0,  -- 20 (=20%) or 500 (=Rs.500)
  min_order_total        numeric(12,2),
  applies_to             text not null default 'order'
                         check (applies_to in ('order', 'collection', 'product')),
  collection_id          uuid references collections(id) on delete cascade,
  product_id             uuid references products(id) on delete cascade,
  max_uses               int,                    -- null = unlimited
  max_uses_per_customer  int default 1,
  starts_at              timestamptz not null default now(),
  ends_at                timestamptz,
  is_active              boolean not null default true,
  created_at             timestamptz not null default now()
);

-- Enforces usage limits and answers "who used what" for support
create table discount_redemptions (
  id           uuid primary key default gen_random_uuid(),
  discount_id  uuid not null references discounts(id) on delete cascade,
  order_id     uuid not null references orders(id) on delete cascade,
  customer_id  uuid references customers(id) on delete set null,
  amount       numeric(12,2) not null,           -- what it actually saved
  created_at   timestamptz not null default now(),
  unique (discount_id, order_id)
);

-- ---------------------------------------------
-- Inventory ledger
-- Source of truth for stock. variant.stock stays as a cached
-- total, updated in the SAME transaction as each movement.
-- Reserve on payment initiation ('reservation'), release on
-- failure/timeout ('release'), convert to 'sale' on capture.
-- ---------------------------------------------

create table inventory_movements (
  id          uuid primary key default gen_random_uuid(),
  variant_id  uuid not null references product_variants(id) on delete cascade,
  quantity    int not null,                      -- positive in, negative out
  reason      text not null
              check (reason in ('purchase', 'sale', 'return', 'adjustment',
                                'damage', 'reservation', 'release')),
  order_id    uuid references orders(id) on delete set null,
  note        text,
  created_by  uuid references staff_users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index idx_inventory_variant on inventory_movements(variant_id, created_at desc);

-- ---------------------------------------------
-- Fulfilment
-- ---------------------------------------------

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
  created_at      timestamptz not null default now()
);

create index idx_shipments_order on shipments(order_id);

-- Supports partial fulfilment: one order can ship in several boxes
create table shipment_items (
  shipment_id    uuid not null references shipments(id) on delete cascade,
  order_item_id  uuid not null references order_items(id) on delete cascade,
  quantity       int not null check (quantity > 0),
  primary key (shipment_id, order_item_id)
);

-- ---------------------------------------------
-- Returns & refunds (RMA flow)
-- ---------------------------------------------

create table return_requests (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references orders(id) on delete cascade,
  customer_id  uuid references customers(id) on delete set null,
  reason       text not null,                    -- 'damaged', 'wrong_item', 'not_as_described'...
  status       text not null default 'requested'
               check (status in ('requested', 'approved', 'rejected',
                                 'pickup_scheduled', 'received', 'refunded', 'closed')),
  resolution   text check (resolution in ('refund', 'replacement', 'store_credit')),
  note         text,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);

create table return_items (
  return_id      uuid not null references return_requests(id) on delete cascade,
  order_item_id  uuid not null references order_items(id) on delete cascade,
  quantity       int not null check (quantity > 0),
  condition      text,                           -- assessed on receipt at warehouse
  primary key (return_id, order_item_id)
);

-- Refunds reference the original payment because gateways
-- (e.g. Razorpay) refund against a specific payment id.
create table refunds (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references orders(id) on delete cascade,
  payment_id   uuid references payments(id) on delete set null,
  return_id    uuid references return_requests(id) on delete set null,
  amount       numeric(12,2) not null check (amount > 0),
  provider_ref text,                             -- gateway refund id
  status       text not null default 'initiated'
               check (status in ('initiated', 'processed', 'failed')),
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------
-- Reviews & ratings
-- ---------------------------------------------

create table reviews (
  id             uuid primary key default gen_random_uuid(),
  product_id     uuid not null references products(id) on delete cascade,
  variant_id     uuid references product_variants(id) on delete set null,
  customer_id    uuid not null references customers(id) on delete cascade,
  order_item_id  uuid references order_items(id) on delete set null,  -- proof of purchase
  rating         int not null check (rating between 1 and 5),
  title          text,
  body           text,
  is_verified    boolean not null default false, -- true when order_item_id is present
  status         text not null default 'pending'
                 check (status in ('pending', 'approved', 'rejected')),
  created_at     timestamptz not null default now(),
  unique (customer_id, product_id)               -- one review per product per customer
);

create index idx_reviews_product on reviews(product_id) where status = 'approved';

-- ---------------------------------------------
-- Engagement: wishlist + back-in-stock alerts
-- ---------------------------------------------

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
  email        text,                             -- for guests
  notified_at  timestamptz,                      -- null = still waiting
  created_at   timestamptz not null default now()
);

create index idx_stock_alerts_pending on stock_alerts(variant_id) where notified_at is null;

-- ---------------------------------------------
-- Order timeline
-- Powers the admin timeline + customer tracking page,
-- and is the audit trail for disputes.
-- ---------------------------------------------

create table order_events (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders(id) on delete cascade,
  event       text not null,                     -- 'status_changed', 'note_added', 'payment_captured'...
  from_status text,
  to_status   text,
  note        text,
  actor_type  text not null default 'system'
              check (actor_type in ('system', 'customer', 'staff')),
  actor_id    uuid,                              -- customers.id or staff_users.id per actor_type
  created_at  timestamptz not null default now()
);

create index idx_order_events_order on order_events(order_id, created_at);

-- ---------------------------------------------
-- Notifications & messaging
-- Three concerns: in-app notifications, a transactional message
-- log (email / SMS / WhatsApp), and consent preferences.
-- message_log doubles as an outbox: insert as 'queued' in the
-- SAME transaction as the order, a worker actually sends it,
-- and provider webhooks flip status to delivered/bounced.
-- Order confirmations survive email-API hiccups that way.
-- ---------------------------------------------

-- In-app notification feed (the bell icon) for customers and staff
create table notifications (
  id              uuid primary key default gen_random_uuid(),
  recipient_type  text not null check (recipient_type in ('customer', 'staff')),
  recipient_id    uuid not null,                 -- customers.id or staff_users.id
  kind            text not null,                 -- 'order_shipped', 'low_stock', 'new_order'...
  title           text not null,
  body            text,
  data            jsonb not null default '{}'::jsonb,  -- deep-link payload: {"order_id": "..."}
  read_at         timestamptz,                   -- null = unread
  created_at      timestamptz not null default now()
);

create index idx_notifications_unread
  on notifications(recipient_type, recipient_id, created_at desc)
  where read_at is null;

-- Every transactional send, across every channel. Doubles as the outbox.
create table message_log (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid references customers(id) on delete set null,
  order_id      uuid references orders(id) on delete set null,
  channel       text not null check (channel in ('email', 'sms', 'whatsapp', 'push')),
  template      text not null,                   -- 'order_confirmation', 'otp', 'shipping_update'...
  recipient     text not null,                   -- email/phone snapshot at send time
  payload       jsonb,                           -- variables rendered into the template
  status        text not null default 'queued'
                check (status in ('queued', 'sent', 'delivered', 'bounced', 'failed')),
  provider      text,                            -- 'resend', 'msg91', 'gupshup'...
  provider_ref  text,                            -- provider message id, matches their webhooks
  error         text,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);

create index idx_message_log_queued on message_log(created_at) where status = 'queued';
create index idx_message_log_order on message_log(order_id);
create index idx_message_log_customer on message_log(customer_id, created_at desc);

-- Consent & channel preferences. Transactional updates default ON;
-- marketing defaults OFF -- India's DPDP Act expects explicit opt-in.
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

-- For mobile push later: add a device_tokens table
-- (customer_id, platform 'ios'|'android', fcm_token unique, last_seen_at).

-- ---------------------------------------------
-- Support tickets & enquiries
-- One unified inbox: the contact form, email, WhatsApp and
-- Instagram DMs all land here as tickets. A contact-form
-- submission is just a ticket with the guest_* fields filled.
-- ---------------------------------------------

create table support_tickets (
  id                 uuid primary key default gen_random_uuid(),
  ticket_number      text not null unique,     -- 'TKT-2026-00042', quotable on a phone call
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
  guest_email        text,
  guest_phone        text,
  first_response_at  timestamptz,              -- SLA: time-to-first-reply
  resolved_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index idx_tickets_queue on support_tickets(priority, created_at)
  where status in ('open', 'pending_internal');
create index idx_tickets_customer on support_tickets(customer_id);

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
  created_at   timestamptz not null default now()
);

create index idx_ticket_messages_thread on ticket_messages(ticket_id, created_at);

-- Structured product / bulk / quote enquiries ("price for 50 units?",
-- "can this be customised?"). Kept separate from tickets because
-- these are sales leads, not problems -- converted_order_id closes
-- the loop and tells you your enquiry -> order conversion rate.
create table product_enquiries (
  id                  uuid primary key default gen_random_uuid(),
  product_id          uuid references products(id) on delete set null,
  variant_id          uuid references product_variants(id) on delete set null,
  customer_id         uuid references customers(id) on delete set null,
  guest_name          text,
  guest_email         text,
  guest_phone         text,
  quantity            int,                     -- bulk interest
  message             text not null,
  status              text not null default 'new'
                      check (status in ('new', 'replied', 'quoted', 'converted', 'closed')),
  assigned_to         uuid references staff_users(id) on delete set null,
  converted_order_id  uuid references orders(id) on delete set null,
  created_at          timestamptz not null default now()
);

create index idx_enquiries_open on product_enquiries(status, created_at)
  where status in ('new', 'replied', 'quoted');

-- ---------------------------------------------
-- GST invoicing
-- Invoices are immutable legal documents: numbers are sequential
-- and gap-free per financial year, rows are never deleted, and
-- everything is snapshotted (customer, addresses, tax breakup).
-- Returns get a credit_note referencing the original invoice.
-- ---------------------------------------------

-- Gap-free numbering. Postgres sequences leak numbers on rollback,
-- which GST rules don't allow. Inside the invoice-creation
-- transaction run:
--   update invoice_sequences set last_number = last_number + 1
--     where fy = '2026-27' returning last_number;
-- The row lock serialises concurrent invoices, and a rollback
-- releases the number along with the invoice.
create table invoice_sequences (
  fy           text primary key,               -- '2026-27'
  last_number  int not null default 0
);

create table invoices (
  id                 uuid primary key default gen_random_uuid(),
  invoice_number     text not null unique,     -- 'INV/2026-27/00042'
  order_id           uuid not null references orders(id) on delete restrict,
  kind               text not null default 'tax_invoice'
                     check (kind in ('tax_invoice', 'credit_note')),
  parent_invoice_id  uuid references invoices(id),  -- credit notes point at the original
  customer_name      text not null,            -- snapshot
  customer_gstin     text,                     -- present for B2B buyers claiming input credit
  billing_address    jsonb not null,           -- snapshot
  seller_gstin       text not null,            -- snapshot from store_settings.config
  place_of_supply    text not null,            -- state code; vs seller state decides the split:
                                               -- same state -> CGST + SGST, different -> IGST
  taxable_value      numeric(12,2) not null,
  cgst_total         numeric(12,2) not null default 0,
  sgst_total         numeric(12,2) not null default 0,
  igst_total         numeric(12,2) not null default 0,
  grand_total        numeric(12,2) not null,
  pdf_url            text,
  issued_at          timestamptz not null default now()
);

create index idx_invoices_order on invoices(order_id);

create table invoice_lines (
  id             uuid primary key default gen_random_uuid(),
  invoice_id     uuid not null references invoices(id) on delete restrict,
  description    text not null,
  hsn_code       text,
  quantity       int not null,
  unit_price     numeric(12,2) not null,
  taxable_value  numeric(12,2) not null,
  gst_rate       numeric(4,2) not null,
  cgst_amount    numeric(12,2) not null default 0,
  sgst_amount    numeric(12,2) not null default 0,
  igst_amount    numeric(12,2) not null default 0,
  line_total     numeric(12,2) not null
);

create index idx_invoice_lines_invoice on invoice_lines(invoice_id);

-- ---------------------------------------------
-- Gift cards + store credit wallet
-- The wallet is an append-only ledger: balance = sum(delta).
-- Never store a mutable balance column for money you owe people.
-- ---------------------------------------------

create table gift_cards (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null unique,     -- consider storing a hash + last 4 in production
  initial_balance    numeric(12,2) not null check (initial_balance > 0),
  balance            numeric(12,2) not null check (balance >= 0),
  currency           char(3) not null default 'INR',
  purchaser_id       uuid references customers(id) on delete set null,
  purchase_order_id  uuid references orders(id) on delete set null,
  recipient_email    text,
  message            text,
  status             text not null default 'active'
                     check (status in ('active', 'redeemed', 'disabled', 'expired')),
  expires_at         timestamptz,
  created_at         timestamptz not null default now()
);

create table gift_card_transactions (
  id             uuid primary key default gen_random_uuid(),
  gift_card_id   uuid not null references gift_cards(id) on delete cascade,
  order_id       uuid references orders(id) on delete set null,
  delta          numeric(12,2) not null,       -- negative on redemption
  balance_after  numeric(12,2) not null,
  created_at     timestamptz not null default now()
);

-- Store credit: fulfils the 'store_credit' return resolution, and is
-- the future home for loyalty points. Spend it at checkout by adding
-- a payments row with provider = 'store_credit'.
create table credit_ledger (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references customers(id) on delete cascade,
  delta         numeric(12,2) not null,        -- positive credit, negative spend
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

create index idx_credit_customer on credit_ledger(customer_id, created_at desc);

-- ---------------------------------------------
-- Shipping zones, rates & serviceability
-- serviceable_pincodes is seeded from your courier's serviceability
-- CSV export (Delhivery / Shiprocket provide these) and answers the
-- "deliver to 560001?" check on the product page. Rates key off the
-- pincode's zone + weight + order total; store_settings flat rate
-- stays as the fallback when nothing matches.
-- ---------------------------------------------

create table shipping_zones (
  id        uuid primary key default gen_random_uuid(),
  name      text not null,                     -- 'Karnataka', 'Metros', 'North East', 'Rest of India'
  position  int not null default 0
);

create table serviceable_pincodes (
  pincode      char(6) primary key,
  zone_id      uuid references shipping_zones(id) on delete set null,
  cod_allowed  boolean not null default true,
  courier      text,                           -- preferred carrier for this pincode
  updated_at   timestamptz not null default now()
);

create table shipping_rates (
  id                uuid primary key default gen_random_uuid(),
  zone_id           uuid not null references shipping_zones(id) on delete cascade,
  min_weight_grams  int not null default 0,
  max_weight_grams  int,                       -- null = no cap
  min_order_total   numeric(12,2) not null default 0,
  rate              numeric(12,2) not null,
  cod_surcharge     numeric(12,2) not null default 0,
  delivery_days     int,                       -- shown as the estimate on the product page
  is_active         boolean not null default true
);

create index idx_rates_zone on shipping_rates(zone_id);

-- ---------------------------------------------
-- COD risk
-- Block repeat RTO offenders before they cost you two-way courier
-- fees. Checkout computes orders.risk_score / risk_flags from this
-- plus history (e.g. RTO count for the phone in the last 90 days).
-- ---------------------------------------------

create table blocklist (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('phone', 'email', 'pincode', 'ip')),
  value       text not null,
  reason      text,                            -- '3 RTOs in 60 days'
  added_by    uuid references staff_users(id) on delete set null,
  expires_at  timestamptz,                     -- null = permanent
  created_at  timestamptz not null default now(),
  unique (kind, value)
);

-- ---------------------------------------------
-- Growth: cross-sells + price history
-- Attribution lives on orders (utm_source / utm_medium /
-- utm_campaign): capture the landing-page query params in a cookie
-- client-side and stamp them onto the order at checkout.
-- ---------------------------------------------

create table product_relations (
  product_id          uuid not null references products(id) on delete cascade,
  related_product_id  uuid not null references products(id) on delete cascade,
  kind                text not null default 'related'
                      check (kind in ('related', 'upsell', 'cross_sell', 'accessory')),
  position            int not null default 0,
  primary key (product_id, related_product_id, kind),
  check (product_id <> related_product_id)
);

-- One row per price change; powers "price dropped" alerts for
-- wishlisted variants (join against wishlist_items, queue through
-- message_log) and price-over-time views in the admin.
create table price_history (
  id          uuid primary key default gen_random_uuid(),
  variant_id  uuid not null references product_variants(id) on delete cascade,
  old_price   numeric(12,2),
  new_price   numeric(12,2) not null,
  changed_by  uuid references staff_users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index idx_price_history_variant on price_history(variant_id, created_at desc);

-- Automatic capture via trigger (or do it in app code):
-- create or replace function log_price_change() returns trigger as $$
-- begin
--   if new.price is distinct from old.price then
--     insert into price_history (variant_id, old_price, new_price)
--     values (new.id, old.price, new.price);
--   end if;
--   return new;
-- end $$ language plpgsql;
-- create trigger trg_price_history after update on product_variants
--   for each row execute function log_price_change();

-- ---------------------------------------------
-- Store settings (single-row config, read by storefront + admin)
-- ---------------------------------------------

create table store_settings (
  id                   int primary key default 1 check (id = 1),
  store_name           text not null default 'My Store',
  support_email        text,
  support_phone        text,
  free_shipping_above  numeric(12,2),
  flat_shipping_rate   numeric(12,2) default 0,
  cod_enabled          boolean not null default true,
  config               jsonb not null default '{}'::jsonb,
  updated_at           timestamptz not null default now()
);

insert into store_settings (id) values (1);

-- Note: free_shipping_above / flat_shipping_rate act as the
-- fallback when no shipping_rates row matches the pincode's zone.

-- ---------------------------------------------
-- Search (no table needed -- index the catalog)
-- ---------------------------------------------

-- create extension if not exists pg_trgm;
-- create index idx_products_name_trgm
--   on products using gin (name gin_trgm_ops);
-- Gives fuzzy "iphone chrger" -> "iPhone charger" matching with
-- plain `where name % $1` queries -- no external search infra.

-- ---------------------------------------------
-- Housekeeping
-- ---------------------------------------------

-- updated_at maintenance (Supabase ships the moddatetime extension):
-- create extension if not exists moddatetime;
-- create trigger set_updated_at before update on products
--   for each row execute procedure moddatetime(updated_at);
-- (repeat for product_variants, carts)

-- ---------------------------------------------
-- Example: data needed to render a product page in one query
-- ---------------------------------------------

-- select
--   p.name, p.description,
--   (select jsonb_agg(jsonb_build_object(
--       'name', o.name,
--       'values', (select jsonb_agg(ov.value order by ov.position)
--                  from product_option_values ov where ov.option_id = o.id)
--     ) order by o.position)
--    from product_options o where o.product_id = p.id)  as options,
--   (select jsonb_agg(jsonb_build_object(
--       'id', v.id, 'sku', v.sku, 'title', v.title,
--       'price', v.price, 'stock', v.stock,
--       'description', coalesce(v.description, p.description),
--       'specs', v.specs,
--       'option_value_ids', (select jsonb_agg(vov.option_value_id)
--                            from variant_option_values vov
--                            where vov.variant_id = v.id)
--     ))
--    from product_variants v
--    where v.product_id = p.id and v.status = 'active')  as variants
-- from products p
-- where p.slug = 'macbook-air';