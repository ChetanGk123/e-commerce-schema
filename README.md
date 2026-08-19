# E-commerce schema

Postgres schema for an e-commerce store with full product variant support —
Amazon / Apple-style configurations where each variant carries its own price,
description, specs, stock, and images.

Built for Postgres 15+ / Supabase. 51 tables, applied as ordered migrations —
currently one squashed baseline, with changes added as new migrations beside it.

## Quick start

Setting up a real project? **[docs/setup.md](docs/setup.md)** is the
step-by-step runbook — schema, first staff user, signup wiring, store
settings, scheduled jobs, keys.

```sh
make verify   # apply every migration to a throwaway Postgres container
make test     # verify, then assert all 38 invariants
make seed     # verify, then load demo catalog + shipping data
make lint     # check for unpinned search_path, missing transactions
```

`make verify` and `make test` build and destroy their own container, so they
never touch a real database. Deploy with the Supabase CLI:

```sh
supabase db push
```

## Single-file install

For a fresh database — or for pasting into the Supabase SQL editor — combine
the migrations into one file:

```sh
make bundle          # writes dist/schema.sql
make verify-bundle   # applies that file to a clean container and tests it

psql "$DATABASE_URL" -f dist/schema.sql
```

`dist/schema.sql` is **generated**. The migrations stay the source of truth;
edit those and re-run `make bundle`, or the two will drift. The whole bundle is
one transaction, so a failure anywhere leaves the database untouched rather than
half-built.

It only knows how to *create*. To change a database that already exists, add a
migration — that is the one thing a combined file cannot do for you.

## Layout

```
supabase/
  migrations/           applied in filename order, each wrapped in a transaction
    ..._baseline        the whole schema, squashed. Sections, in order:
                          extensions      citext, pg_trgm, btree_gist, pgcrypto
                          functions_base  table-independent helpers
                          identity        staff_users, customers, addresses, consent
                          catalog         products -> options -> option values -> variants
                          commerce        orders, payments, carts, inventory, fulfilment
                          money           discounts, returns, refunds, GST invoicing, wallet
                          operations      shipping, risk, engagement, messaging, support
                          triggers        the invariants: oversell, append-only, numbering
                          indexes         access paths
                          views_rls_grants  storefront views + Row Level Security
                          auth_signup     auth.users -> customers on signup (Supabase only)
    ..._admin_rpc       operations that must be atomic (capture, ship, invoice)
    ..._catalog         search_products, shipping_quote
    ..._checkout        checkout(), apportion_taxable()
    ..._payments        webhook recording, capture, failure
    ..._inventory       sweepers, manual stock movements, reservation monitor
    ..._returns_wallet  returns, refunds, store credit, gift cards
    ..._invoicing       credit notes, the e-invoice stamp
    ..._support         erasure guard, tickets, SLA clock
    ..._jobs            the outbox drain: claim, settle, rescue
  jobs/retention.sql    cron.schedule calls only — the sweeper FUNCTIONS are
                        in the migrations, because a file nothing applies is
                        a function that quietly does not exist
  seed.sql              demo data
  tests/
    00_shim.sql         fabricates auth.users / auth.uid() for local Postgres
    01_invariants.sql   87 assertions
types/                  TypeScript types — regenerate with `make types`
apps/api/               the shared backend — see apps/api/README.md
                        browsable at /docs, importable from /openapi.json
```

## The identity contract

**`customers.id` and `staff_users.id` must equal `auth.users.id`.** Every RLS
policy compares them to `auth.uid()` directly, and neither column has a default,
so a row created without supplying that id fails immediately rather than
becoming invisible to its own owner.

Guests never get a `customers` row. Guest identity lives on `orders.email` /
`orders.phone` and `carts.session_id`.

To delete a customer, call `anonymize_customer(uuid)` **first**. It scrubs PII
while keeping orders, invoices and the credit ledger, which GST requires you to
retain. `customers.id` is `ON DELETE RESTRICT` precisely so an unscrubbed delete
fails loudly.

## Key design decisions

- The **variant is the unit of sale** — carts and orders reference `variant_id`,
  and simple products get one default variant so checkout stays uniform.
- Order items **snapshot** name, SKU and price at purchase time, so invoices stay
  historically accurate as the catalog changes.
- `inventory_movements` is the **source of truth for stock**; `variant.stock` is
  a cache the trigger maintains in the same transaction. `CHECK (stock >= 0)` is
  the oversell guard, and the row lock makes it safe under concurrency.
- `gift_cards.balance` follows `gift_card_transactions` the same way.
  `credit_ledger` has no cached balance at all — read `customer_credit_balances`.
- Ledgers and legal documents are **append-only by trigger**, not by policy, so
  the rule binds the service key and the Supabase dashboard too.
- Invoice numbers are **gap-free per financial year** (GST requires it). Order
  and ticket numbers use ordinary sequences and may contain gaps — deliberately,
  since gap-free order numbers would serialise every checkout behind one lock.
- Composite foreign keys make cross-product and cross-order contamination
  **structurally impossible**: an option value from another product, or another
  customer's line item in your return, cannot be inserted at all.
- RLS insert policies pin **state, not just ownership**. A client that can set
  its own `status` can self-approve a review or file a pre-refunded return.

## Operations

Schedule the sweepers in `supabase/jobs/retention.sql`. The one that matters is
`release_expired_reservations()` — run it every few minutes, or stock stranded by
a dead worker is never returned to the sellable pool.

Before deploying, know that:

- **Backups.** Enable PITR. An untested restore is not a backup — do a restore
  drill.
- **Pooling.** Transaction-mode pooling (Supavisor/PgBouncer) breaks the invoice
  numbering lock unless the application holds a real transaction across
  `next_invoice_number()` and the insert.
- **Secrets.** `store_settings.config` is for non-secret configuration only. Put
  gateway keys in Supabase Vault or the environment.
- **Partitioning.** `order_events`, `message_log`, `audit_logs`,
  `inventory_movements` and `price_history` grow without bound. Partition by
  month before they get large, not after.

## Staff authorization

`staff_users.role` defines owner/admin/manager/support/warehouse, and since
migration `0023_role_matrix` RLS enforces it on the tables that carry money,
identity or configuration:

| Table | Who |
|---|---|
| `staff_users` | owner/admin manage the team; everyone else reads **their own row only** |
| `store_settings` | all staff read; owner/admin write |
| `discounts`, `gift_cards` | all staff read; manager and above write |
| `customers`, `addresses` | owner/admin/manager/support; **warehouse cannot** |

The self-read on `staff_users` is load-bearing, not a convenience: the API
looks the caller up in that table on every admin request, so denying it locks
every non-owner out of the admin surface entirely.

Before this, `staff_all` gave every active staff member full read/write on all
51 tables — which meant a warehouse account could `UPDATE` its own row and set
`role = 'owner'`. One PostgREST call, no admin UI involved. `supabase/tests`
and the API's integration suite both assert that door is shut.

**Still open: `cost_price`.** Every staff member connects to Postgres as the
same `authenticated` role — PostgREST takes that from the JWT's `role` claim,
which GoTrue issues, not from `staff_users.role`. RLS is row-level; column
privileges are per database role. So "warehouse may read variants but not their
cost" is not expressible this way. It needs a database role per staff role and
JWTs that carry it. `product_variants` therefore keeps the blanket policy, and
a staff JWT can still read `cost_price` through PostgREST directly.

Two things limit the blast radius everywhere else: append-only triggers apply to
staff as well, and `audit_row()` records who changed what on the sensitive
tables.

## Testing

`supabase/tests/01_invariants.sql` asserts the guarantees above — the oversell
guard, append-only enforcement, gap-free numbering, the coupon race, gift-card
overspend, composite-FK contamination, the draft-product leak, and five RLS
privilege-escalation attempts. Plain SQL, no pgTAP dependency.

```
$ make test
...
PASS  OVERSELL GUARD -- stock cannot go negative
PASS  COUPON RACE GUARD -- max_uses = 1 blocks the second redemption
PASS  RLS -- a customer cannot insert a pre-approved review
==> all invariants hold
```
