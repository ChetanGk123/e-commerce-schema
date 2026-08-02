# Setting up the database

From an empty project to a database you can build against. Roughly 20 minutes.

Every step ends with a check. Run it — several of the failure modes here are
silent, and finding them now costs a minute rather than a weekend.

- [Part A — Supabase (hosted)](#part-a--supabase-hosted)
- [Part B — plain Postgres](#part-b--plain-postgres)
- [Troubleshooting](#troubleshooting)
- [Before you take real orders](#before-you-take-real-orders)

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

Supabase Auth creates `auth.users`. Nothing creates the matching `customers`
row, so without this a shopper can sign up and then find they cannot read
their own orders — `id = auth.uid()` matches nothing.

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
make test      # applies every migration, then 37 invariant assertions
```

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

- [ ] Steps 1–8 done, every check passed
- [ ] `release_expired_reservations` scheduled and its last run is recent
- [ ] `seller_gstin` and `seller_state_code` are your real values
- [ ] Issued one test invoice and confirmed the number and tax split
- [ ] Service key is in a secret store, not in the client bundle
- [ ] PITR on, and one restore actually rehearsed
- [ ] Supabase Advisors clean
- [ ] Gateway and courier webhooks point at handlers that write
      `webhook_events` **before** acting
- [ ] Checkout sends an idempotency key
- [ ] You have read the staff-authorization caveat in `README.md` and accepted
      it, or replaced the blanket policy with a role matrix

That last one is the biggest known gap: every active staff member currently
has full access to all 51 tables, whatever the admin UI displays.
