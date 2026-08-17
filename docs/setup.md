# Setting up the database

From an empty project to a database you can build against. Roughly 20 minutes.

Every step ends with a check. Run it — several of the failure modes here are
silent, and finding them now costs a minute rather than a weekend.

- [Part A — Supabase (hosted)](#part-a--supabase-hosted)
- [Part B — plain Postgres](#part-b--plain-postgres)
- [Part C — self-hosted Supabase (Dokploy)](#part-c--self-hosted-supabase-dokploy)
- [Troubleshooting](#troubleshooting)
- [Before you take real orders](#before-you-take-real-orders)

> **Self-hosting?** Go to **Part C**. Part A assumes the hosted Dashboard; Part B assumes
> there is no `auth` schema at all, which is wrong for self-hosted Supabase — it has one,
> so the identity foreign keys apply and Part B would mislead you.

---

## Part A — Supabase (hosted)

### Step 1. Apply the schema

Get the single-file build:

```sh
make bundle          # writes dist/schema.sql
```

Then either paste `dist/schema.sql` into **Dashboard → SQL Editor** and run it,
or push from the CLI if you have the project linked:

```sh
supabase db push
```

The whole file is one transaction. If anything fails you get an error and an
untouched database — never half a schema.

**Check:**

```sql
select count(*) as tables from pg_tables where schemaname = 'public';
```

Expect **51**.

---

### Step 2. Confirm the identity link

This is the one that fails silently, so check it before anything else.

The schema binds `customers.id` and `staff_users.id` to `auth.users(id)`, but
only if `auth.users` exists when it runs. If that guard didn't fire, every RLS
policy will deny every request and you will spend hours thinking your keys are
wrong.

**Check:**

```sql
select conname from pg_constraint
where conname in ('customers_id_fkey', 'staff_users_id_fkey');
```

Expect **2 rows**. If you get zero, stop — see [Troubleshooting](#troubleshooting).

---

### Step 3. Create your first staff user

Nothing can be administered until a row exists in `staff_users`, and its id
must *be* an auth user's id.

1. **Dashboard → Authentication → Users → Add user.** Use a real email and
   tick "Auto Confirm User".
2. Then in the SQL Editor:

```sql
insert into staff_users (id, email, full_name, role)
select id, email, 'Your Name', 'owner'
from auth.users
where email = 'you@example.com';
```

Taking the id *from* `auth.users` rather than typing one is the whole point —
a generated id here would silently match nothing.

**Check:**

```sql
select id, email, role, is_active from staff_users;
```

---

### Step 4. Create `customers` rows on signup

Supabase Auth creates `auth.users`. Something has to create the matching
`customers` row, or a shopper can sign up and then find they cannot read their
own orders — `id = auth.uid()` matches nothing.

**Migration `0011_auth_signup` does this for you.** If you applied a current
`dist/schema.sql` or ran `supabase db push`, it is already installed — skip to
the check below.

Only paste the following if your project predates that migration (you ran an
earlier bundle). It is the same code, and it is safe to run twice:

```sql
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into customers (id, email, phone, full_name)
  values (
    new.id,
    nullif(new.email, ''),
    -- auth.users.phone is stored WITHOUT a '+' ('919876543210'), and
    -- customers.phone requires E.164. Skipping this branch means every
    -- phone signup fails the CHECK.
    case
      when new.phone is null or new.phone = '' then null
      when new.phone like '+%' then new.phone
      else '+' || new.phone
    end,
    new.raw_user_meta_data ->> 'full_name'
  )
  on conflict (id) do nothing;

  insert into communication_preferences (customer_id)
  values (new.id)
  on conflict (customer_id) do nothing;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
```

**Check** — sign up a throwaway user through your app or the Dashboard, then:

```sql
select c.id, c.email, c.phone, p.customer_id is not null as has_prefs
from customers c
left join communication_preferences p on p.customer_id = c.id;
```

The phone should read `+91…`. If it is missing its `+`, the CHECK rejected it
and the signup will have failed outright.

---

### Step 5. Store settings

`invoices.seller_gstin` is `NOT NULL` and is snapshotted from here, so
invoicing fails until this is real. Do it before your first order, not after.

```sql
update store_settings set
  store_name          = 'Your Store',
  support_email       = 'support@yourstore.com',
  support_phone       = '+918000000000',
  seller_gstin        = '29ABCDE1234F1Z5',   -- your actual GSTIN
  seller_state_code   = '29',                -- must match the GSTIN's first two digits
  free_shipping_above = 2000,
  flat_shipping_rate  = 79,
  cod_enabled         = true
where id = 1;
```

`seller_state_code` decides the tax split on every invoice you issue: same
state as the buyer means CGST + SGST, different means IGST. Getting it wrong
produces invoices that are wrong in a way the tax portal will notice.

**Check:**

```sql
select * from public_settings;   -- the view your storefront reads
```

> **Do not** put gateway keys or webhook secrets in `store_settings.config`.
> Every staff member can read that table, and it is in every backup in
> plaintext. Use Supabase Vault or your deployment environment.

---

### Step 6. Shipping zones, pincodes and rates

Nothing can be delivered until these exist. Adapt the shape below, or run
`supabase/seed.sql` for a worked example you can edit.

```sql
insert into shipping_zones (id, name, position) values
  ('a1000000-0000-4000-8000-000000000001', 'Karnataka',     0),
  ('a1000000-0000-4000-8000-000000000002', 'Metros',        1),
  ('a1000000-0000-4000-8000-000000000003', 'Rest of India', 2);

insert into serviceable_pincodes (pincode, zone_id, cod_allowed, courier) values
  ('560001', 'a1000000-0000-4000-8000-000000000001', true, 'Delhivery');

-- Bands may not overlap: rates_no_overlap refuses an ambiguous rate card,
-- so exactly one row can ever match a given basket.
insert into shipping_rates
  (zone_id, min_weight_grams, max_weight_grams, min_order_total, max_order_total,
   rate, cod_surcharge, delivery_days)
values
  ('a1000000-0000-4000-8000-000000000001', 0,    1000, 0,    2000, 49, 25, 2),
  ('a1000000-0000-4000-8000-000000000001', 0,    1000, 2000, null, 0,  25, 2),
  ('a1000000-0000-4000-8000-000000000001', 1000, null, 0,    null, 99, 25, 3);
```

In production, load `serviceable_pincodes` from your courier's serviceability
CSV (Delhivery and Shiprocket both publish one) rather than by hand.

**Check** — this must return exactly one row:

```sql
select sr.rate, sr.cod_surcharge, sr.delivery_days, sp.cod_allowed
from serviceable_pincodes sp
join shipping_rates sr on sr.zone_id = sp.zone_id and sr.is_active
where sp.pincode = '560001'
  and 1240 between sr.min_weight_grams and coalesce(sr.max_weight_grams, 2147483647)
  and 143264 >= sr.min_order_total
  and (143264 < sr.max_order_total or sr.max_order_total is null);
```

---

### Step 7. Scheduled jobs

Load the sweepers — paste `supabase/jobs/retention.sql` into the SQL Editor.

Then enable **pg_cron** (Dashboard → Database → Extensions), and schedule:

```sql
select cron.schedule('release-reservations', '*/5 * * * *', 'select release_expired_reservations()');
select cron.schedule('sweep-idempotency',    '0 * * * *',   'select sweep_idempotency_keys()');
select cron.schedule('sweep-carts',          '0 3 * * *',   'select sweep_carts()');
select cron.schedule('sweep-webhooks',       '0 4 * * 0',   'select sweep_webhook_events()');
select cron.schedule('sweep-notifications',  '0 5 * * 0',   'select sweep_notifications()');
```

Only the first is urgent. Without it, a shopper who abandons checkout at the
wrong moment holds a unit of stock hostage indefinitely, and nothing else in
the system will ever notice.

**Check:**

```sql
select jobname, schedule, active from cron.job order by jobname;
```

---

### Step 8. Wire up your application

**Dashboard → Project Settings → API** gives you three things:

| Value | Where it goes | Why |
|---|---|---|
| Project URL | both | — |
| `anon` key | the browser | RLS applies; safe to ship |
| `service_role` key | server only, in a secret | bypasses RLS entirely |

Never let the service key reach the browser. It ignores every policy in the
database.

The split that matters: reading the catalogue, reading your own orders and
writing a cart go through the anon key. **Order creation, payment capture,
invoice issuing, coupon validation, gift-card redemption and any stock
movement go through the service key on a server**, because they need to read
prices the client must not choose.

`docs/schema_guide.md` Part II has working SQL for each of those flows.

**Check** — from a terminal, using your anon key. The catalogue should be
readable and `product_variants` should not be:

```sh
curl "$SUPABASE_URL/rest/v1/products?select=name&limit=1" \
  -H "apikey: $ANON_KEY"          # expect data (or [] if empty)

curl "$SUPABASE_URL/rest/v1/product_variants?select=cost_price&limit=1" \
  -H "apikey: $ANON_KEY"          # expect [] -- cost_price is not public
```

The storefront reads `storefront_variants`, which hides `cost_price` and
excludes unreleased products.

---

### Step 9. Demo data (optional)

To see something on a page before you have real products:

```sh
psql "$DATABASE_URL" -f supabase/seed.sql
```

One product with two variants, three shipping zones, five pincodes and a
`WELCOME10` coupon. It also overwrites `store_settings`, so re-do Step 5
afterwards if you had already set it.

---

### Step 10. Security and durability

1. **Dashboard → Advisors** — run both the Security and Performance linters.
   They independently confirm the `search_path` hardening on every function.
2. **Enable PITR** (Settings → Database → Backups). An untested restore is not
   a backup; do a restore drill once.
3. **Rotate the service key** if it was ever pasted anywhere it shouldn't be.

---

## Part B — plain Postgres

No Supabase, no `auth` schema. RLS policies reference `auth.uid()`, so you
need something to provide it.

```sh
createdb mystore
psql mystore -f supabase/tests/00_shim.sql   # fabricates auth.users + auth.uid()
psql mystore -f dist/schema.sql
psql mystore -f supabase/jobs/retention.sql
psql mystore -f supabase/seed.sql            # optional
```

The shim is a **development** convenience. For a real self-hosted deployment,
replace it with your actual auth system and make `auth.uid()` read your
session's user id.

To check the whole thing works before you trust it:

```sh
make test      # applies every migration, then 38 invariant assertions
```

---

## Part C — self-hosted Supabase (Dokploy)

Self-hosted Supabase **has** an `auth` schema, so the identity contract works exactly as in
Part A. What changes is everything around the database: no Dashboard conveniences, no
managed backups, and two different URLs for the same Supabase.

Deployed from the `supabase-db` blueprint in
[`ChetanGk123/dokploy-templates`](https://github.com/ChetanGk123/dokploy-templates) — the
official Dokploy template with `kong` joined to the external `dokploy-network`.
`template.toml` generates the domains, JWT secret, anon/service keys and passwords.

### C1. Apply the schema

There is no linked project, so `supabase db push` does not apply. Use the bundle:

```sh
make bundle
psql "$DATABASE_URL" -f dist/schema.sql
```

`$DATABASE_URL` points at the `db` service — from another container on
`dokploy-network`, or through a temporary port forward from your machine.

**Check** — expect **51**:

```sql
select count(*) as tables from pg_tables where schemaname = 'public';
```

### C2. Confirm the identity link

Same check as Step 2, and it matters just as much here:

```sql
select conname from pg_constraint
where conname in ('customers_id_fkey', 'staff_users_id_fkey');
```

Expect **2 rows**. Zero means the schema ran before `auth.users` existed — apply it again
after the auth container has started once.

### C3. Two URLs, and which goes where

The single most common self-hosting mistake. Same Supabase, two addresses:

| Caller | URL | Notes |
|---|---|---|
| Your API / server containers | `http://kong:8000` | internal `dokploy-network`, no TLS, no egress |
| Browsers (Auth, Realtime) | `https://supabase.<your-domain>` | Traefik + TLS |

Getting these backwards produces failures that read like bad credentials.

### C4. pg_cron — verify, do not assume

The sweepers in `supabase/jobs/retention.sql` need pg_cron, and a self-hosted image does
not guarantee it is loaded.

```sql
show shared_preload_libraries;          -- must include pg_cron
create extension if not exists pg_cron;
```

Then load the jobs and schedule them exactly as in [Step 7](#step-7-scheduled-jobs).

If pg_cron is unavailable, call the same functions on an interval from a long-lived
service instead. Do not skip this: without `release_expired_reservations()`, a checkout
abandoned at the wrong moment holds a unit of stock hostage forever, and nothing else in
the system will notice.

**Check:**

```sql
select jobname, schedule, active from cron.job order by jobname;
```

### C5. Backups — this is now yours

**PITR does not exist here.** This database holds GST invoices you are required to retain
and a `credit_ledger` that is money you owe customers. Nothing is backing it up by default.

At minimum:

1. A scheduled `pg_dump` to off-host storage (Dokploy can schedule database backups to S3).
2. **A restore, actually rehearsed into a scratch database.** An untested backup is not a
   backup.
3. If Storage keeps product images on a local volume rather than an S3-compatible backend,
   that volume needs backing up too — it is not in the `pg_dump`.

For real point-in-time recovery rather than nightly snapshots, run WAL-G or pgBackRest
against the Postgres container.

### C6. What you lose, and the substitutes

| Hosted feature | Substitute |
|---|---|
| Security / Performance Advisors ([Step 10](#step-10-security-and-durability)) | `make lint` — already in this repo; covers unpinned `search_path` and missing transactions, which is most of what the linter caught for this schema |
| Dashboard → Add user | SQL, exactly as in [Step 3](#step-3-create-your-first-staff-user) |
| Managed PITR | C5 |

### C7. Keys

`template.toml` generates the JWT secret and both keys. The split from
[Step 8](#step-8-wire-up-your-application) is unchanged — anon in the browser, service key
server-side only — but note that **self-hosted GoTrue commonly signs with HS256 against the
shared `JWT_SECRET`** rather than asymmetric keys with JWKS. If you verify tokens yourself
anywhere, check `GOTRUE_JWT_*` in the compose before assuming JWKS.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Step 2 returns 0 rows | `auth.users` didn't exist when the schema ran | You are not on Supabase, or ran against the wrong database. Confirm with `select to_regclass('auth.users');` |
| Every API call returns `[]`, no error | RLS denying. Usually no `customers` row for the signed-in user | Do Step 4, then sign up again |
| `select *` in the SQL Editor returns nothing | Tables use `FORCE ROW LEVEL SECURITY`, so even the owner is subject to policies | Working as intended. Check with `select rolbypassrls from pg_roles where rolname = current_user;` — use the service key from your app |
| `violates check constraint "customers_phone_e164"` | A phone without its `+91` | Normalise to E.164 before insert. Step 4's trigger does this |
| `null value in column "id" of relation "customers"` | Created a customer without supplying `auth.uid()` | Their id *is* their login id — there is no default, on purpose |
| `new row violates row-level security policy` | The browser tried to set a column it may not choose (`status`, `priority`) | Do it server-side with the service key |
| `... is append-only` | Tried to UPDATE/DELETE a ledger | Insert a correcting entry instead. This binds every role, including service |
| `invoices are immutable` | Tried to edit an invoice | Issue a credit note |
| `relation "cron.job" does not exist` | pg_cron not enabled | Dashboard → Database → Extensions |

---

## Before you take real orders

- [ ] Steps 1–8 done, every check passed (self-hosted: Part C instead)
- [ ] `release_expired_reservations` scheduled and its last run is recent
- [ ] `seller_gstin` and `seller_state_code` are your real values
- [ ] Issued one test invoice and confirmed the number and tax split
- [ ] Service key is in a secret store, not in the client bundle
- [ ] PITR on, and one restore actually rehearsed — **self-hosted: your own backup job, and the restore drill matters more, not less** (C5)
- [ ] Self-hosted: `shared_preload_libraries` includes pg_cron and `cron.job` lists the sweepers (C4)
- [ ] Self-hosted: product-image storage is backed up, or Storage points at S3 (C5)
- [ ] Supabase Advisors clean
- [ ] Gateway and courier webhooks point at handlers that write
      `webhook_events` **before** acting
- [ ] Checkout sends an idempotency key
- [ ] You have read the staff-authorization caveat in `README.md` and accepted
      it, or replaced the blanket policy with a role matrix

That last one is the biggest known gap: every active staff member currently
has full access to all 51 tables, whatever the admin UI displays.
