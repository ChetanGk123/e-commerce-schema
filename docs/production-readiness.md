# Production readiness — what is missing

Gap list for `apps/api` against "a real store takes real orders through this".
Audited against the code, not against the plan; where the two disagree, the code
wins and this file says so.

**Status**: #5 done; the rest open
**Audited**: 2026-08-19, at `B0-B12 + B14-B18 done`
**Companion**: `docs/api-plan.md` (what was built) · `docs/setup.md` (the deploy runbook)

---

## What already holds up

Worth stating, so the list below is read as a punch list rather than a verdict.
CORS is closed by default; the service key is confined to the four paths that
need it and staff writes go through the caller's JWT so the audit trail keeps
its attribution; webhooks record before acting; the error mapper returns codes
instead of constraint names; `checkout()` claims its idempotency key inside the
transaction that reserves the stock. None of that has to be revisited.

The gaps cluster in three places: **writes that were never built, operations
that were never built, and the seam that nothing tests.**

---

## Priority

| # | Gap | Cost of shipping without it |
|---|---|---|
| ~~5~~ | ~~Failed webhooks never retried or surfaced~~ | **done** |
| 10 | No timeout on Supabase calls | One hung PostgREST call hangs a request indefinitely |
| 7 | No Dockerfile, no CI | Cannot deploy at all |
| 8 | No graceful shutdown | Every redeploy kills in-flight checkouts |
| 9 | No readiness probe | A misconfigured instance takes traffic and 500s |
| 17 | No integration tests | Both suites stay green while the system is broken |
| 1–4 | No catalog, discount, settings or shipping writes | The store can only be run by hand in SQL |
| 14 | RLS ignores `staff_users.role` | A warehouse JWT reads `cost_price` and all PII |
| 6 | Nothing marks a shipment delivered | Orders stay "shipped" permanently |

---

## Ship-stoppers — the store cannot be operated

- [ ] **1. The catalog is read-only.** `apps/api/src/routes/admin-catalog.ts`
      declares exactly two routes, both `get`. There is no way through this API
      to create or edit a product, variant, option, price, category, collection
      or product image — every catalog change is hand-written SQL or a Studio
      click. That also means `price_history` and `audit_row()` never fire
      through the audited path they were built for: the one place a price edit
      is supposed to be attributable is the one place prices cannot be edited.
      Includes image upload, which needs a Storage decision first (see `setup.md` C5).

- [ ] **2. No discount or coupon management.** `checkout()` takes
      `p_coupon_code` (`routes/checkout.ts:143`) and the schema carries the whole
      `discounts` machinery with its race guard. Nothing creates a discount.

- [ ] **3. No `store_settings` surface.** GST seller details, the COD toggle,
      the free-shipping threshold. `setup.md` Step 5 sets them by SQL once, at
      install; an owner can never change them afterwards.

- [ ] **4. No shipping zone or rate management.** `/shipping/quote` reads the
      rate tables. Nothing writes them — `setup.md` Step 6 is SQL.

- [x] **5. Failed webhook processing is never retried and never surfaced.** —
      **done.** `redriveWebhooks()` in `src/jobs.ts` runs on every tick and on
      `POST /jobs/drain`; `GET /admin/webhooks` reports what it gave up on.
      `routes/webhooks.ts:30` says re-driving unprocessed rows "is our job
      (api-plan B11)". B11 shipped the outbox drain and the sweepers, not this.
      A `payment.captured` whose `capture_payment` call fails transiently is
      recorded with the error, answered `200` — correctly, the delivery is safe —
      and then **nothing ever looks at it again**. The customer paid; the order
      is not paid. `/admin/outbox` monitors mail only.
      Fixed by replaying the stored payload through the route's own
      `processEvent`, capped at 20 attempts, with the exhausted rows and their
      last error on `GET /admin/webhooks`. No migration: `processed_at is null`
      was already the queue and `idx_webhook_unprocessed` already indexed it.

- [ ] **6. Nothing can mark a shipment delivered.** `routes/fulfilment.ts` posts
      and reads shipments; `admin_ship_order` is its only RPC. `shipments.delivered_at`
      and order status `delivered` are unreachable, so every shipped order stays
      "shipped". Returns do not gate on it, so this is reporting and customer
      experience rather than a money bug — but it is also what the deferred
      courier webhook (`api-plan.md` B6) would have driven.

---

## Operations — nothing is deployable yet

- [ ] **7. No deployment artifacts.** No Dockerfile, no compose service, no
      Nixpacks config, no CI workflow anywhere in the repo. The plan's own
      `turbo prune`-on-Bun risk is still unverified.

- [ ] **8. No graceful shutdown.** `stopJobs()` (`src/jobs.ts:158`) is exported
      and called by nobody, and there is no `SIGTERM` handler in the process.
      A redeploy drops in-flight requests mid-checkout. A drain interrupted
      mid-send leaves rows in `sending`, which `requeue_stalled_messages()`
      rescues ten minutes later — so mail is delayed, not lost, but the
      request-side loss is real.

- [ ] **9. Readiness probe.** `routes/health.ts` deliberately does not touch
      Postgres, which is right for liveness, and its own comment says readiness
      "arrives with B1". B1 shipped without it. An instance holding a wrong
      `SUPABASE_URL`, or pointed at a dead Kong, passes its health check and
      500s every request it is handed.

- [ ] **10. No timeout on Supabase calls.** `authmail.ts` and `mailer.ts` both
      use `AbortSignal.timeout`; `src/supabase.ts` creates all three clients with
      no custom `fetch`, so a hung PostgREST request hangs the Hono request until
      the client gives up. One wrapper in `supabase.ts` covers anon, caller and
      service clients at once.

- [ ] **11. No metrics, no tracing, no alerting.** Structured pino with request
      ids is good for reading one request; "checkout p99" and "5xx in the last
      hour" are grep questions. The two conditions that should page someone —
      outbox stalled, webhooks unprocessed — are computed only when a human
      loads an admin page.

- [ ] **12. The rate limiter is per-instance.** Documented honestly in
      `src/limits.ts`, and simply wrong the moment a second container starts.
      Move it to the load balancer and set `RATE_LIMIT_PER_MINUTE=0`, rather
      than running two limiters that disagree. Same class of caveat, already
      handled correctly: `idempotency.ts` is not a lock, and `checkout()` keeps
      its own inside the transaction.

- [ ] **13. Backups, and one rehearsed restore.** Infrastructure rather than
      code, already the top risk in `api-plan.md` and step C5 of `setup.md`.
      Repeated here because nothing in this repo will fail if it is skipped.

---

## Security

- [ ] **14. The RLS role matrix.** `requireRole` guards three route groups —
      staff CRUD and email templates (`routes/staff.ts`, `routes/email-templates.ts`).
      Everything else stops at `requireStaff`, and RLS grants every active staff
      member full read/write on all 51 tables. The anon key is not secret, so a
      warehouse packer's own JWT reads `cost_price` and all customer PII straight
      from PostgREST, whatever the admin UI shows. `src/auth.ts` states this as
      accepted risk. It remains the highest-value security change available.

- [ ] **15. No per-account lockout.** Sign-in is limited per IP at cost 10 of a
      60/min budget — six attempts a minute from one address. Credential stuffing
      spread across addresses is invisible to everything here.

- [ ] **16. `/docs` and `/openapi.json` are public.** Deliberate, and noted in
      `app.ts` as the one line to wrap in an env check if the route map should
      not be published. Low, listed so the decision is a decision.

---

## Verification — where the real risk is

- [ ] **17. There are no integration tests.** The 146 tests in `apps/api/test`
      never touch Postgres; `supabase/tests/01_invariants.sql` runs against a
      throwaway container with no API in front of it. Nothing exercises the seam
      between them — that `checkout()`'s parameter names match what the route
      sends, that RLS permits the route's select list, that renaming an RPC
      breaks something. **Both suites stay green while the system is broken**,
      and this architecture put all of its logic in exactly that seam.
      A compose'd Postgres plus a dozen HTTP tests through `app.request()`
      closes it; the existing `make verify` container is most of the work.

---

## Smaller holes

- [ ] Guest order tracking. `routes/orders.ts:335` says a guest tracks from the
      link in their confirmation email; no route serves that link
- [ ] Checkout cannot spend store credit — `credit_ledger.order_payment` is
      waiting for it (already flagged in `api-plan.md` B12)
- [ ] No address edit: `POST` and `DELETE` only, no `PATCH`
- [ ] No `GET /admin/customers/{id}` detail — the list, the credit and the
      erasure exist, the customer does not
- [ ] A customer cannot cancel their own order; `admin_cancel_order` is staff-only
- [ ] No `Cache-Control` or `ETag` on the public catalog

---

## Order to do it in

1. **#5 and #10** — both lose money, both are small.
2. **#7, #8, #9** — until these exist there is nothing to deploy.
3. **#17** — before any of the catalog writes.
4. **#1–#4** — a lot of new SQL-touching code, which is precisely why #17 comes first.
5. **#14** — schedule it deliberately; it is a migration, not an afternoon.
