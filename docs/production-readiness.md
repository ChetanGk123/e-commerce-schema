# Production readiness — what is missing

Gap list for `apps/api` against "a real store takes real orders through this".
Audited against the code, not against the plan; where the two disagree, the code
wins and this file says so.

Finished items stay here rather than being deleted, with what was actually
wrong and what shipped. Half of what each one taught was not in the original
entry.

**Status**: #2–#10, #13–#17 done; #1 and #11 part-done. Every smaller hole is closed. What is left needs a decision from you, not more code: #11's metrics destination, #12 (move the limiter to Traefik), and #1's last piece (the Storage backend for product images). The API is deployable, the seam is tested, and the store can be run without psql
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
| 1 | Catalog writes — everything except **product images**, which need the Storage decision first | |
| ~~2–4~~ | ~~No discount, settings or shipping writes~~ | **done** |
| ~~14~~ | ~~RLS ignores `staff_users.role`~~ | **done**, except `cost_price` |
| ~~6~~ | ~~Nothing marks a shipment delivered~~ | **done** |

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
      *Options too, since.* `POST /admin/products/{id}/options` creates an
      option with its values in one call, and `PUT /admin/variants/{id}/options`
      sets which combination a variant is. This is what README.md leads with —
      "Amazon / Apple-style configurations" — and none of it was reachable:
      every product this API created was a simple one with a single
      unconfigured variant.
      *Both batch their inserts, and must.* `refresh_signature()` is a
      statement-level trigger over a transition table, so one statement
      computes `options_signature` once and the unique index on
      `(product_id, options_signature)` rejects a duplicate combination with
      no application cooperation. Row-at-a-time inserts can produce an
      intermediate signature that collides with another variant's final one —
      the schema warns about it in a comment, and these are the routes that
      comment was written for.
      *Two refusals with no TypeScript behind them, both tested:* a value from
      another product cannot be attached at all (the composite FKs must both
      resolve to the same `product_id` — 422 `cross_product_option`, a rule
      `errors.ts` already carried before anything could provoke it), and two
      variants cannot claim the same combination.
      *Categories and collections too.* `/admin/categories` and
      `/admin/collections`, plus `PUT /admin/collections/{id}/products`, which
      sets membership as a whole with the array index as the position — so
      re-sorting a collection needs no second endpoint.
      *A cycle guard came with them* (`20260801002400_category_tree.sql`).
      `categories_no_self_parent` only stopped A → A; nothing stopped
      A → B → A, and every breadcrumb and "this category and its children"
      query walks `parent_id`, so one loop is an infinite one. It is a trigger
      rather than a route check because the categories in this store were
      created in psql, and a guard the API holds is a guard psql does not.
      *Deleting a category is deliberately not offered:*
      `products.category_id` is `on delete set null`, so removing one would
      silently unfile every product in it. Move the products first.
      **Still open: product images only** — and they are blocked on a
      decision, not on effort. `setup.md` C5 has Storage on a bind-mounted
      local directory rather than S3; building an upload endpoint against an
      unbacked volume would be building the wrong thing.

- [x] **2. No discount or coupon management.** — **done**.
      `POST`/`GET` `/admin/discounts`, `PATCH /admin/discounts/{id}`, reusing
      `discountAdminSchema` — which, like the others, already existed with no
      caller. `checkout()` has taken `p_coupon_code` since B5 and
      `enforce_discount_limits()` has guarded the redemption race for three
      phases; only the codes had to be inserted by hand.
      *`used_count` is not writable, deliberately.* It moves in the same
      transaction as the redemption row, and `discounts_within_max_uses` is
      what actually stops a single-use code being claimed twice by concurrent
      checkouts. An endpoint that could set it could hand out a spent code or
      wind one back. There is a test that sends it and asserts the counter
      stayed at zero.
      *Withdrawal is `is_active: false`, not DELETE* — deleting a code takes
      its redemption history with it, and that history is what explains a
      discounted order months later.

- [x] **3. No `store_settings` surface.** — **done**. `GET /admin/settings`
      and `PATCH /admin/settings` (owner/admin only).
      *`seller_gstin` and `seller_state_code` are format-checked here, and must
      agree with each other*, because nothing downstream catches them: the
      invoice is issued, numbered gap-free, and is a legal document by the time
      anyone notices the number on it is malformed. Verified audited — a
      changed GSTIN lands in `audit_logs` with the staff member's id.
      *`config` (jsonb) is deliberately not exposed.* Nothing in the service
      reads it, and the README is explicit it is for non-secret configuration
      only; an endpoint taking arbitrary JSON into it is an invitation to put a
      gateway key there. Add it when something needs to read it.

- [x] **4. No shipping zone or rate management.** — **done**. Zones, rate
      bands and serviceable PIN codes: `/admin/shipping/zones`,
      `/admin/shipping/rates`, `PUT /admin/shipping/pincodes/{pincode}`.
      *The overlap rule stays the database's.* `rates_no_overlap` is a GiST
      exclusion constraint — exactly one active rate may match any (zone,
      weight, basket value) point — and `errors.ts` already knew it by name
      before anything could provoke it. A straddling band is a 409 that does
      not mention GiST; retiring the old band is what makes room, and the test
      walks that whole sequence.
      *An unlisted PIN code is unserviceable*, so `PUT` on one is the switch
      that opens a new delivery area. Proven end to end: `/shipping/quote`
      answers `serviceable: false` before and quotes the real rate after.

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

- [x] **6. Nothing could mark a shipment delivered.** — **done**.
      `PATCH /admin/shipments/{id}`, on a new `admin_update_shipment()` RPC
      (`20260801002200_delivery.sql`).
      *The gap:* `admin_ship_order()` wrote `label_created` and nothing could
      move a shipment afterwards. Six of the seven values `shipments.status`
      allows were unreachable, `delivered_at` was never written, and
      `orders.status` could not become `delivered` at all — so every order this
      store ever fulfilled stayed "shipped".
      *An RPC, not two UPDATEs*, for the same reason every other `admin_*`
      function is one: it touches the shipment, the order and the timeline, and
      a half-moved order is worse than an unmoved one.
      *The order follows the last parcel, not this one.* `shipment_items`
      exists so an order can ship in parts, so marking one parcel delivered
      while another is in transit must not tell the customer it arrived. The
      test ships one order as two parcels and asserts the order stays `shipped`
      after the first and turns `delivered` after the second.
      *`rto` and `lost` deliberately leave the order alone.* A returned or lost
      parcel needs a person to choose between a refund, a reship and a carrier
      claim; picking one here would be code making a commercial decision.
      *Repeating a status is a no-op*, so a courier webhook redelivering
      `delivered` is harmless — asserted by checking `order_events` still holds
      exactly one delivery entry.

---

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

- [~] **11. No metrics, no tracing, no alerting.** — **alerting done**
      (`20260801002700_ops_alerts.sql`); metrics and tracing still open.
      *What was wrong:* `/admin/outbox` and `/admin/webhooks` compute exactly
      what is broken and both wait to be asked. A mail queue that stopped
      draining and a payment callback that could not be applied are the two
      failures here that are silent, unbounded and expensive — the first means
      every order confirmation since is unsent, the second means a customer
      paid and this database still calls their order pending.
      *What it does now:* the jobs tick checks both and calls
      `raise_ops_alert()`, which writes one notification per active owner and
      admin — not every staff member, because an alert everyone receives is one
      nobody owns. Each also logs at error level with a stable message
      (`ops.outbox_stalled`, `ops.webhooks_exhausted`), which is the hook for a
      log shipper that can actually page.
      *The cooldown is the load-bearing part.* This runs every sixty seconds,
      so a persisting condition must raise once and then stay quiet or the
      notification feed becomes the outage. Dedupe is on *unread*: once someone
      has seen it and the problem recurs, it speaks again, because silence
      would otherwise be indistinguishable from a fix.
      **Still open, and needing a decision rather than effort:** metrics and
      tracing. Prometheus, OTLP and "nothing, read the logs" are different
      products with different infrastructure behind them. **Prometheus was
      chosen**, and `GET /metrics` now serves it — `http_requests_total` and
      `http_request_duration_seconds` by route pattern, method and status,
      plus gauges for the outbox, webhooks and active lockouts.
      *Hand-rolled, no prom-client.* The exposition format is a few lines of
      text; the library brings a default registry, a global clock and process
      collectors none of this wants.
      *The route label is the registered pattern* (`/catalog/products/:slug`),
      never the path. Labelling by path gives Prometheus a time series per
      product slug, which is how a metrics endpoint takes down the thing it
      was installed to watch.
      *The gauges are published by the jobs tick, not queried on scrape* — a
      scrape must not cost three database round trips, and the tick already
      has the numbers, so the alert and the dashboard cannot disagree. The
      price is staleness, so `ecom_ops_snapshot_age_seconds` is published
      beside them, and a partial snapshot is deliberately **not** published: a
      zero on `ecom_webhooks_exhausted` is the one reading nobody
      double-checks.
      *Closed by default.* No `METRICS_TOKEN`, no endpoint — 404, and a wrong
      token gets the same 404, so it cannot be told from an endpoint that was
      never turned on.
      **Tracing was not built.** Per-request traces across API→PostgREST→
      Postgres need a collector to run and an SDK in the dependency tree; the
      notification and the `ops.*` log lines are still what actually reach a
      person, and a notification is seen when someone opens the admin —
      better than never, worse than a phone ringing.

- [ ] **12. The rate limiter is per-instance.** Documented honestly in
      `src/limits.ts`, and simply wrong the moment a second container starts.
      Move it to the load balancer and set `RATE_LIMIT_PER_MINUTE=0`, rather
      than running two limiters that disagree. Same class of caveat, already
      handled correctly: `idempotency.ts` is not a lock, and `checkout()` keeps
      its own inside the transaction.

- [x] **13. Backups, and one rehearsed restore** — **done as far as this repo
      can take it**: `scripts/backup.sh`, `scripts/restore.sh`,
      `make restore-drill`. The entry's own complaint was that *nothing in this
      repo will fail if it is skipped*. Now something does.
      *The drill runs the same two scripts an operator runs against
      `supabase-db-1`* — rehearsing a different procedure than the one you run
      is rehearsing nothing. It backs up the seeded database, restores into an
      empty container, fingerprints both (roles, every policy, RLS
      enabled/forced per table, every function signature, every row count) and
      diffs.
      *The bug it caught was in the drill itself.* My first version ran
      `01_invariants.sql` against the restored copy; that file loads fixtures,
      so it cannot run against a database that has data. Fidelity to the source
      is the right assertion for a backup — schema correctness is already
      `make test`'s job.
      *Verified it can fail*, which is the only reason to keep it: restoring
      without `roles.sql` gives `role "authenticated" does not exist` and
      `pg_restore` exits 1. **Only because `restore.sh` passes
      `--exit-on-error`** — the default is to skip what fails and exit 0,
      which is how you get every row and no access control and believe the
      backup for a year.
      **What is still not covered, and no script here will tell you:** product
      images on a local Storage volume, and scheduling the thing off-host. The
      drill is not wired into CI — that needs Docker + Postgres in the
      workflow, which would also pull in `make test`, and is a separate call.

---

## Security

- [x] **14. The RLS role matrix.** — **done for the sensitive tables**,
      migration `20260801002300_role_matrix.sql`.
      *The sharpest edge was not `cost_price`.* `staff_all` was `for all` with
      `using (is_staff())`, so **a warehouse account could `UPDATE` its own
      `staff_users` row and set `role = 'owner'`** — one PostgREST call, no
      admin UI involved. That is now owner/admin only, with a self-read
      everyone keeps because `requireStaff` looks the caller up on every admin
      request and denying it locks all non-owners out entirely.
      *Also closed:* `store_settings` writes (owner/admin), `discounts` and
      `gift_cards` writes (manager+), `customers` and `addresses` (warehouse
      denied — picking uses the address snapshot on the order, not the
      customer's history).
      *Everything else keeps `staff_all`*, deliberately: a matrix that denies a
      role a table it needs shows up as a 403 on a screen someone uses daily,
      and the point was to close sharp edges rather than relitigate 51 tables.
      *Nine tests, written against PostgREST directly rather than the API* —
      the door the README's caveat was about. Every one of them passed before
      the migration, which is what makes them worth having.
      **Still open — `cost_price`, and it is not expressible this way.** Every
      staff member connects as the same `authenticated` database role;
      PostgREST takes it from the JWT's `role` claim, which GoTrue issues, not
      from `staff_users.role`. RLS is row-level and column privileges are per
      database role, so "warehouse may read the variant but not its cost" needs
      a database role per staff role and JWTs carrying it. README.md now says
      exactly this instead of the old blanket caveat.

- [x] **15. Per-account lockout** — **done**,
      `20260801002800_signin_lockout.sql`. Ten failures against one email
      inside fifteen minutes locks that email for fifteen, whatever addresses
      the attempts came from. **The word in the original entry that mattered
      was `invisible`**, and the lock alone would not have fixed it: `jobs.ts`
      now raises `ops.credential_stuffing` when five accounts are locked at
      once, which is what a replayed list looks like from in here.
      *In Postgres, not in process memory* — two containers must not mean two
      counters, and a lockout a redeploy clears is a lockout with a published
      expiry. Staff (owner/admin/manager/support) can read the table; a
      warehouse account cannot, same PII line the role matrix draws on
      `customers`.
      *Two things that would have been bugs.* Failures are counted for
      addresses with **no account**, or the lockout becomes the enumeration
      oracle every 401 in this service is written to avoid. And only a GoTrue
      400/401 counts — a 5xx is not a wrong password, and counting it would
      lock every account that tried at exactly the moment nobody can sign in
      anyway. Both are tested.
      **The cost, stated:** anyone who knows your email can lock you out for
      fifteen minutes. Bounded by the expiry and by a completed password
      reset, which clears the lock immediately. Not escalating on repeat
      lockouts — 40 attempts/hour against one account is slow enough, and
      escalation is where lockouts start hurting customers.

- [x] **16. `/docs` and `/openapi.json`** — **done**, as a switch rather than
      a verdict: `DOCS_PUBLIC`, defaulting to `true`, which is the behaviour
      that was already there. Off, both answer **404 rather than 401** — a 401
      confirms there is something there, which is the one fact whoever asked
      for the route map wanted.
      *Middleware, not a branch around the routes.* `app.doc()` registers its
      own GET handler and the first match wins, so a handler added afterwards
      would never run and the document would stay readable while looking
      gated. That was the first version, and it was wrong.
      *The off case is tested in a subprocess*, because `env.ts` validates at
      import time and bun shares one module registry across test files — by
      the time the test runs, `app.ts` has already been imported with the flag
      on. Fifteen lines, and worth it: the untested direction is the one
      somebody would be relying on.
      **This protects nothing on its own.** If turning it off feels like
      security, the thing to fix is whatever route it is hiding.

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

- [x] Guest order tracking — **done**. `GET /orders/track?order_number=&email=`.
      Guests are a supported way to buy here and that was the end of it: no
      account to sign into, no route that would answer. Order number **and**
      email, because `next_order_number()` uses an ordinary sequence and the
      next number is guessable; `citext` makes the email match
      case-insensitive. A wrong email and an unknown order give the identical
      404, so it cannot be used to find out whether an address has ordered
      here. Registered before `/orders/{id}` — that route's `requireAuth` runs
      ahead of its uuid validation, so second in the chain every guest lookup
      answered 401.
- [x] Checkout can spend store credit — **done**
      (`20260801002500_credit_at_checkout.sql`). `use_credit: true` on checkout;
      `creditApplied` comes back. Capped at the balance, so asking for credit
      you do not have applies nothing rather than failing. Opt-in, because a
      customer with a balance may be saving it.
      *Inside the checkout transaction*, like the coupon redemption and the
      stock reservation, with a lock on the customer row — two checkouts a
      millisecond apart would otherwise read the same balance and both spend
      it. The balance rule is copied from `customer_credit_balances`, expiry
      and all, so the amount spendable and the amount on the customer's screen
      cannot disagree.
      *`grandTotal` still states the order's full value*: credit is a way of
      paying an order, not a discount on it, and the invoice has to agree.
      *Credit covering the whole order marks it paid outright* by calling
      `capture_payment()` rather than repeating its ledger moves — so the
      reservation becomes a sale instead of expiring.
      *One guard had to be generalised.* `capture_payment()` refused any
      capture that was not the full `grand_total` — right reasoning, wrong
      number once credit has already paid part of it. It now compares against
      what is still outstanding, which is exactly `grand_total` when no credit
      is in play. The invariant "a short capture is refused, not reconciled"
      still passes.
      *And it surfaced a stale overload:* the four-argument
      `capture_payment()` from `0015` was superseded by the five-argument one
      in `0017` and never dropped, so a positional four-argument call was
      ambiguous between them. Nothing had noticed, because PostgREST calls it
      by name. Dropped.
- [x] Address edit — **done**. `PATCH /account/addresses/{id}`. Deleting and
      retyping lost the default flag; orders keep their own address snapshot,
      so an edit never rewrites history. Another customer's address is a 404,
      not a 403.
- [x] `GET /admin/customers/{id}` — **done**. Profile, addresses, credit
      balance and recent orders: what a support agent needs open while the
      customer is on the phone. The list had been a search box returning rows
      nobody could act on. The credit figure comes from
      `customer_credit_balances`, the same view checkout spends against, so the
      agent and the till agree. A warehouse account gets 404 — the role matrix
      denies it the table, and RLS answers before the handler does.
- [x] Customer self-cancel — **done**
      (`20260801002600_customer_cancel.sql`, `POST /orders/{id}/cancel`).
      **Pending only**, deliberately narrower than the staff version: that one
      will cancel a paid order and return the sold units, which is the right
      power for staff and the wrong one to hand a customer once money has
      changed hands. Releases the stock hold rather than waiting for
      `release_expired_reservations()` to sweep it. Ownership is in the `WHERE`
      clause, not left to RLS — the function is `security definer`, so RLS does
      not apply to it at all, and someone else's order answers 404 rather than
      403.
- [x] `Cache-Control` and `ETag` — **done**. `hono/etag` on `/catalog/*`,
      `public, max-age=60` on the successes, and **`no-store` as the default
      for everything else** — that default is the half that mattered. The API
      was sending no `Cache-Control` at all, which is not the same as saying
      no: it leaves the decision to whatever sits in front, on routes that
      answer with someone's cart and someone's orders. Sixty seconds because
      catalog rows carry stock; a stale `inStock` costs a shopper a failed
      reservation, not the store an oversell, because `stock >= 0` is nowhere
      near this cache. Errors stay `no-store` — a product going live should
      not spend a minute shadowed by a cached 404.

      The subtlety was the 304. Hono rebuilds it from a six-header allowlist,
      which drops `Access-Control-Allow-Origin` with everything else: the 200
      keeps working and revalidation fails, so it breaks only for the callers
      whose cache was working. The CORS trio is retained explicitly and a test
      pins it.

      The ETag saves the body, not the query — the handler runs either way and
      the digest is taken of what it returned. Saving the query is a cache in
      front of the API, which is a Traefik decision, not this one.

---

## Order to do it in

1. ~~**#5 and #10**~~ — done. Both lost money, both were small.
2. ~~**#7, #8, #9**~~ — done. The API can be deployed and redeployed without
   dropping traffic.
3. ~~**#17**~~ — done, and before the catalog writes as planned.
4. ~~**#2–#4**~~ — done. **#1** remains part-done, and by one thing only:
   products, variants, options, option values, categories and collections all
   have admin routes now. **Product images do not**, and they need the Storage
   decision (`setup.md` C5) before they are worth building.
5. **#14** — schedule it deliberately; it is a migration, not an afternoon.

Both finished items took longer than the entry predicted, for the same reason:
the audit named the symptom from reading the code, and the fix only held once
the behaviour was measured. #5's entry did not know `/admin/outbox` was lying;
#10's entry assumed one wrapper would do it. Expect the same of the rest — the
estimates here are a reading, not a measurement.
