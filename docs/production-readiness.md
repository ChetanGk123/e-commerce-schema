# Production readiness — what is missing

Gap list for `apps/api` against "a real store takes real orders through this".
Audited against the code, not against the plan; where the two disagree, the code
wins and this file says so.

Finished items stay here rather than being deleted, with what was actually
wrong and what shipped. Half of what each one taught was not in the original
entry.

**Status**: #5, #7, #8, #9, #10, #17 done — the API is deployable and the seam is tested. The rest open
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
| ~~10~~ | ~~No timeout on Supabase calls~~ | **done** |
| ~~7~~ | ~~No Dockerfile, no CI~~ | **done** |
| ~~8~~ | ~~No graceful shutdown~~ | **done** |
| ~~9~~ | ~~No readiness probe~~ | **done** |
| ~~17~~ | ~~No integration tests~~ | **done** |
| 1 | Catalog writes — **products and variants done**; options, images, categories still SQL | |
| 2–4 | No discount, settings or shipping writes | Still SQL-only |
| 14 | RLS ignores `staff_users.role` | A warehouse JWT reads `cost_price` and all PII |
| 6 | Nothing marks a shipment delivered | Orders stay "shipped" permanently |

---

## Ship-stoppers — the store cannot be operated

- [~] **1. The catalog was read-only.** — **products and variants done**, the
      rest still open.
      *Shipped:* `POST /admin/products`, `PATCH /admin/products/{id}` (which is
      also the publish button), `POST /admin/products/{id}/variants`,
      `PATCH /admin/variants/{id}`. That is enough to add something and sell
      it without opening psql.
      *No migration, and no new validation.* `productAdminSchema` and
      `variantAdminSchema` already existed in `@ecom/schema` with no caller —
      the same pattern as the rest of this repo — and catalog writes need no
      RPC: `staff_all` already permits them and the audit and price-history
      triggers already fire. The routes are the only thing that was missing.
      *Two refusals kept deliberate:* `status` is not a create field, so a
      product arrives as a draft rather than published by a stray checkbox;
      `stock` is not a variant field at all, because `inventory_movements` is
      the source of truth and `variant.stock` is its cache. Stock moves
      through `POST /admin/inventory/movements`.
      *Proven against a real database,* including the one `api-plan.md` rates
      High: a price edit lands in `audit_logs` **with the staff member's id**,
      which is only true because the write runs on `caller.db` rather than the
      service key. Also that a draft is invisible until published, that
      repricing writes `price_history` by trigger, and that a duplicate slug
      is a 409 rather than a 500 quoting the index.
      *Still open:* options and option values, product images (needs the
      Storage decision, `setup.md` C5), categories, collections, product
      relations, and delete/archive of a product.

- [ ] **2. No discount or coupon management.** `checkout()` takes
      `p_coupon_code` (`routes/checkout.ts:143`) and the schema carries the whole
      `discounts` machinery with its race guard. Nothing creates a discount.

- [ ] **3. No `store_settings` surface.** GST seller details, the COD toggle,
      the free-shipping threshold. `setup.md` Step 5 sets them by SQL once, at
      install; an owner can never change them afterwards.

- [ ] **4. No shipping zone or rate management.** `/shipping/quote` reads the
      rate tables. Nothing writes them — `setup.md` Step 6 is SQL.

- [x] **5. Failed webhook processing was never retried or surfaced.** — **done**,
      commit `1710849`.
      *The gap:* `routes/webhooks.ts` deferred re-driving unprocessed rows to
      B11; B11 shipped the outbox drain and the sweepers and never picked them
      up. A `payment.captured` whose `capture_payment` failed transiently was
      recorded with its error, answered `200` — correctly, the delivery is safe
      — and then nothing looked at it again. The customer had paid; the order
      said pending, permanently.
      *The fix:* `redriveWebhooks()` in `src/jobs.ts` replays the stored payload
      through the route's own `processEvent`, on every tick and on
      `POST /jobs/drain` (so a `JOBS_INTERVAL_SECONDS=0` deployment gets it from
      its one cron entry). Capped at 20 attempts, after which
      `GET /admin/webhooks` names the row and its last error. No migration —
      `processed_at is null` was already the queue and `idx_webhook_unprocessed`
      already indexed it.
      *Found while fixing:* `/admin/outbox` derived "is mail configured" from
      `RESEND_API_KEY` alone, so B17's SMTP deployments were told nothing would
      ever be sent — and that false alarm swallowed the real `stalled_sending`
      one behind it in the warning ladder.

- [ ] **6. Nothing can mark a shipment delivered.** `routes/fulfilment.ts` posts
      and reads shipments; `admin_ship_order` is its only RPC. `shipments.delivered_at`
      and order status `delivered` are unreachable, so every shipped order stays
      "shipped". Returns do not gate on it, so this is reporting and customer
      experience rather than a money bug — but it is also what the deferred
      courier webhook (`api-plan.md` B6) would have driven.

---

## Operations — nothing is deployable yet

- [x] **7. No deployment artifacts.** — **done**. Multi-stage `Dockerfile`,
      `.dockerignore`, and `.github/workflows/ci.yml` (typecheck + `bun test`).
      Built and run for real, not just written.
      *`turbo prune` on Bun is moot, not unverified.* The risk `api-plan.md`
      flagged was about shipping a pruned install; `bun build` emits one
      self-contained 2 MB file, so the runtime stage copies that and no
      `node_modules` ships at all. Image 280 MB, runs as the unprivileged
      `bun` user, verified to contain no `.env`.
      *Three things only a real build could have found:*
      **`NODE_ENV=production` is load-bearing.** In development `logger.ts`
      sends pino through a `pino-pretty` worker, which cannot resolve its
      target out of a bundle — the container dies at boot with
      `DataCloneError: The object can not be cloned`, naming nothing useful.
      **`CMD ["bun", "run", ...]` breaks shutdown.** The wrapper sits at PID 1
      and SIGTERM never reaches the server. `bun server.js`, exec form.
      **The platform's default stop timeout is not enough.** `docker stop` on
      the default SIGKILLed the drain at 1.1s (exit 137); with an explicit
      `-t 10` it finished in 5.2s (exit 0). Set `stop_grace_period: 45s`
      wherever this deploys — the Dockerfile says so at the `CMD`.
      *And one CI caught before CI existed:* `fetch.preconnect` in
      `supabase.ts` was a Bun-only type, and `packages/client` type-checks the
      API's source without `@types/bun` — the same trap B12 hit with
      `Bun.CryptoHasher`. `bun run typecheck` covers every workspace, which is
      why it is the root script and not `--filter @ecom/api`.

- [x] **8. Nothing handled a shutdown signal.** — **done**, together with #9;
      the two only work as a pair.
      *The gap:* `stopJobs()` was exported and called by nobody, and no signal
      handler existed. A redeploy dropped whatever was in flight — a checkout
      mid-transaction, a drain mid-send. The database survived both, but the
      customer saw a failed request for an order that may or may not exist.
      *The fix:* `src/server.ts` now uses an explicit `Bun.serve` handle and
      stops in an order that loses nothing — fail readiness, stop scheduling
      jobs, keep serving through a 5s grace so whatever routes here notices,
      then `server.stop()` (which waits for in-flight connections) behind a
      `REQUEST_TIMEOUT_MS + 5s` backstop.
      *Measured:* SIGTERM at t+301ms on a request with 7.7s left to run — the
      request was **answered at t+8002ms** and the process exited 0. Readiness
      flipped to 503 within 200ms of the signal while liveness stayed 200
      throughout, which is the ordering that makes the drain invisible to
      users rather than a wall of connection errors.

- [x] **9. There was no readiness probe.** — **done**.
      *The gap:* `/health` is liveness-only, correctly, and its own comment said
      readiness "arrives with B1". B1 shipped without it, so an instance holding
      a wrong `SUPABASE_URL` or pointed at a dead Kong passed its health check
      and 500'd every request it was handed.
      *The fix:* `GET /health/ready` reads one row through the **anon** client —
      the whole path a storefront request takes, Kong through RLS, not just "the
      process is running". A probe on the service key would pass while every
      customer request failed.
      *Its own deadline:* 2s, via `.abortSignal()`, which beats the 10s
      client-wide one — measured at 2008ms against an unreachable database.
      That composition is only possible because `withDeadline` keeps whichever
      signal fires first rather than replacing the caller's.
      *Point liveness at `/health` and readiness at `/health/ready`.* Swapped,
      a brief database blip becomes a restart loop.

- [x] **10. Nothing bounded how long a call to Supabase could take.** — **done**,
      branch `harden/supabase-timeouts`. Needed two layers, not the one this
      entry originally assumed.
      *The gap:* neither supabase-js nor `fetch` imposes a deadline, so a server
      that accepted the connection and then stopped answering held the request
      open for as long as the caller waited. `gotrue()` in `routes/auth.ts` had
      the same hole, which meant a hung auth service hung every sign-in.
      *The fix, layer one:* `src/supabase.ts` wraps all three clients in
      `SUPABASE_TIMEOUT_MS` (10s), and `gotrue()` takes the same deadline.
      *The fix, layer two — and the reason this entry was wrong:* **a per-call
      deadline does not bound a request.** Measured against a black-holed
      address, supabase-js retries a failed call four times on its own, so a 1s
      per-call deadline still answered in 11s. `hono/timeout` now caps the whole
      request at `REQUEST_TIMEOUT_MS` (30s), with `POST /jobs/drain` exempt
      because a mail batch legitimately outlasts an interactive request.
      *Answers, instead of a generic 500:* `database_timeout` (504) for one
      call, `request_timeout` (504) for the whole request,
      `database_unavailable` (503) for nothing listening. `env.ts` refuses to
      boot unless the ceiling exceeds the per-call deadline — inverted, the
      ceiling fires first and `database_timeout` becomes unreachable, so an
      operator could never tell which of the two was actually wrong.

- [ ] **11. No metrics, no tracing, no alerting.** Structured pino with request
      ids is good for reading one request; "checkout p99" and "5xx in the last
      hour" are grep questions. The two conditions that should page someone are
      now both computed — `GET /admin/outbox` and `GET /admin/webhooks` — but
      only when a human opens the page. Nothing pushes.

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

- [x] **17. There were no integration tests.** — **done**. `make test-api`.
      *The gap:* `bun test` never reached Postgres; the SQL invariants never
      reached the API. Nothing exercised what is only true if the two agree,
      and this architecture put all of its logic exactly there.
      *The harness:* PostgREST in front of the same throwaway Postgres
      `make verify` already builds, schema and seed loaded. **No GoTrue** —
      `apps/api` verifies JWTs itself against the shared secret, so the
      harness mints its own in the shape Supabase issues (`role` is the
      load-bearing claim; PostgREST SETs that database role, which is what
      makes RLS apply to the right person). Kong is twelve lines of path
      rewrite rather than a fourth container.
      *Seven tests, chosen for what only a real database can refuse:*
      checkout actually places an order (eleven RPC parameters — rename one
      and every other suite stays green while no order can be placed),
      oversell comes back as a mapped code rather than a 500, one customer
      cannot read another's orders, a draft product is invisible, a
      customer's token is refused by the admin surface.
      *Skipped, not failed, when the stack is down* — a suite that fails on a
      laptop without Docker gets deleted, and then none of this is tested.
      `bun test` reports 228 pass, 8 skip.
      *It found a real fidelity bug on its first run.* The shim's `auth.uid()`
      read only `request.jwt.claim.sub`; PostgREST v9+ sets
      `request.jwt.claims` as one JSON object, so `auth.uid()` was null, RLS
      believed nobody was signed in, and every staff request answered 403. It
      now mirrors Supabase's own definition, which reads both. **The SQL
      invariants could never have caught this** — they set the GUC by hand,
      so they were testing a shape no real client produces.

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

1. ~~**#5 and #10**~~ — done. Both lost money, both were small.
2. ~~**#7, #8, #9**~~ — done. The API can be deployed and redeployed without
   dropping traffic.
3. ~~**#17**~~ — done, and before the catalog writes as planned.
4. **#1–#4** — a lot of new SQL-touching code, and now there is something
   that notices when it disagrees with the schema. Products and variants are
   done; options, images, discounts, settings and shipping rates are not.
5. **#14** — schedule it deliberately; it is a migration, not an afternoon.

Both finished items took longer than the entry predicted, for the same reason:
the audit named the symptom from reading the code, and the fix only held once
the behaviour was measured. #5's entry did not know `/admin/outbox` was lying;
#10's entry assumed one wrapper would do it. Expect the same of the rest — the
estimates here are a reading, not a measurement.
