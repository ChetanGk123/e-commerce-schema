-- ============================================================
-- 0007  Operations: shipping, risk, engagement, messaging,
--       support, audit, settings, and platform plumbing
-- ============================================================

begin;

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

commit;
