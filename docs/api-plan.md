# API service — build plan

Shared HTTP backend for the admin and storefront apps. Tick boxes as work lands, update
**Status** and the Progress table at the bottom. Anything discovered mid-build that
contradicts this file: fix the file, don't work around it.

**Status**: `B0-B12 + B14-B18 done (bar courier/messaging webhooks), B13 scope-guarded`
**Created**: 2026-08-17
**Complexity**: Large (~3.5 weeks before the admin UI has an API to call)
**Built before**: `docs/admin-plan.md` — see [Supersedes](#supersedes-in-admin-planmd)

---

## Summary

One Hono service on Bun owning all business logic and **all database access**. Admin and
storefront become presentation layers that call it over HTTP. Background jobs stay in
`pg_cron` where `supabase/jobs/retention.sql` already puts them — except the outbox drain,
which needs network I/O and therefore lives here.

```
browser ──▶ apps/api /auth/* ──▶ Supabase Auth ──▶ session JWT
browser ──Bearer──▶ apps/api ──same JWT──▶ PostgREST ──▶ RLS + auth.uid()
                        └────service key──▶ checkout, payment capture,
                                            webhooks, staff creation
pg_cron ──▶ release_expired_reservations() · sweep_carts() · sweep_*()
apps/api ──▶ message_log outbox drain ──▶ Resend / MSG91
```

---

## Hosting: self-hosted Supabase on Dokploy

Everything runs on Dokploy. Supabase comes from
[`ChetanGk123/dokploy-templates`](https://github.com/ChetanGk123/dokploy-templates)
(`blueprints/supabase-db/`) — the official Dokploy Supabase template with `kong` joined to
the external `dokploy-network` plus a Traefik network label. `template.toml` auto-generates
the domains, JWT secret, anon/service keys and passwords.

That kong-on-`dokploy-network` change is load-bearing: it lets the API reach Supabase by
service name instead of going out and back through Traefik.

### Two URLs for the same Supabase — the footgun

| Caller | URL | Path |
|---|---|---|
| `apps/api` → Supabase | `http://kong:8000` | internal Docker network, no TLS, no egress |
| browser → Supabase Auth / Realtime | `https://supabase.<domain>` | Traefik + TLS |

Mixing these up produces errors that read like auth failures. The API's env var and the
apps' `NEXT_PUBLIC_SUPABASE_URL` are **not** the same value.

### Confirmed from the template's `docker-compose.yml`

Services: `studio · kong 3.9.1 · auth (gotrue v2.189.0) · rest (postgrest v14.12) ·
realtime v2.102.3 · storage v1.60.4 · imgproxy · meta · functions (edge-runtime) ·
analytics (logflare) · db (supabase/postgres 17.6.1.136) · vector · supavisor 2.9.5`

- ✅ **JWT is HS256 against the shared secret.** `GOTRUE_JWT_SECRET: ${JWT_SECRET}` and `PGRST_JWT_SECRET: ${JWT_SECRET}`. Asymmetric vars (`ANON_KEY_ASYMMETRIC`, `SERVICE_ROLE_KEY_ASYMMETRIC`, `JWT_KEYS`) exist but default to empty — **B1 verifies HS256, not JWKS**
- ✅ **Supavisor is in the stack.** `README.md:120` applies; already mitigated because B3 makes invoice issuing one RPC call, so it is one statement in one implicit transaction
- ⚠️ **`template.toml` is not strictly valid TOML** — shell snippets contain bare `\$` where TOML needs `\\$`. Dokploy's parser tolerates it; `tomllib` and other strict parsers reject it. Harmless on Dokploy, a trap for any other tooling that reads the template

### Still to verify at runtime (blocks B11)

- [ ] **pg_cron loaded.** `supabase/postgres` ships it, but confirm `shared_preload_libraries` and `create extension pg_cron`. **If missing, `release_expired_reservations()` never runs and abandoned checkouts strand stock silently** — see B11 for the fallback
- [ ] **Storage backend** — the compose bind-mounts `../files/volumes/storage`, i.e. **a local directory, not S3**. Confirm and decide: back that path up, or repoint Storage at S3-compatible

### What self-hosting takes away

| Hosted feature | Replacement |
|---|---|
| PITR / managed backups | **You own this.** Scheduled `pg_dump` offsite (Dokploy S3 backups) or WAL-G/pgBackRest. Plus one rehearsed restore |
| Security & Performance Advisors (`docs/setup.md:310`) | `make lint` — already in this repo; covers unpinned `search_path` and missing transactions |
| Dashboard user management | SQL, per `docs/setup.md:65` |

Resolved favorably: Dokploy runs long-lived containers, so SSE and WebSockets are
available if B13 ever needs them.

---

## Decisions (change these here, not in conversation)

### Shape

| Decision | Choice | Why |
|---|---|---|
| Backend shape | **Standalone API service** (`apps/api`) | Chosen deliberately over a shared package: one place to rate-limit and audit, and any client in any language can call it |
| Jobs | **pg_cron**, per `docs/setup.md:238` | Already written in `supabase/jobs/retention.sql`; runs even if every app is down |
| Outbox drain | **In the API** | pg_cron cannot make HTTP calls, so it cannot reach Resend/MSG91 |
| Who talks to Supabase | **Only the API** | Auth included. `/auth/*` proxies GoTrue, so the browser needs neither supabase-js nor the anon key |

### Stack

| Layer | Pick | Why here |
|---|---|---|
| Runtime | Bun | Already the package manager |
| Framework | **Hono** | Web-standard `Request`/`Response`, tiny, runtime-agnostic — you can leave Bun without a rewrite |
| Contract | **`@hono/zod-openapi`** | One Zod schema → runtime validation + TS types + OpenAPI 3.1 + typed client. `types/validation.ts` already exists; this makes it the contract |
| Typed client | `hc` (Hono RPC) | Frontends import server types; a breaking route change fails their typecheck |
| Data | `@supabase/supabase-js` + plpgsql RPCs | Preserves RLS **and** `auth.uid()`, so the audit trail survives |
| JWT | `jose` | Verify Supabase tokens — **HS256 against the shared `JWT_SECRET`** (confirmed from the template) |
| Payments | Razorpay Node SDK | **Spike in B0** — leans on Node `crypto`/`http`; Bun compat is good but unverified here |
| Tests | `bun test` | Mirrors `supabase/tests/01_invariants.sql`: try to break a rule, assert refusal |
| Logs | `pino` | Structured JSON + request id. Never log tokens, PII, or gift-card codes |
| Deploy | **Dokploy**, alongside self-hosted Supabase | Long-lived container, so SSE/WebSockets work. Reaches Supabase as `http://kong:8000` on `dokploy-network` |

### Rejected

| Option | Why not |
|---|---|
| **Prisma / Drizzle-kit migrations** | The migrations here are hand-written and **are** the product (`README.md:41`). Any ORM that wants to own migrations fights the repo. Drizzle-as-query-builder also bypasses RLS and duplicates the truth `make types` already generates |
| **tRPC** | TS-only and RPC-shaped — undercuts the "any client, any language" reason the API was split out |
| **NestJS** | DI/decorators/modules earn their keep at 10+ engineers. Here it's ceremony around validate → call RPC → map errors |
| **Elysia** | Faster and more Bun-native, but more breaking changes and ties you to Bun. Reasonable second choice |
| **Express** | No types, no modern middleware story |
| **Supabase Edge Functions** | Deno runtime fights the Bun monorepo; per-function deploys fragment a cohesive API; cold starts on checkout |

---

## The auth decision that carries the audit trail

**The API forwards the caller's JWT to Postgres. It does not swap it for the service key.**

`audit_row()` reads `auth.uid()` (`audit_row()` in `supabase/migrations/20260801000000_baseline.sql`). Run admin writes on the
service key and `staff_id` is null on every row — every price edit, discount change and
gift-card action becomes anonymous. Forwarding costs nothing: `staff_all`
(the `staff_all` policy in `supabase/migrations/20260801000000_baseline.sql`) already grants active staff full access.

Service key is for exactly four things: checkout, payment capture, webhook handlers, and
creating staff auth users. Everything else runs as the caller.

---

## Data access

Keep **PostgREST + supabase-js** for reads and single-statement writes; **plpgsql RPCs**
for multi-statement money paths (B3). supabase-js cannot hold a transaction.

A direct `postgres.js` connection would give real TS transactions and remove plpgsql
authoring — but it bypasses RLS unless you replicate PostgREST's `SET LOCAL role` +
`request.jwt.claims` per transaction, which is a second way to reach the database and a
second authorization model. **Not doing it.** Escape hatch if RPC authoring turns painful.

---

## Pattern grounding — from this repo

| Category | Source | Pattern to mirror |
|---|---|---|
| Errors | `docs/schema_guide.md:651` | The constraint→English table is already written. It becomes the error mapper, not a second invention |
| Data access | `docs/schema_guide.md:291` | "Two doors." The API is a **third** door and honors the same rule: if getting it wrong costs money, prices are read from the DB, never from the request body |
| Tests | `supabase/tests/01_invariants.sql` | Assertions that *try* to break a rule and confirm refusal. No framework, no fixtures |
| Naming | `supabase/migrations/*.sql` | `YYYYMMDDHHMMSS_area.sql`, snake_case in SQL, kebab-case for TS files |
| Validation | `types/validation.ts` | Zod already covers checkout, returns, tickets, reviews and the three admin forms. The API validates with these, not copies |
| **Logging** | **none exists** | No logging convention in this repo. Not inventing one beyond: structured JSON, request id, no secrets |

---

## Phases

### B0 — Scaffold · Low

- [x] `apps/api` — Hono on Bun, `@ecom/schema` as `workspace:*`, health route
- [x] Env: `SUPABASE_URL=http://kong:8000` (internal), service key, `JWT_SECRET` — **not** the public `https://supabase.<domain>` the browsers use. Validated in `src/env.ts`, so a missing key is a startup crash naming the variable
- [x] Export `AppType` for `hc`; wire `@hono/zod-openapi` and serve `/openapi.json`
- [x] `pino` request logging with a request id (`x-request-id` honoured inbound, echoed outbound)
- [x] **Spike: Razorpay Node SDK under Bun — PASSES.** `razorpay@2.9.8` instantiates and `validateWebhookSignature` works over `node:crypto`, including rejecting a tampered body. **Not** yet exercised: live HTTP to Razorpay's API (needs real credentials), so the `fetch` fallback stays on the table for B6
- [x] **Validate**: `turbo typecheck` + `turbo build` green, `bun test` 5/5, `/health` + `/openapi.json` respond live

Resolved along the way: `@hono/zod-openapi@0.19.10` peers on `zod >=3.0.0`, so the
v3 pin in `@ecom/schema` is compatible — no split zod versions across the workspace.

### B1 — Auth & request context · Medium · **blocks everything**

- [x] Verify the Supabase JWT with `jose` — **HS256 against the shared `JWT_SECRET`**. Not JWKS
- [x] Per-request supabase-js client bound to the caller's token (`callerClient`: anon key as `apikey`, caller JWT as `Authorization`)
- [x] Resolve caller → staff (`staff_users`, `is_active`) or customer; 401 vs 403 distinguished, and 401 never says *why*
- [x] `requireRole(...)` middleware using `STAFF_ROLES`
- [x] Separate service-key client, documented to the four allowed paths
- [x] `GET /me` — what the admin shell calls to gate its nav
- [x] **Validated against the running self-hosted Supabase**, not mocks:

| Case | Result |
|---|---|
| no token / garbage / wrong secret / expired / no `sub` | 401 |
| customer's valid JWT | 403 — the missing `staff_users` row is the only thing stopping them |
| active staff JWT | 200 `{role: "owner"}` |
| **price edit on staff JWT** | `audit_logs.staff_id = 879e14e1…` ✅ |
| **same edit on service key** | `audit_logs.staff_id = NULL` — anonymous |

That last pair is the api-plan's central claim, demonstrated rather than
asserted: same table, same operation, attribution present only when the JWT is
forwarded. `bun test` 12/12.

### B2 — Errors & response envelope · Low

- [x] Constraint name → HTTP status + user copy, seeded from `docs/schema_guide.md:651` (`src/errors.ts`, 28 rules)
- [x] Unmapped DB errors → 500 with a support code, never the raw message
- [x] `throwOnDbError()` — supabase-js *returns* errors rather than throwing, which is exactly how a refusal gets reported to a customer as success
- [x] Identity failures (`customers.id` null) classified as **500, our bug**, not a 422 aimed at the caller
- [x] **Validated**: overselling returns 409 "Not enough stock for one or more items." Fixtures are Postgres strings captured verbatim from the running instance, so a constraint rename fails the tests instead of silently degrading every error to a 500. `bun test` 26/26

### B3 — Migration `0012_admin_rpc.sql` · Medium · **blocks B5, B7–B9**

- [x] `admin_issue_invoice(order_id, place_of_supply)` — `next_invoice_number()` + invoice + lines, one txn; CGST/SGST vs IGST from `store_settings.seller_state_code`
- [x] `admin_ship_order(order_id, items[], carrier, tracking)`
- [x] `admin_capture_cod(order_id)` — release → sale → payment → status → event
- [x] `admin_cancel_order(order_id, reason)`
- [x] `admin_receive_return(return_id, items[], resolution)`
- [x] `grant execute on function anonymize_customer(uuid) to authenticated;` (revoked from public at `anonymize_customer()` in `supabase/migrations/20260801000000_baseline.sql`)
- [x] Views `admin_sales_daily`, `admin_low_stock` — granted to `authenticated` only, **never `anon`**
- [x] Every function `security definer` + `set search_path = public, pg_temp` (pg_temp **last**)
- [x] **Validate**: extend `supabase/tests/01_invariants.sql`; `make test` green at 38+

### B4 — Catalog reads · Medium

- [x] Products, variants, options, categories, collections; storefront reads `storefront_variants`, admin reads base tables
- [x] Search via `pg_trgm` (`idx_products_name_trgm`, `idx_variants_sku_trgm`)
- [x] Pincode serviceability + shipping rate lookup
- [x] **Validate**: a storefront-scoped call never returns `cost_price`; a draft product is invisible to it

**Decided here.** The storefront runs on `anonClient()` — the anon role — even for a
signed-in caller, so RLS is what scopes it rather than a WHERE clause a handler can
forget. Forwarding a staff token to `/catalog` would have widened the public storefront
to unpublished products.

Two functions went into SQL rather than TypeScript, both SECURITY INVOKER so one
implementation serves the storefront and the admin and RLS decides the difference:

- `search_products` — PostgREST cannot express trigram similarity. It pins
  `pg_trgm.word_similarity_threshold` per call via `set_config`; the SET clause on the
  function fails because pg_trgm is not preloaded, so the GUC is a placeholder at DDL
  time and setting one needs superuser.
- `shipping_quote` — the rate-band predicate has to mirror `rates_no_overlap`'s
  half-open ranges exactly. `docs/schema_guide.md` had it as `BETWEEN`, which matched
  two bands at a shared boundary; corrected there, and now asserted in the invariants.

Validation failures also gained the standard error envelope (`defaultHook`), which they
did not have before — every 400 was answering with raw `ZodError` internals.

### B5 — Cart & checkout · **High**

- [x] Cart CRUD; guest carts by `session_id`, logged-in by `customer_id`
- [x] Checkout in **one transaction**: idempotency key **first** → order → items → reservation (with `expires_at`) → redemption → payment → outbox message → store response
- [x] Prices, totals and discounts recomputed server-side from the DB
- [x] **Validate**: replay the same idempotency key → same response, one order; oversell → 409; a spent coupon → 409

**Decided here.**

*The order is inserted before the reservations*, not after as `schema_guide` §20
shows. `inventory_movements` is append-only, so `order_id` cannot be filled in
later, and `admin_capture_cod` finds its reservations by `order_id`. Same
transaction either way, so the oversell guard is untouched.

*Guest carts run on the service key.* The schema says why in as many words —
there is no trustworthy session identity in a JWT-less request, so `carts` has
no policy for `anon`. `X-Cart-Session` is therefore a **bearer credential**, not
an identifier: server-generated, never derived from client input, worth exactly
one anonymous basket. It must never be logged or put in a URL. This is a fifth
service-key path beyond the four in the Hosting section.

*Checkout must NOT use the service key.* `checkout()` takes the customer from
`auth.uid()`; on the service key that is null and every order silently becomes a
guest order — no `customer_id`, invisible in "my orders", unattached to the
account that paid.

*Refusals carry SQLSTATEs Postgres never raises* — `ECOM1` → 422, `ECOM2` → 409 —
with a machine code in `hint` and customer-facing copy in the message. That
SQLSTATE is proof of authorship, which is what lets `apps/api` forward these
strings verbatim while still refusing to forward anything Postgres wrote.

*Beyond the four bullets*: the COD blocklist is now consulted at checkout and
sets `risk_flags`. Nothing else in the plan referenced that table, and it exists
for exactly this.

### B6 — Payments & webhooks · **High**

- [x] Razorpay order creation and capture
- [x] Webhook handler: verify signature → **insert `webhook_events` before acting** → process → set `processed_at`
- [x] Capture converts reservation → release + sale
- [ ] ~~Courier and messaging provider webhooks~~ — **deferred, not blocked.** The
      pattern is done and reusable (`record_webhook` / `mark_webhook_processed`), but
      the signature scheme is provider-specific and no courier or SMS provider has been
      chosen. Inventing one would be worse than leaving it: ~20 lines each once the
      provider is picked, updating `shipments.status` and `message_log.status`
- [x] **Validate**: deliver the same webhook twice → one state change, second is a no-op

**Decided here.**

*Acknowledgement means recorded, not acted on.* Once a delivery is safely in
`webhook_events` the handler answers 200 even if processing failed, with the
reason in `webhook_events.error`. A non-2xx would make Razorpay retry for days
over something a retry cannot fix — a captured payment for stock that is gone
needs a person. 5xx is reserved for the one case a retry does fix: the delivery
could not be written down at all. Re-driving unprocessed rows is B11's job.

*`processed_at` is the gate, not the unique index.* A duplicate whose first
attempt failed still needs processing, so the question is never "have I seen
this?" but "did it finish?".

*Unverified deliveries are rejected without being recorded.* Writing them down
would give forensics and also let anyone fill the table by posting garbage. The
rejection goes to the log instead.

*`payment.failed` does not release the hold*, contrary to `schema_guide` §20's
"release only". It is not terminal at Razorpay — a mistyped OTP fires it and the
customer retries in the same session, so releasing would hand their basket away
mid-checkout and leave the retry with no hold. `expires_at` plus
`release_expired_reservations()` is the release mechanism; a terminal failure is
a cancellation, and `admin_cancel_order` releases immediately.

*Opening the gateway order is a separate call from checkout.* Checkout is one
database transaction; an outbound HTTP call inside it would hold that
transaction open across the internet and a gateway timeout would roll back a
good order.

**Not verified**: the outbound call to Razorpay's API. There are no live
credentials here, so only the failure path is proven (a clean 502, no gateway
detail leaked). Everything on this side of the wire is verified end to end.

### B7 — Inventory & fulfilment · Medium

- [x] Movements ledger reads; receive / adjust / damage with `created_by`
- [x] Shipments via `admin_ship_order`; low-stock queue (`idx_variants_low_stock`)
- [x] Reservation monitor + last run of `release_expired_reservations()`
- [x] **Validate**: no endpoint anywhere writes `product_variants.stock`

**Found here, and it was live.** `release_expired_reservations()` did not exist
in the database at all. The sweepers lived in `supabase/jobs/retention.sql`,
which is not a migration and which nothing applies — so every reservation whose
payment never landed held its stock permanently, and nothing would ever have
said so. `inventory_health()` found four stranded holds on its first run.

The function definitions now ship in `20260801001600_inventory.sql`.
`jobs/retention.sql` keeps only the `cron.schedule` calls, which is the part
that was always right: *running* a sweeper is an operational decision and must
not be a side effect of a deploy. Defining one is not.

**Decided here.**

*Manual movements go through `record_stock_movement()`, whose reason allow-list
refuses `sale`, `reservation` and `release`.* A release row consumes a stock
hold, so an admin endpoint able to write one could invent stock out of nothing.

*`created_by` comes from `auth.uid()`, and there is no parameter for it.* An
adjustment nobody is attached to is an adjustment nobody has to explain. The
note is mandatory for the same reason.

*The validation bullet is checked against the source*, not against one handler
(`test/inventory.test.ts`). "No endpoint anywhere" is a claim about the whole
codebase, and a test of one route cannot catch the next route.

### B8 — Returns, refunds, credit, gift cards · High

- [x] Return request (customer) → approve → `admin_receive_return` (staff)
- [x] Refunds against the original payment; provider ref unique (already in the baseline)
- [x] Credit ledger entries; balance read from `customer_credit_balances`, never summed by hand
- [x] Gift cards — issue returns the code **once**; lookup by `digest(code,'sha256')`, server-side only
- [x] **Validate**: overspend a gift card → refused; return more than ordered → refused

**Found here.** `payments.provider_ref` holds the gateway **order** id, which is
what the webhook resolves against — but Razorpay refunds against the **payment**
id. One column cannot be both, so no refund could be issued at all. Added
`payments.provider_payment_ref`; `capture_payment` now stores both.

Also: **pgcrypto lives in the `extensions` schema on Supabase**, not `public`.
The baseline's `create extension if not exists pgcrypto` was a no-op because the
image had already installed it there, so every function with
`search_path = public, pg_temp` sees neither `digest()` nor `gen_random_bytes()`.
The gift-card functions name `extensions` explicitly (a search_path entry for a
schema that does not exist is ignored, so this is safe on plain Postgres too).

**Decided here.**

*`request_return` is SECURITY INVOKER.* RLS already says the right thing —
`own_returns_i` pins status to `requested`, `own_return_items_i` pins `condition`
to null so nobody grades their own goods. A definer function would throw all of
that away and reimplement it worse. What the function adds is the one thing RLS
cannot: the request and its lines in one transaction.

*A refund is recorded before the gateway is asked*, same reasoning as the webhook
handler. If the gateway is unreachable the row stays `initiated` — visible and
retryable via `/admin/refunds/{id}/settle`, which is also the COD path, where a
human moves the money and is the only one who knows it happened.

*A partial refund does not move the order to `refunded`.* That status tells the
warehouse to stop shipping goods the customer is still owed.

*Gift cards redeem whole, to store credit.* A card with a balance and a customer
with a balance are two places money can be; the credit ledger already handles
spending a bit at a time. Every redemption failure returns one message —
distinguishing "expired" from "unknown" tells someone guessing codes that they
guessed one.

**Known gap**: checkout cannot yet *spend* store credit. `credit_ledger` has the
`order_payment` reason waiting for it, but B5's checkout takes only `razorpay`
and `cod`. Not in any phase's checklist — flag for B12.

### B9 — GST invoicing · Medium

- [x] Issue via `admin_issue_invoice`; credit note against a parent invoice
- [x] e-invoice fields (IRN, ack no, signed QR) writable once, then final
- [x] **Validate**: numbers gap-free within a financial year; editing an invoice → refused

**Found here.** `protect_invoice()` pinned the IRN but **not** `ack_no`,
`ack_date` or `signed_qr` — so a signed QR on a filed invoice could be replaced
after the fact while the IRN it belongs to stayed put. That is exactly the
tampering the signature exists to make detectable. The whole stamp now freezes
together; `pdf_url` stays mutable, because regenerating a PDF from unchanged
data is housekeeping, not an amendment.

Also: B9 is the first phase to put the **B3-era admin RPCs behind HTTP**, and
they raise plain SQLSTATEs rather than the `ECOM1`/`ECOM2` codes introduced in
B5. Every one of them answered **500**. Issuing an invoice twice — the most
ordinary mistake there is — told the admin to contact support. `errors.ts` now
carries message rules for them plus a SQLSTATE fallback
(`P0002`→404, `55000`/`55006`/`23505`→409, `42501`→403, `22023`→422) with
generic copy, since a standard SQLSTATE is no proof we wrote the text. New
functions should still use ECOM codes; the older ones can migrate as they are
touched.

**Decided here.**

*Credit notes share the tax-invoice number series.* Rule 46 asks for one
consecutive series per financial year and does not require a separate one. The
`INV/` prefix on a credit note reads oddly and is left alone — changing the
format would renumber nothing and confuse everything already filed.

*Quantities are credited pro rata of each parent line's `taxable_value`,* not at
`unit_price × quantity`. The line already carries its share of the order
discount, so crediting at list price would refund tax on money the customer
never paid.

*There is no PATCH on an invoice, anywhere in the API.* `protect_invoice()` is a
trigger, so it refuses the service key too. A route offering an edit would be a
promise the database will not keep.

### B10 — Customers, support, engagement · Medium

- [x] Customers, addresses, communication preferences; `anonymize_customer` behind `owner`/`admin`
- [x] Support tickets + messages (`is_internal` never exposed to customers), enquiries
- [x] Reviews moderation; `is_verified` is generated — read only
- [x] Notifications, stock alerts, wishlist
- [x] **Validate**: a customer cannot read an internal ticket note or set ticket priority

**Found here, and it was live.** `anonymize_customer()` is SECURITY DEFINER,
takes a customer id, and had **no authorisation check of any kind**. B3 granted
it to `authenticated` so the API could call it. Between them, any signed-in
shopper could erase any other customer — name, email, phone, addresses, consent,
wishlist, stock alerts, and the address on every past order. Reproduced against
the live database before fixing: three lines of SQL as an ordinary shopper.

Now guarded inside the function, not in a handler: a customer may erase
themselves (the DPDP right), anyone else needs `owner` or `admin` via the new
`staff_has_role()`. The check has to live in SQL — every staff member can reach
PostgREST directly with their own JWT, so a guard in a route is advice.

**Decided here.**

*The customer-facing ticket schema does not declare `isInternal` at all.* It
briefly did, as an optional field, and the first version of the test missed it
because both schemas sit behind `$ref`s — the test now resolves refs before
searching. `AdminTicket` also had to override `messages` explicitly: `.extend()`
does not reach inside an array, so it was publishing a contract that understated
what staff actually receive.

*`open_ticket` and `request_return` are both SECURITY INVOKER.* RLS already pins
status, priority, assignment and ownership on insert; a definer function would
discard all of it and reimplement it worse. What they add is atomicity.

*Reviews are moderated by status only.* Rating, title and body are the
customer's words, and an endpoint letting staff edit them turns the review
section into marketing copy.

### B11 — Jobs · Low

- [x] **Confirm pg_cron is loaded** and the extension created — done in B7. It was **not**: the extension had never been created, so nothing was scheduled
- [x] Schedule `pg_cron` per `supabase/jobs/retention.sql`
- [x] **Fallback if pg_cron is unavailable**: the API checks `sweeper_scheduled` once at boot and runs the sweepers in-process only when pg_cron does not. The stated trade-off holds — those sweepers stop when the API stops — so it stays off whenever cron has the job
- [x] **Outbox drain in the API**: claim → send → settle, with `FOR UPDATE SKIP LOCKED`
- [x] Drain endpoint secret-guarded, **and** an interval loop in-process
- [x] **Validate**: kill the mail provider → rows stay `queued`, nothing is lost; restore → they drain
- [x] **Webhook redrive** — `redriveWebhooks()` beside the drain, and `GET /admin/webhooks` for what it gave up on. B6 deferred this here and nothing picked it up: `routes/webhooks.ts` recorded a failed capture, answered 200 and moved on, so a `payment.captured` that failed on a transient error left the customer charged and the order pending, permanently

**Found here.** The outbox had a producer and no consumer. `checkout()` has
queued an order confirmation for every order ever placed, and nothing read them:
eight messages sitting in `message_log`, oldest from the previous day.

**Decided here.**

*The claim is a state transition, not a lock held across the send.* One statement
moves a batch to a new `sending` state under `FOR UPDATE SKIP LOCKED`, so two API
instances split the queue instead of sending the same email twice. That needed a
status the CHECK constraint did not allow, and with it the obligation to rescue
rows a dead drainer leaves behind — `requeue_stalled_messages()`, scheduled with
the other sweepers.

*The stall clock starts at the claim, not at the queue.* The first version
measured from `created_at`, which would requeue a message queued last week and
claimed four seconds ago — while a drainer was still mid-send, so the second copy
would go out. Caught by the invariant, fixed with a `claimed_at` column.

*`attempts` increments at claim time, not at failure.* A message that kills the
process on every attempt would otherwise look untried forever, and that is
exactly the message worth noticing.

*The webhook redrive counts tries, not deliveries, for the same reason.* It
re-records the delivery through `record_webhook()` rather than bumping a column,
so `attempts` means "we tried" whether the caller was Razorpay redelivering or
the job retrying. A gateway that gives up early does not leave us retrying
forever, and an outage that stops us from trying at all does not burn the
budget. Twenty attempts, then it goes quiet and `GET /admin/webhooks` names it.

*The redrive rides on `POST /jobs/drain` instead of taking its own endpoint.*
A deployment running `JOBS_INTERVAL_SECONDS=0` has one cron entry, pointed
there. A second endpoint it was never told to call is a fix that misses the
deployment most exposed to the bug.

*With no provider the drain claims nothing.* Claiming would burn an attempt
against a send that was never going to happen, and five passes later the row
would be `failed` for the crime of the store not having wired up mail yet.

**Not verified**: a successful send through Resend, for want of credentials. The
failure path is proven live (real 401 from Resend, rows requeued with the reason,
attempts climbing, nothing lost); the success path is proven at the SQL level.

### B12 — Cross-cutting · Medium

- [x] Idempotency middleware for every money-moving POST
- [x] Rate limiting — checkout, cart, enquiries, stock alerts, reviews, returns, gift-card redemption, erasure, payments
- [x] Publish the `hc` client type — `packages/client`
- [x] CORS locked to configured origins, and **closed when none are set**
- [x] Request body cap (not in the original list; one line, and without it a single request can allocate until the process dies)
- [x] **Validate**: the spec covers every route, and no route is declared with `app.get(...)`; `@ecom/client` typechecks against `hc`

**Decided here.**

*CORS is closed by default.* With `CORS_ORIGINS` unset no browser origin is
allowed. A permissive policy on a service holding the service key is how a
shopper's session gets driven from a page they never opened. Server-to-server
callers — webhooks, cron, curl — send no `Origin` and are unaffected.

*The rate limiter is per-instance and per-IP, and says so.* It is a guard against
a script hammering `/enquiries`, not a quota system: three containers means three
times the limit. **Do not answer that by setting `RATE_LIMIT_PER_MINUTE=0` and
letting Traefik do it** — Traefik's buckets are per middleware, while this is one
shared budget per IP with per-surface costs, and the sharing is what makes it
useful. `docs/setup.md` C8 has the split that works: Traefik for volume, this for
which surface costs what. Two limiters doing the same job disagree; these do
different jobs.
`X-Forwarded-For` is read **only** when `TRUSTED_PROXY_HEADER` names it —
trusting it unconditionally lets any caller pick their own bucket by forging it.

*Sign-in is limited twice, and the second one is not in this process.* Per-IP
stops one machine; it cannot see a credential list replayed a few tries at a
time across a thousand addresses, every one inside its own budget. Ten failures
against one email address in fifteen minutes locks that address for fifteen —
counted in Postgres (`auth_attempts`), because two containers must not mean two
counters. See `20260801002800_signin_lockout.sql` for the tradeoffs, including
the one it costs you.

*The idempotency middleware is not a lock, and checkout keeps its own.* Two
simultaneous requests with one key both proceed; the second gets a 409 only
because the first has committed. That is enough for a human clicking twice, which
is what it is for. Genuine concurrency needs the guarantee inside the
transaction, which is exactly why `checkout()` claims its key in the same
transaction that reserves the stock.

*`packages/client` exists so a front end cannot import the server.* `@ecom/api`'s
entry pulls in `app.ts` → `env.ts`, which throws at import without the service
key — as it always would in a browser. The client imports `AppType` with `import
type`, which is erased before the bundler sees it.

**Found here**: two bugs the tests caught. `idempotency_keys.customer_id` has a
foreign key to `customers`, and a staff member has no row there — so every
staff-initiated claim failed on the FK and answered 500. And `apps/api` used
`Bun.CryptoHasher`, which forced `@types/bun` onto anything reading the API's
types; both hashers now use `node:crypto`.

**Not done**: `apps/admin` and `apps/store` do not exist, so "both apps typecheck
against `hc`" cannot be verified. `packages/client` typechecks, which is the same
code path.

**Was still open, now closed**: checkout can spend store credit
(`20260801002500_credit_at_checkout.sql`). `credit_ledger.order_payment` has a
caller, the debit happens in the checkout transaction under a per-customer lock,
and credit covering the whole order marks it paid without a gateway.

### B13 — Realtime · Low · *scope-guarded*

Hono supports SSE (`hono/streaming`) and WebSockets (`hono/bun`), but the default here is
to build neither.

- [ ] Notification feed (new order, low stock, new ticket) → **Supabase Realtime, browser-direct** against the `notifications` table. RLS gates it. Backend code: none
- [ ] Hono **SSE** only for data the API computes that is not a raw table change (live dashboard aggregates)
- [ ] Hono **WebSockets** only if a client must *send* over the socket — support-ticket chat is the sole candidate, and POST + SSE is simpler
- [ ] **Known deviation**: browser-direct Realtime reopens a browser↔Supabase path, partially bypassing "one place to rate-limit and audit". Accepted for read-only, RLS-gated event delivery
- [ ] **Scaling**: Postgres Changes filters per connection. A dozen staff is fine; thousands of customers each watching their own order is not — poll the tracking page every 30s instead

### B14 — Orders · Medium · *not in the original plan*

- [x] `GET /orders`, `GET /orders/{id}` — the customer's own, with the `order_events` timeline
- [x] `GET /admin/orders`, `GET /admin/orders/{id}` — the console admin-plan Phase 4 calls "the core"
- [x] `POST /admin/orders/{id}/capture-cod` → `admin_capture_cod`
- [x] `POST /admin/orders/{id}/cancel` → `admin_cancel_order`
- [x] **Validate**: a staff caller gets 0 from `/orders`, not the store's 9; a foreign order is 404; the cancellation note reaches staff and not the customer

**Found here.** No phase owned reading an order. Every phase from B6 on could *act*
on one — invoice it, ship it, refund it — and `orders` was read in exactly one
place in the service (a guest lookup in `payments.ts`). Both "my orders" and the
admin console had nothing to call, and the indexes built for them
(`idx_orders_open`, `idx_orders_placed`, `idx_orders_email`) had no caller.

Two B3 RPCs were in the same position: `admin_capture_cod` and
`admin_cancel_order` were written, granted and covered by SQL tests, and no
route reached either. So COD orders — the common payment method in this market —
could not be marked paid at all, and the only immediate reservation release B6
names was unreachable.

`errors.ts` already carried `order_not_cancellable` and `order_not_pending`.
Those rules were written in B9 for functions nothing called.

**Decided here.**

*Two order shapes, not one with nullable fields.* `risk_score`, `risk_flags`,
the UTM columns and `customer_id` are absent from the customer projection
itself, not stripped while shaping — the database never sends them to a handler
that could leak them.

*`order_events.note` is admin-only.* Unlike `ticket_messages` it has no
`is_internal` column, so the schema never decided the question; a cancellation
reason reading "suspected fraud, third RTO" would otherwise land in the
customer's own timeline. Verified live: staff see the note, the customer sees
that the status changed.

*Scoped in the query, not by RLS* — the rule `fdfbe8d` established. A staff
caller with no `customers` row gets 0 orders rather than all 9.

*Capture takes an Idempotency-Key; cancel does not.* Capture books money and a
stock sale, so a double-click must replay rather than re-run. Cancel's status
check makes a second attempt a 409 that says why, which is the more useful
answer.

*No payment-provider filter on the console.* It needs an inner join on
`payments`, which silently drops every order with no payment row — exactly the
ones someone filtering by payment is hunting for.

**Not built**: guest order tracking. A guest order has no `customer_id`, so
`/orders` cannot reach it and an unauthenticated lookup needs a signed link or
an emailed token — a scheme worth designing rather than inventing. Storefront
S4 needs it before launch.

### B15 — Staff accounts · Low · *the fourth service-key path*

- [x] `POST /admin/staff` — auth user on the service key, `staff_users` row as the calling owner
- [x] `GET /admin/staff` — the Phase 9 list, `include_inactive` off by default
- [x] `PATCH /admin/staff/{id}` — role, `is_active`, name
- [x] **Validate**: a warehouse account gets 403 from all three; a created account signs in, resolves through `/me`, and is refused an owner-only route; deactivation cuts off a still-valid JWT on the next request

**Found here.** The service key had four documented jobs and only three routes.
`staff_users.id` is `auth.users.id` with no default and — unlike `customers`,
which `handle_new_user()` fills in — no trigger behind it, so a staff account
needs the auth user and the row written together. Nothing did that, so there was
no supported way to create a staff member at all; the existing accounts were made
by hand. `requireRole` had been sitting in `auth.ts` since B1 with no caller.

**Decided here.**

*The owner check means different things on different routes, and the file says
so.* On create it is a real boundary: minting an auth user needs the service
key, which no staff JWT can reach. On read and update it is UX — `staff_all`
covers `staff_users` like every other table, so any active staff member can
already write it through PostgREST. Calling both "security" would be the
mistake B11 exists to fix.

*The row insert runs as the caller, not on the service key.* `staff_users`
carries an audit trigger, and `audit_row()` reads `auth.uid()` — on the service
key the record of who granted admin access would say nobody did. Proven live:
`audit_logs.staff_id` came back as the calling owner's uid.

*A password is set, not an invite emailed.* The mail path here is optional and
unproven (B11 drained the outbox against a real 401 from Resend); an invite that
never arrives is a staff member who cannot sign in with nothing to show for it.
`email_confirm` is set for the same reason.

*No rollback if the row insert fails after the auth user exists.* It would not
work — `handle_new_user()` has already written a `customers` row and
`customers.id` is ON DELETE RESTRICT — and it is not needed: an auth user with
no `staff_users` row is exactly a shopper account, which is what every signup
starts as. It is logged, because the email is now taken.

*An owner cannot edit their own row.* That one rule is also what makes lockout
impossible: no owner can demote or deactivate themselves, so at least one active
owner always survives. No "count the owners" query needed.

*Deactivation is the delete.* `audit_logs.staff_id` and
`inventory_movements.created_by` reference these rows.

**Not built**: promoting an existing customer account to staff. `createUser`
refuses the duplicate email with a 409 that says so. It needs a lookup by email
that the admin API does not offer directly — worth doing deliberately rather
than guessing at.

### B16 — Auth surface · Medium · *reverses a B0 decision*

- [x] `POST /auth/sign-up` · `sign-in` · `refresh` · `sign-out`
- [x] `POST /auth/password/forgot` · `password/change`
- [x] Rate limits: sign-in 10, sign-up 15, reset mail 20, password change 10
- [x] Per-account sign-in lockout: 10 failures / 15 min locks the address for 15 min, across every IP; a completed password reset lifts it
- [x] **Validate**: a wrong password and an unknown email answer identically; the issued token works on `/orders`; sign-out kills the refresh token; a password change invalidates the old password

**The decision that changed.** B0 had the browser talk to Supabase Auth
directly and reserved this service for everything else. That was wrong for the
reason this service exists: *one place to rate-limit and audit*. An auth path
that goes around the API cannot be rate-limited here, cannot consult the
blocklist, and answers in a second error envelope no client can branch on.
Sign-in is the single most attacked endpoint a store has, and it was the one
endpoint we had no way to see.

The browser now holds no Supabase credentials at all — no anon key, no
`NEXT_PUBLIC_SUPABASE_URL`, no supabase-js.

**Decided here.**

*A proxy, not a reimplementation.* Every handler forwards to GoTrue's REST API
and maps the answer into this service's envelope. GoTrue keeps owning sessions,
token rotation and password hashing. Rewriting any of that would be strictly
worse than what it replaced.

*Tokens come back in the body, not as `Set-Cookie`.* This service is consumed by
browsers and by anything else that speaks HTTP, so it stays stateless and
framework-neutral; the browser client puts the session in an httpOnly cookie
server-side. Never localStorage.

*Sign-in gives nothing away; sign-up does, deliberately.* A wrong password and an
unknown email are one message, verified identical. Sign-up says when an address
is taken — that is an enumeration oracle and it is the right trade, because the
alternative is a silent fake success and, on a store whose mail path is unproven
(B11), a shopper who cannot sign in and is told nothing. `password/forgot`
always answers 202, since there is nothing an honest caller would do
differently.

*Sign-out revokes the refresh token, and says so.* The access token already
issued stays valid until it expires — it is a signed bearer token and nothing
can recall it. Short lifetimes bound the window; pretending otherwise would be
the lie.

*`/auth/refresh` is not rate-limited.* Refresh tokens are long and random, so
there is nothing to brute-force, and a legitimate client calls it on a timer.

**Not built**: OAuth and magic links. Both are redirect flows whose callback
would have to land somewhere and be exchanged, which is a design rather than a
proxy. Email confirmation is handled — sign-up answers 202 with
`confirmationRequired` when the project demands it.

### B17 — Email, ours end to end · Medium

- [x] `admin/generate_link` mints the code; **GoTrue never sends anything**
- [x] `password/forgot` queues to `message_log`; `POST /auth/password/reset` spends the code
- [x] `POST /auth/verify` (signup · email change · invite) and `POST /auth/email/change`
- [x] Templates for all four auth mails, beside `order_confirmation`
- [x] **Configurable provider**: `MAIL_PROVIDER=resend|smtp`, inferred when unset
- [x] **Validate**: a real SMTP conversation delivered the code; the same build on Resend requeued it instead; forgot → drain → reset → signed in

**Found here, and it was live.** GoTrue could not send email at all. The Dokploy
template points SMTP at a `supabase-mail` host that is not in the compose file,
so `POST /auth/v1/recover` answers **500 "Error sending recovery email"** — and
B16's `/auth/password/forgot`, which answers 202 either way so as not to leak
who has an account, was faithfully reporting success for a reset that never
happened. Password reset had never worked.

**Decided here.**

*GoTrue mints the code and is told nothing about delivery.*
`admin/generate_link` returns an OTP and a link without sending. The code goes
into `message_log` and leaves through the B11 drain — one queue, one retry
policy, one place a stuck message is visible. Two mail paths meant two places
for a failure to hide, and the one that hid was the one nobody could see.

*We send the OTP, never the `action_link`.* That link points at
`http://kong:8000`, the internal URL, unreachable from a customer's laptop.
Rewriting it to the public host would work and would put a Supabase URL in front
of shoppers, reopening the browser-to-Supabase path B16 closed. Six digits
travel better, and the reset lands them signed in.

*One SMTP adapter, not four HTTP ones.* Gmail, Zoho, Fastmail, SES, Mailgun,
Postmark and SendGrid all speak SMTP, so supporting "another provider" is an
`.env` edit rather than a new file. Resend keeps its own adapter because it is a
single POST and was already there.

*nodemailer earns its dependency.* AUTH, STARTTLS, MIME encoding, dot-stuffing
and header folding are a lot of ways to be quietly wrong. Spiked under Bun
first, as B0 did for Razorpay: it compiles a correct message and its socket
failures are clean.

*A blank variable means unset.* Switching providers is done by emptying the old
credentials, and `RESEND_API_KEY=` failing `.min(1)` would crash the process on
boot during exactly that migration.

**Not verified**: delivery through a real provider account. There are no
credentials here — the Resend key is a placeholder and returns 401. What is
proven is the whole path either side of that: a real SMTP server received the
message, subject and code intact, and the row went to `sent` with the
provider's message id; on Resend the same message requeued with the reason and
nothing was lost.

**Still open**: sign-up confirmation is wired and templated but not switched on.
`GOTRUE_MAILER_AUTOCONFIRM=true` still short-circuits it, which is the right
default until a provider account exists — turning it on before mail works would
lock every new shopper out of the account they just made.

### B18 — Email template manager · Medium

- [x] `message_templates` (`20260801002100_message_templates.sql`) — overrides only, no seed rows
- [x] `GET/PUT/DELETE /admin/email-templates/{key}` + `POST .../preview`
- [x] Built-in catalogue in `mailer.ts` with per-key `required` variables
- [x] **Validate**: a customised reset arrived at a real SMTP server with the code in it; a template written straight into the table without `{{code}}` still sent the built-in

**Decided here.**

*The table only ever overrides.* There are no seed rows, and a key with no
row renders from `mailer.ts`. That single choice is what makes a fresh install
send correct email before anyone opens the admin, makes DELETE a working
"revert", and makes it impossible to end up with no template at all. The API
refuses to create a key it cannot send, so the catalogue stays closed.

*Templates live in the database, not at the provider.* `mailer.ts` had proposed
provider-side templates. B17 made the provider swappable, and copy held at
Resend would have to be re-authored on a move to SMTP — which is the lock-in
that work removed.

*A required variable is enforced twice, deliberately.* The API refuses to save a
`password_reset` with no `{{code}}` and names the variable; the renderer
independently ignores such an override and sends the built-in. The second is not
redundant — `staff_all` lets any staff member write the table through PostgREST,
and a reset email with no code is worse than none, because the customer cannot
tell it was broken rather than late. Proven by poisoning the row directly: the
built-in went out, code intact.

*The subject is one header line, and the database says so.* A newline there
appends headers — `Bcc` most obviously — to every message the template sends.
The CHECK refuses it for every caller including the service key, so the
guarantee does not depend on which mail adapter is selected; the renderer strips
again at the last line before the header is written.

*Substitution, not evaluation.* `{{snake_case}}` and nothing else: no
conditionals, no property access, no engine. Staff-editable content run through
a template engine is a code-execution surface, and none of these emails need
one. An unknown variable renders empty, so a template naming something that no
longer exists reads plain rather than broken.

*Preview renders a draft without saving it.* The alternative is saving it and
finding out from a customer.

**Ceiling**: the override cache is per-process with a 60-second TTL, so two
instances can disagree for up to a minute after an edit. A NOTIFY listener is
the upgrade if that ever matters.

**Not built**: HTML email. Everything is `text/plain`, which is what the mailer
already sent. HTML would bring a sanitiser and an XSS-in-inbox surface for
staff-authored content, and is worth doing deliberately rather than by
accident.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **No backups on self-hosted Postgres** | **High if unaddressed** | **Catastrophic** | PITR does not exist here. GST invoices and `credit_ledger` — money owed to customers — live in this database. Scheduled `pg_dump` offsite or WAL-G, **plus one rehearsed restore**. Top risk in the project |
| pg_cron not loaded in the self-hosted image | Medium | High | Verified in B11; fallback is an interval loop in the API. Without either, stock strands silently |
| Internal vs public Supabase URL mixed up | Medium | Medium | `http://kong:8000` for the API, `https://supabase.<domain>` for browsers. Failures look like auth errors |
| Product images on an unbacked Docker volume | Medium | High | Decide the Storage backend before B4; either back the volume up or point Storage at S3-compatible |
| One host runs Supabase (~10 containers) + API + 2 apps | Medium | High | Size RAM accordingly; accept that the host is a single point of failure, or split Supabase onto its own node |
| Service key used for admin writes → audit trail goes anonymous | **High** (easy default) | High | B1 forwards the JWT; a test asserts `audit_logs.staff_id` non-null after a price edit |
| Client-supplied prices or totals trusted | Medium | **Critical** | Checkout reads prices from the DB; `orders_totals_balance` is the backstop, not the control |
| Webhook acted on before recording | Medium | Critical | B6 records first; `unique (provider, event_id)` makes a replay a no-op |
| Contract drift between API and two frontends | Medium | Medium | `hc` types + OpenAPI generated from the same Zod schemas |
| Razorpay SDK misbehaves under Bun | Medium | Medium | B0 spike; fall back to `fetch` against their REST API, or run the API on Node |
| ~~Two auth paths drift (browser↔Supabase Auth vs browser↔API)~~ | — | — | **Closed by B16.** There is one path now: the browser reaches Supabase only through this API. Nothing to keep in step |
| API is a single point of failure for both apps | Medium | High | Health checks and a rollback plan before the storefront launches |
| `turbo prune` gaps on Bun bite the API's Docker build | Low | Medium | Verify before containerizing; plain `turbo build` is unaffected. Dokploy can also build with Nixpacks and skip prune entirely |

---

## Supersedes in `admin-plan.md`

`docs/admin-plan.md` predates this decision and contradicts it in four places. Until it is
patched, **this file wins**:

| `admin-plan.md` says | Now |
|---|---|
| Admin talks to Supabase directly on the staff JWT | Admin talks to `apps/api`; the API forwards the JWT |
| Admin holds `SUPABASE_SERVICE_ROLE_KEY` | Only the API holds it |
| Admin Phase 3 owns `0012_admin_rpc.sql` | Owned here, as B3 |
| Storefront track S1–S6 hits Supabase directly | Collapses to "call the API" |
| Both apps hold `NEXT_PUBLIC_SUPABASE_*` and use supabase-js for the session | Neither does. Auth goes through `/auth/*` (B16); no Supabase credentials reach a browser |

Admin Phase 2 (data layer conventions) becomes "typed `hc` client + error mapping", and
its Phase 3 is deleted.

---

## Estimate

B0–B3 ≈ 4–5 days (foundation, nothing user-visible) · B4–B6 ≈ 6–8 days · B7–B12 ≈ 7–9
days. **~3.5 weeks before the admin UI has an API to call.** B0–B4 alone unblocks the
admin's read-only screens.

---

## Progress

| Phase | Status | Notes |
|---|---|---|
| B0 Scaffold | **done** | Razorpay-on-Bun spike passed; live HTTP untested |
| B1 Auth & context | **done** | audit attribution proven end to end |
| B2 Errors | **done** | 28 rules, real-message fixtures |
| B3 RPC migration | **done** | `20260801001200_admin_rpc.sql` |
| B4 Catalog reads | **done** | `20260801001300_catalog.sql`; storefront on the anon role |
| B5 Cart & checkout | **done** | `20260801001400_checkout.sql`; guest carts on the service key |
| B6 Payments & webhooks | **done** | `20260801001500_payments.sql`; courier/messaging deferred, provider not chosen |
| B7 Inventory & fulfilment | **done** | `20260801001600_inventory.sql`; sweepers moved into migrations |
| B8 Returns & money | **done** | `20260801001700_returns_wallet.sql` |
| B9 Invoicing | **done** | `20260801001800_invoicing.sql` |
| B10 Customers & support | **done** | `20260801001900_support.sql`; closes a live erasure hole |
| B11 Jobs | **done** | `20260801002000_jobs.sql`; outbox drain + pg_cron fallback + webhook redrive |
| B12 Cross-cutting | **done** | CORS closed by default, rate limits, `@ecom/client` |
| B13 Realtime | scope-guarded | Supabase Realtime unless a screen demands more |
| B14 Orders | **done** | order reads + the two B3 RPCs nothing called; guest tracking still open |
| B15 Staff accounts | **done** | the fourth service-key path; promoting an existing customer still open |
| B16 Auth surface | **done** | reverses B0: the API owns sign-in/up/out, refresh and password reset |
| B17 Email | **done** | all mail via `message_log`; provider switchable (Resend / any SMTP); fixed a reset that never worked |
| B18 Email templates | **done** | `message_templates` overrides the built-ins; preview, revert, and a renderer that refuses broken copy |
