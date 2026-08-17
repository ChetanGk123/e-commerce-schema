---
name: schema-rules
description: The rules this e-commerce schema enforces in the database and will reject you for breaking. Use when writing SQL, API endpoints, or admin/storefront code that touches orders, checkout, stock, invoices, discounts, gift cards, returns, customers, reviews, tickets, or webhooks. Also use when deciding whether an operation belongs on the server or the client, or when a write fails with a constraint or RLS error.
---

# Schema rules

51 tables. The expensive rules live in the database, not in application
code, so they bind every caller — including the service key and psql.
Breaking one is a rejected write, not a silent bug. That is the design.

Full detail: `docs/schema_guide.md`. This file is the short version.

## Never

1. **Never write `product_variants.stock`.** It is a cache. Insert into
   `inventory_movements` and a trigger updates it in the same
   transaction. `CHECK (stock >= 0)` is the oversell guard.
2. **Never create an order without an idempotency key.** Claim
   `idempotency_keys` *first*; if no row comes back, replay the stored
   response instead of doing the work again.
3. **Never act on a webhook before recording it.** Insert into
   `webhook_events` first — `unique (provider, event_id)` is what makes
   a replayed delivery a no-op instead of a second charge.
4. **Never call `next_invoice_number()` outside the transaction that
   inserts the invoice.** The number leaks and the GST sequence gains a
   gap it is not allowed to have.
5. **Never put secrets in `store_settings.config`.** Every staff member
   can read that table and it is in every backup in plaintext.
6. **Never delete a customer.** Call `anonymize_customer(uuid)` — it
   scrubs PII and keeps the records GST requires, including the credit
   ledger, which is money owed to them.

## Append-only, by trigger

`inventory_movements`, `credit_ledger`, `gift_card_transactions`,
`order_events`, `price_history`, `invoices`.

UPDATE and DELETE are refused for every role. Corrections are new rows.
An invoice is fixed with a credit note, never an edit. Never build UI
that offers an edit or delete affordance on these.

## The variant is the unit of sale

Carts, orders and stock reference `variant_id`, never `product_id`.
Simple products get one default variant so checkout has no special case.

Attach a variant's option values in **one statement**:

```sql
insert into variant_option_values (variant_id, option_value_id, product_id) values
  ('var-1', 'val-m3', 'prod-1'),
  ('var-1', 'val-16gb', 'prod-1');
```

Inserting them one at a time makes a half-built options signature
collide with a finished one, and you get a `uniq_variant_combo` error
that makes no sense.

## Server or client

If getting it wrong costs money, it happens server-side with prices read
from the database — never from the request body.

Server-only: order creation, payment capture, invoice issuing, coupon
validation, gift-card redemption by code, any stock movement.

RLS insert policies pin **state, not just ownership**. A client that can
set its own `status` can self-approve a review or file a pre-refunded
return, so those columns are pinned in the policy.

## Reading errors

| Message contains | Meaning |
|---|---|
| `product_variants_stock_check` | Overselling |
| `orders_totals_balance` | `grand_total` must equal subtotal − discount + shipping + tax |
| `discounts_within_max_uses` | Coupon spent; someone took the last use concurrently |
| `is append-only` | You tried to UPDATE/DELETE a ledger |
| `invoices are immutable` | Issue a credit note instead |
| `uniq_variant_combo` | Duplicate option combination, or you inserted option values one row at a time |
| `new row violates row-level security` | Client tried to set a column it may not choose. Do it server-side |
| `null value in column "id" of relation "customers"` | `customers.id` **is** `auth.uid()`. There is no default, deliberately |

## Identity

`customers.id` and `staff_users.id` **equal** `auth.users.id`. Neither
has a default, so a row created without supplying it fails loudly rather
than becoming invisible to its own owner. Guests get no `customers` row —
their identity lives on `orders.email` and `carts.session_id`.

Phones are E.164 (`+919876543210`). The `phone` transform in
`types/validation.ts` normalises to it. A blocklist storing a bare
10-digit number blocks nobody.

## Known accepted risk

RLS grants every active staff member full access to all 51 tables,
regardless of `staff_users.role`. Role checks in application code are UX,
not a security boundary, until a role matrix replaces the `staff_all`
policy. Do not describe role-gated UI as a security control.

## Changing the schema

`supabase/migrations/20260801000000_baseline.sql` is a squashed baseline.
Add a **new** migration beside it with a later timestamp; do not edit it.
Then `make test` — 38 assertions that each try to break a rule above and
confirm the database says no.
