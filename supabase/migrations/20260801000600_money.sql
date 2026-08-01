-- ============================================================
-- 0006  Money: discounts, returns, refunds, GST invoicing, wallet
-- ============================================================

begin;

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

commit;
