# API service — build plan

Shared HTTP backend for the admin and storefront apps. Tick boxes as work lands, update
**Status** and the Progress table at the bottom. Anything discovered mid-build that
contradicts this file: fix the file, don't work around it.

**Status**: `B0-B2 done, B3 next`
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
browser ──▶ Supabase Auth ──────────────▶ session JWT
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
| Who talks to Postgres | **Only the API** | The browser keeps supabase-js solely to obtain a session |

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

- [ ] `admin_issue_invoice(order_id)` — `next_invoice_number()` + invoice + lines, one txn; CGST/SGST vs IGST from `store_settings.seller_state_code`
- [ ] `admin_ship_order(order_id, items[], carrier, tracking)`
- [ ] `admin_capture_cod(order_id)` — release → sale → payment → status → event
- [ ] `admin_cancel_order(order_id, reason)`
- [ ] `admin_receive_return(return_id, items[], resolution)`
- [ ] `grant execute on function anonymize_customer(uuid) to authenticated;` (revoked from public at `anonymize_customer()` in `supabase/migrations/20260801000000_baseline.sql`)
- [ ] Views `admin_sales_daily`, `admin_low_stock` — granted to `authenticated` only, **never `anon`**
- [ ] Every function `security definer` + `set search_path = public, pg_temp` (pg_temp **last**)
- [ ] **Validate**: extend `supabase/tests/01_invariants.sql`; `make test` green at 38+

### B4 — Catalog reads · Medium

- [ ] Products, variants, options, categories, collections; storefront reads `storefront_variants`, admin reads base tables
- [ ] Search via `pg_trgm` (`idx_products_name_trgm`, `idx_variants_sku_trgm`)
- [ ] Pincode serviceability + shipping rate lookup (`docs/schema_guide.md:634`)
- [ ] **Validate**: a storefront-scoped call never returns `cost_price`; a draft product is invisible to it

### B5 — Cart & checkout · **High**

- [ ] Cart CRUD; guest carts by `session_id`, logged-in by `customer_id`
- [ ] Checkout in **one transaction**, ordered per `docs/schema_guide.md:377`: idempotency key **first** → reservation (with `expires_at`) → order → items → redemption → outbox message → store response
- [ ] Prices, totals and discounts recomputed server-side from the DB
- [ ] **Validate**: replay the same idempotency key → same response, one order; oversell → 409; a spent coupon → 409

### B6 — Payments & webhooks · **High**

- [ ] Razorpay order creation and capture
- [ ] Webhook handler: verify signature → **insert `webhook_events` before acting** → process → set `processed_at`
- [ ] Capture converts reservation → release + sale; failure releases only
- [ ] Courier and messaging provider webhooks on the same pattern
- [ ] **Validate**: deliver the same webhook twice → one state change, second is a no-op

### B7 — Inventory & fulfilment · Medium

- [ ] Movements ledger reads; receive / adjust / damage as plain inserts with `created_by`
- [ ] Shipments via `admin_ship_order`; low-stock queue (`idx_variants_low_stock`)
- [ ] Reservation monitor + last run of `release_expired_reservations()`
- [ ] **Validate**: no endpoint anywhere writes `product_variants.stock`

### B8 — Returns, refunds, credit, gift cards · High

- [ ] Return request (customer) → approve → `admin_receive_return` (staff)
- [ ] Refunds against the original payment; provider ref unique
- [ ] Credit ledger entries; balance read from `customer_credit_balances`, never summed by hand
- [ ] Gift cards — issue returns the code **once**; lookup by `digest(code,'sha256')`, server-side only
- [ ] **Validate**: overspend a gift card → refused; return more than ordered → refused

### B9 — GST invoicing · Medium

- [ ] Issue via `admin_issue_invoice`; credit note against a parent invoice
- [ ] e-invoice fields (IRN, ack no, signed QR) writable once, then final
- [ ] **Validate**: numbers gap-free within a financial year; editing an invoice → refused

### B10 — Customers, support, engagement · Medium

- [ ] Customers, addresses, communication preferences; `anonymize_customer` behind `owner`/`admin`
- [ ] Support tickets + messages (`is_internal` never exposed to customers), enquiries
- [ ] Reviews moderation; `is_verified` is generated — read only
- [ ] Notifications, stock alerts, wishlist
- [ ] **Validate**: a customer cannot read an internal ticket note or set ticket priority

### B11 — Jobs · Low

- [ ] **Confirm pg_cron is loaded** (`shared_preload_libraries`) and the extension created — self-hosted does not guarantee it
- [ ] Schedule `pg_cron` per `docs/setup.md:238` — reservations every 5 min, then carts / idempotency / webhooks / notifications
- [ ] **Fallback if pg_cron is unavailable**: run the same functions on an interval from the API. It is already a long-lived container, so this is a loop, not new infrastructure. Trade-off: the sweepers stop when the API is down, which is exactly what choosing pg_cron was meant to avoid
- [ ] **Outbox drain in the API**: claim `message_log` rows where `status = 'queued'` (`idx_message_log_queued`), send via Resend/MSG91, update to sent/failed with `attempts`
- [ ] Drain endpoint is secret-guarded, or an interval loop in-process
- [ ] **Validate**: kill the mail provider → rows stay `queued`, nothing is lost; restore → they drain

### B12 — Cross-cutting · Medium

- [ ] Idempotency middleware for every money-moving POST
- [ ] Rate limiting — checkout, login-adjacent, stock alerts, enquiries (all anon-writable surfaces)
- [ ] Publish the `hc` client type to both apps
- [ ] CORS locked to the two app origins
- [ ] **Validate**: OpenAPI spec covers every route; both apps typecheck against `hc`

### B13 — Realtime · Low · *scope-guarded*

Hono supports SSE (`hono/streaming`) and WebSockets (`hono/bun`), but the default here is
to build neither.

- [ ] Notification feed (new order, low stock, new ticket) → **Supabase Realtime, browser-direct** against the `notifications` table. RLS gates it. Backend code: none
- [ ] Hono **SSE** only for data the API computes that is not a raw table change (live dashboard aggregates)
- [ ] Hono **WebSockets** only if a client must *send* over the socket — support-ticket chat is the sole candidate, and POST + SSE is simpler
- [ ] **Known deviation**: browser-direct Realtime reopens a browser↔Supabase path, partially bypassing "one place to rate-limit and audit". Accepted for read-only, RLS-gated event delivery
- [ ] **Scaling**: Postgres Changes filters per connection. A dozen staff is fine; thousands of customers each watching their own order is not — poll the tracking page every 30s instead

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
| Two auth paths drift (browser↔Supabase Auth vs browser↔API) | Medium | Medium | Browser uses supabase-js for session only; one shared `getSession` helper |
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
| B3 RPC migration | not started | blocks B5, B7–B9 |
| B4 Catalog reads | not started | unblocks admin read-only screens |
| B5 Cart & checkout | not started | |
| B6 Payments & webhooks | not started | |
| B7 Inventory & fulfilment | not started | |
| B8 Returns & money | not started | |
| B9 Invoicing | not started | |
| B10 Customers & support | not started | |
| B11 Jobs | not started | pg_cron + outbox drain |
| B12 Cross-cutting | not started | |
| B13 Realtime | scope-guarded | Supabase Realtime unless a screen demands more |
