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

begin;

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

commit;
