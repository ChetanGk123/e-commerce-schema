# Admin console — build plan

Next.js App Router admin for the schema in this repo, in a Bun monorepo shared with the
storefront. Tick boxes as work lands, update **Status** and the Progress table at the
bottom. Anything discovered mid-build that contradicts this file: fix the file, don't work
around it.

**Status**: `Phase 0 done -- apps/admin builds, runs and reaches the API. Phase 1 next`
**Created**: 2026-08-17
**Revised**: 2026-08-20 -- the shell now comes from a template rather than `bun create next-app`
**Complexity**: Large (~3 weeks to a usable console)
**Depends on**: `docs/api-plan.md` — **build that first.** B0–B4 there unblock this file's read-only screens

> **Superseded by `api-plan.md` where they disagree.** The admin no longer talks to
> Supabase directly: all data goes through `apps/api`, which forwards the caller's JWT.
> The admin holds **no** service key, and the `0012_admin_rpc.sql` migration moved to
> api-plan B3. Phases below are updated; the storefront track collapsed to "call the API".

---

## Summary

Three apps in a Bun workspace over **one self-hosted Supabase**: `apps/api` (the backend,
see `docs/api-plan.md`) plus the admin and storefront front ends. Every request carries the
signed-in user's JWT through to Postgres, so `audit_logs` keeps real attribution.

Neither app talks to Postgres. **`apps/api` owns all database access**; both apps call it
over HTTP with the caller's Supabase session JWT as a bearer token.

**Nor does either app hold a Supabase client** — superseded by api-plan B16, and Phase 1
below says so at the line it replaced. Credentials go to `POST /auth/sign-in` and the
session comes back to be stored in an httpOnly cookie the app sets itself. There is no
`NEXT_PUBLIC_SUPABASE_*` in the admin at all, which is also what makes the "grep the bundle
for a key" check in Phase 1 a check rather than a hope.

| | Storefront | Admin |
|---|---|---|
| Browser holds | session JWT in an httpOnly cookie | same |
| Data path | `apps/api` | `apps/api` |
| Service key | **neither app holds it** — only the API does | — |
| Variant reads (server-side, in the API) | `storefront_variants`, hides `cost_price` | `product_variants` base table |

Hosting is **Dokploy** throughout, with self-hosted Supabase from
`ChetanGk123/dokploy-templates`. See api-plan's Hosting section for the internal
(`http://kong:8000`) vs public (`https://supabase.<domain>`) URL split.

---

## Repo layout

```
e-commerce-schema/           workspace root
├── package.json             private; holds `workspaces`, `packageManager: bun@1.x`
├── bun.lock                 text lockfile — commit it
├── turbo.json               task graph + cache config
├── apps/
│   ├── api/                 Hono on Bun — see docs/api-plan.md
│   ├── admin/               this plan
│   └── store/               storefront (track below)
├── packages/
│   ├── schema/              workspace package @ecom/schema
│   │   ├── package.json     name + exports map + zod dep
│   │   ├── database.types.ts   written by `make types`
│   │   ├── enums.ts
│   │   └── validation.ts    already has both storefront and admin schemas
│   └── client/              @ecom/client — typed `hc` client over the API
├── supabase/                unchanged, single project, both apps point at it
├── scripts/ · docs/ · Makefile   unchanged
```

**Moved to `packages/schema/`** (2026-08-20). This file previously argued for leaving it
at the repo root, on the grounds that moving it meant editing the generator to chase it.
That cost turned out to be one string in `scripts/gen_types.py` — too small to buy a
permanent exception in the workspaces array, where `types` had to sit as a third entry
beside `apps/*` and `packages/*`. Nothing imports by path: every consumer already used
`@ecom/schema/...`, so no import changed.

```jsonc
// packages/schema/package.json
{
  "name": "@ecom/schema",
  "private": true,
  "exports": {
    "./enums":      "./enums.ts",
    "./database":   "./database.types.ts",
    "./validation": "./validation.ts"
  },
  "dependencies": { "zod": "^3" }   // validation.ts imports it
}
```

Both apps need `transpilePackages: ["@ecom/schema"]` in `next.config.ts` — the package
ships raw TypeScript, and without this the build fails on the first import.

---

## Decisions (change these here, not in conversation)

| Decision | Choice | Why |
|---|---|---|
| Package manager | **Bun** | Install speed, and `bun.lock` is the only lockfile in the tree |
| Layout | Bun workspaces: `apps/*` and `packages/*`; `packages/schema` is `@ecom/schema` | All three need the same enums, row types and Zod schemas |
| Hosting | **Dokploy**, self-hosted Supabase from `ChetanGk123/dokploy-templates` | End-state target. Backups become your responsibility — see api-plan risks |
| Monorepo tooling | Bun workspaces + **Turborepo** | One `turbo.json`, no layout change. Buys `turbo dev` for both apps, CI remote caching across two Next builds, and task ordering so `@ecom/schema` typechecks first. Not Nx — its generators/plugins are scaffolding this repo won't use |
| Next.js runtime | **Node, not Bun** | `bun run dev` respects the `next` binary's `#!/usr/bin/env node` shebang, so Next runs on Node by default. Do not add `--bun` — Bun is the installer and script runner here, not the server runtime |
| Admin shell | **`ChetanGk123/next-shadcn-admin-dashboard`**, branch `template` | Next 16, React 19, Tailwind 4, shadcn, TanStack Query + Table, react-hook-form, recharts, biome -- the stack this file already specified, already assembled. Vendored, not submoduled: it is a starting point, not a dependency, and it stops being that repo the moment the first screen is written |
| Zod version | **v3 across the workspace**, template downgraded to match | The template ships v4. `@ecom/schema` is v3 and `@asteasolutions/zod-to-openapi@7` inside `@hono/zod-openapi` requires v3, so going the other way means migrating the API's whole contract layer. Only 5 template files import zod and the v4-only syntax is `z.email()`/`z.url()` -- the cheap direction is obvious |
| Shared package | `packages/schema` | Every library lives under `packages/`; `make types` writes there |
| Shared UI package | **None** | Dense admin tables and a marketing storefront have opposite constraints. Create `packages/ui` only when a second app imports the same component |
| Auth for data (admin) | Session via `@supabase/ssr`; **data via `apps/api`** with that JWT as a bearer token | The API forwards it to Postgres, so `auth.uid()` — and the audit trail — survives |
| Service key | **Not in this app.** Only `apps/api` holds it | Keeps the blast radius in one deployable |
| Auth cookie names | Distinct per app (`sb-admin-*` / `sb-store-*`) | Same parent domain otherwise means one login clobbers the other |
| Client-side data fetching (admin) | None | Server Components read, Server Actions write, `revalidatePath` |
| List state | URL search params | Server filters using indexes that already exist |
| Table library | None initially | Server-side pagination; adopt the TanStack triad only where a screen needs it |
| Typing API calls | `hc` client types from `apps/api` | End-to-end inference; a breaking route change fails this app's typecheck |

---

## Assets this builds on

| Asset | Use | Shared? |
|---|---|---|
| `supabase/migrations/20260801000000_baseline.sql` | 56 tables, RLS, triggers (squashed baseline) | one project, both apps |
| `packages/schema/database.types.ts` | Row interfaces + `Row<'orders'>` helper (`make types`) | both |
| `packages/schema/enums.ts` | 29 `as const` unions + label maps → selects, chips, badges | both |
| `packages/schema/validation.ts` | Zod — storefront schemas (checkout, review, return, ticket) **and** `productAdminSchema`, `variantAdminSchema`, `discountAdminSchema` | both, already written for both |
| `supabase/migrations/20260801000000_baseline.sql` | Which list queries are cheap | both |

| `ChetanGk123/next-shadcn-admin-dashboard@template` | The shell: auth pages, dashboard layout, data-table, form primitives, theming | admin now, storefront never — different constraints |

**Frontend patterns**: none exist in this repo *yet* — Phase 0a brings the template's in.
Conventions come from the `nextjs-admin-patterns` skill — colocation, thin server `page.tsx`, one widget per file,
semantic tokens, kebab-case, no `any`.

---

## Rules the UI must obey

DB-enforced, and the API rejects them too. They stay in this file because **the UI must not
offer the affordance in the first place** — a stock field that always errors is worse than
no stock field.

- [ ] **No stock field on any form.** `stock` is a cache of `inventory_movements`. `variantAdminSchema` already omits it.
- [ ] **No edit/delete on ledgers**: `inventory_movements`, `credit_ledger`, `gift_card_transactions`, `order_events`, `price_history`, `invoices`. Corrections are new rows.
- [ ] **No "edit invoice"**. The button is "Issue credit note". Only `pdf_url` + e-invoice fields update.
- [ ] **Variant option values insert in ONE statement.** Loop-inserting raises a bogus `uniq_variant_combo` violation (`refresh_signature()` in `supabase/migrations/20260801000000_baseline.sql`).
- [ ] **Order totals recompute** `grand_total = subtotal − discount + shipping + tax` or `orders_totals_balance` bounces the write.
- [ ] **Phones are E.164.** Reuse the `phone` transform (`validation.ts:48`). A blocklist entry without `+91` blocks nobody.
- [ ] **Customers are never deleted.** The button calls `anonymize_customer(uuid)`.
- [ ] **One default variant / one default address.** The form toggles, it doesn't add.

---

## Phase 0 — Workspace scaffold · Low

**The workspace half is done.** Written before `apps/api` existed; the API's
own build did all of it. Recorded rather than deleted, because the reasons
still hold and the next app scaffolded here needs them:

- [x] Root `package.json` (private) — `"workspaces": ["apps/*", "packages/*"]`, `packageManager: bun@1.3.11`, `dev`/`build`/`lint`/`typecheck` via `turbo`
- [x] `bun install` at the root; internal deps use `"@ecom/schema": "workspace:*"`
- [x] `turbo.json` — `build` depends on `^build`, outputs `.next/**` minus `.next/cache/**`; `dev` is `persistent: true`, `cache: false`
- [x] **`turbo.json` `env` lists the `SUPABASE_*` vars** — Turborepo hashes on declared env only, so an undeclared var means a stale cached build carrying another project's keys
- [x] `packages/schema/package.json` — `@ecom/schema`, exports map, `zod` dependency
- [x] `.gitignore`: `node_modules/`, `.next/`, `.turbo/` — **`bun.lock` stays tracked**
- [x] CI uses `oven-sh/setup-bun`, not `setup-node`

### 0a. Vendor the template

Replaces `bun create next-app`. The point of the template is that the shell
already exists; the point of this step is that it stops being a separate
repo and becomes a workspace member with no leftovers.

- [x] Copy the `template` branch to `apps/admin`, **without its `.git`**
- [x] `package.json` → `@ecom/admin`, private, add `"@ecom/schema": "workspace:*"`
- [x] **Delete its `bun.lock`** — one lockfile at the workspace root, and a second one is how two versions of the same package end up installed
- [x] Delete its `compose.yaml` — the root `docker-compose.yml` owns orchestration
- [x] Delete its `.github/` — CI is one workflow at the root
- [x] Delete `.gitignore`, `.editorconfig`, `.nvmrc` — the root already has them; a second copy is a second thing to disagree
- [x] **Reconcile `AGENTS.md` and its `.claude/skills/`.** The template carries its own conventions and this repo has `nextjs-admin-patterns` and `code-layout`. Two sets of house rules in one tree is worse than either. Fold anything genuinely new into the repo's skills and delete the rest
- [x] **Validate**: `bun install` at the root resolves one zod and one React; `git status` shows no stray dotfiles

### 0b. Make it agree with the workspace

- [x] **zod v4 → v3** in the 5 files that import it — `login-form`, `register-form`, `forgot-password-form`, `profile-form`, `lib/env.ts`. `z.email(…)` → `z.string().email(…)`, `z.url(…)` → `z.string().url(…)`
- [x] `transpilePackages: ["@ecom/schema"]` in `next.config.mjs` — the package ships TypeScript source, not a build
- [x] Import one schema from `@ecom/schema` in a form that already exists, to prove the wiring before nine screens depend on it
- [x] **Validate**: `bun run typecheck` clean across every workspace, strict on, zero `any`; `bun run build` produces `.next`

### 0c. Run it like the API runs

- [x] `apps/admin/Dockerfile`, modelled on `apps/api/Dockerfile`: build context is the **repo root** because `@ecom/schema` is a workspace sibling, with a `dev` stage for hot reload and a `runtime` stage for what deploys
- [x] `output: "standalone"` in `next.config.mjs`, so the runtime stage copies a self-contained server rather than the whole `node_modules`
- [x] `admin` service in `docker-compose.yml` — `target: dev`, port **3000**, on the `default` and `dokploy-network` networks with a `${COMPOSE_PROJECT_NAME}-admin` alias
- [x] `docker-compose.prod.yml`: `target: runtime`, `volumes: !reset []`, `ports: !reset []`, `traefik.docker.network=dokploy-network`
- [x] Env — **no Supabase client in this app at all** (see Phase 1): `API_URL=http://api:3001` internally. Add to `.env.prod.example` and `docs/deployment.md`
- [x] `CORS_ORIGINS` on the API must include the admin's origin — `apps/api/.env.example` already assumes 3000
- [x] **Validate**: `docker compose up -d` brings admin up beside api; the admin container reaches `http://api:3001/health`; `make test` still green — the workspace must not disturb the schema toolchain

> `apps/store` is scaffolded the same way when the storefront track starts — not now.
> Upgrade path if full client inference is wanted later: extend `scripts/gen_types.py` to
> also emit a `Database` interface — one script, not a parallel toolchain.

## Phase 1 — Auth, shell, role guard · Medium

- [ ] `proxy.ts` (Next 16's middleware): refresh session, redirect to `/login`
- [ ] ~~`src/lib/supabase/server.ts` — cookie-bound `createServerClient`~~ — **superseded by api-plan B16.** The admin has no Supabase client at all now: it posts credentials to `POST /auth/sign-in` and stores the returned session in an **httpOnly** cookie it sets itself (`sb-admin`), refreshing through `POST /auth/refresh`. No `NEXT_PUBLIC_SUPABASE_*` in this app
- [ ] `src/lib/api.ts` — `hc` client from api-plan B12, with the session JWT attached as `Authorization: Bearer`
- [ ] `src/lib/auth.ts` — `getStaff()` (per-request cached, from the API's `/me`), `requireRole([...])` for nav and page gating
- [ ] Shell: sidebar + header; nav as typed data in `src/navigation/sidebar/sidebar-items.ts`, filtered by role
- [ ] `/unauthorized` for non-staff and `is_active = false` — **a customer's login is valid auth with no `staff_users` row; this is the check that stops them**
- [ ] **Validate**: log in as each role; grep `.next/static` for the service key (must be absent); log into store and admin in one browser and confirm neither session evicts the other

**Role map** (`STAFF_ROLES`, `enums.ts:140`):

| Role | Sees |
|---|---|
| `owner`, `admin` | everything incl. `cost_price`, settings, staff, audit log |
| `manager` | catalog, orders, inventory, discounts, customers — no staff/settings, no cost price |
| `support` | orders (read), tickets, enquiries, returns, customers, reviews |
| `warehouse` | order queue, inventory, shipments, returns receipt — no PII beyond shipping address, no prices |

## Phase 2 — Data layer conventions · Low

- [ ] Server Components call the API · Server Actions call the API · `revalidatePath` after
- [ ] List state in URL search params (page / sort / filters / q), forwarded as query params
- [ ] Render the API's error envelope (api-plan B2 owns the constraint→copy mapping — do **not** reimplement it here)
- [ ] Money `Intl.NumberFormat('en-IN', {currency:'INR'})`; dates `Asia/Kolkata`
- [ ] **Validate**: customers list end-to-end proves the pattern before it's copied nine times

## Phase 3 — *moved*

The `0012_admin_rpc.sql` migration now lives in `docs/api-plan.md` as **B3**. Nothing in
this app authors SQL or calls `.rpc()` — it calls API endpoints that do.

Kept as a numbered gap on purpose: the phase numbers below are referenced elsewhere.

## Phase 4 — Orders · High · *the core*

- [ ] List — status/date/payment/risk filters, search by order number or email (`idx_orders_open`, `idx_orders_placed`, `idx_orders_email`)
- [ ] Detail — items, payments, shipments, invoices, refunds, returns + `order_events` timeline, one embedded select
- [ ] Actions wired to Phase 3 RPCs, role-gated
- [ ] Risk panel — `risk_score` / `risk_flags`, one-click blocklist add
- [ ] Invoice — issue / view / credit note (no edit path exists)
- [ ] **Validate**: pending → paid → packed → shipped → delivered → return → credit note, with `audit_logs.staff_id` non-null throughout

## Phase 5 — Catalog · High

- [ ] Products, categories, collections CRUD
- [ ] Variant editor: option axes → combination matrix → per-variant price/SKU/specs, submitted as **one** payload (the API does the batched `variant_option_values` insert)
- [ ] Publish as a separate action (`draft` → `active`)
- [ ] **Deep cycle validation on category reparent** — the CHECK blocks one hop only (`categories_no_self_parent` in `supabase/migrations/20260801000000_baseline.sql`); the API owns the check, this app surfaces the error
- [ ] Image upload → API → Supabase Storage. **Self-hosted Storage defaults to a local volume** — confirm the backend and that it is covered by the backup job
- [ ] Search via `pg_trgm` on name/brand/SKU
- [ ] Price history panel — note `changed_by` is null by trigger; attribute from `audit_logs`
- [ ] **Validate**: 3-axis product; exactly one default variant; duplicate combo rejected; draft invisible via `storefront_variants` + anon key

## Phase 6 — Inventory · Medium

- [ ] Movements ledger per variant, read-only, newest first
- [ ] Receive stock / Adjust — plain inserts with `created_by = staff.id` (no RPC needed)
- [ ] Low-stock queue (`idx_variants_low_stock`)
- [ ] Reservations monitor + "when did `release_expired_reservations()` last run?"
- [ ] **Validate**: receive 50, sell 1, adjust −2 → `variant.stock` equals the ledger sum; no UI path writes `stock`

## Phase 7 — Money ops · High

- [ ] Discounts (reuse `discountAdminSchema`)
- [ ] Returns / RMA queue → `admin_receive_return`
- [ ] Refunds
- [ ] Gift cards — code shown **once** at issue, then only `last4`; lookup by `digest(code,'sha256')`
- [ ] Store credit — read `customer_credit_balances`, write ledger entries (no balance field exists)
- [ ] Invoice register
- [ ] **Validate**: redeem a `max_uses = 1` coupon twice; overspend a gift card; edit an invoice — all three fail with readable copy

## Phase 8 — Customers & support · Medium

- [ ] Customers — addresses, orders, credit, consent
- [ ] Delete → `anonymize_customer()`, with a confirmation stating what's kept (GST retention) and what's scrubbed
- [ ] Tickets — assignment, internal notes, first-response SLA (`idx_tickets_queue`, `idx_tickets_assigned`)
- [ ] Enquiries
- [ ] Reviews moderation — `is_verified` is generated: display, never set
- [ ] **Validate**: anonymize a customer with orders; invoices, credit ledger and order history survive, PII gone

## Phase 9 — Store config & ops · Medium

- [ ] Settings (warn: `config` is non-secret only, the `store_settings.config` comment in `supabase/migrations/20260801000000_baseline.sql`)
- [ ] Shipping zones / rates — validate non-overlapping bands client-side, DB as backstop
- [ ] Pincodes — CSV import from courier serviceability file
- [ ] Blocklist
- [ ] Staff users — the API creates the auth user and the `staff_users` row (it holds the service key); this app renders the form. `owner` only
- [ ] Audit log viewer
- [ ] Message-log outbox + webhook health (`idx_webhook_unprocessed`)
- [ ] **Validate**: overlapping rate band rejected; non-owner can't reach staff management by URL

## Phase 10 — Dashboard · Medium · *built last, deliberately*

- [ ] Revenue, orders by status, AOV, top products
- [ ] Low stock, open returns/tickets
- [ ] Abandoned-cart recovery, enquiry → order conversion
- [ ] **Validate**: every widget reads a Phase 3 view or an indexed query

## Phase 11 — RLS role matrix · High · optional, recommended

- [ ] Replace the `staff_all` blanket with per-role policies
- [ ] **Until this ships, role gating in Phases 1–10 is UX, not security**

---

## Storefront track (`apps/store`) — sketch

Deliberately thin. The admin is the current ask; this exists so the workspace shape makes
sense and so shared code isn't designed around one consumer. Ask for detail when you want
it and this becomes its own phase list.

Now that `apps/api` owns the business logic, this track is **presentation only** — every
item below is "call the API and render it". The hard parts (checkout ordering, webhook
idempotency, gift-card hashing) moved to api-plan B5–B8.

- [ ] **S0** Scaffold `apps/store` — same stack, `transpilePackages`, `sb-store` cookie name
- [ ] **S1** Catalog — product listing, product page, search, pincode check
- [ ] **S2** Cart — including guest carts by session id
- [ ] **S3** Checkout — collect input, POST once with an idempotency key, render the outcome
- [ ] **S4** Order confirmation + tracking timeline
- [ ] **S5** Account — orders, returns, reviews, addresses, preferences, credit balance
- [ ] **S6** Support — tickets, enquiries, stock alerts

**Shared with admin**: `@ecom/schema` and the `hc` client type. Not components, not
layout — a dense admin table and a marketing product page have opposite constraints.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Staff JWT hits PostgREST directly, bypassing UI roles | Certain (by design) | High | Documented accepted risk; Phase 11 is the only real fix |
| Service key leaks to client bundle | Low | Critical | Neither app holds it now — only `apps/api`. CI grep on `.next/static` stays as a backstop |
| Transaction-mode pooling breaks invoice numbering | Medium | High | RPCs make each op one statement; session-mode connection string for anything else (`README.md:120`) |
| Variant option values inserted in a loop | High (easy mistake) | Medium | Single batched insert + a test |
| Audit trail goes anonymous | High if the API uses the service key | Medium | Owned by api-plan B1; asserted there by test |
| `packages/schema/database.types.ts` drifts | Medium | Medium | `make types` in CI, fail on diff |
| Reservation sweeper not scheduled | Medium | High | Phase 6 surfaces last-run time |
| Admin and store auth cookies collide on one domain | Medium | High | Distinct `cookieOptions.name` per app; Phase 1 validates with both open |
| Storefront-scoped API routes leak `cost_price` | Medium | High | api-plan B4 splits storefront vs admin catalog routes and validates it |
| Service-key client imported into the storefront browser bundle | Low | Critical | `import "server-only"`, same CI grep as admin, run against both apps |
| Shared `@ecom/schema` change breaks the other app silently | Medium | Medium | `turbo build` in CI builds both apps against it |
| Turborepo serves a stale cached build with the wrong Supabase keys | Medium | High | Declare every `SUPABASE_*` var in `turbo.json` `env`; undeclared env is not part of the cache hash |
| Turborepo's Bun support is younger than its npm/yarn/pnpm support | Low | Medium | Plain `turbo build`/`dev` is fine. Verify before relying on `turbo prune` (Docker builds) — that's where the gaps have historically been |

---

## Deliberately not building

Custom auth · a permissions framework · client-side data caching · a design system beyond
shadcn · real-time subscriptions. Add each when a specific screen proves it's needed.

Scope cuts come from Phase 10 downward — **not** from Phase 3. Phases 4 and 5 alone give
a store you can operate.

---

## Progress

### Admin

| Phase | Status | Notes |
|---|---|---|
| 0 Workspace scaffold | **done** | template vendored to `apps/admin`; zod v3, `@ecom/schema` wired, Dockerfile + compose, hot reload verified |
| 1 Auth & shell | not started | |
| 2 Data layer | not started | |
| 3 ~~RPC migration~~ | moved | now api-plan **B3** |
| 4 Orders | not started | |
| 5 Catalog | not started | |
| 6 Inventory | not started | |
| 7 Money ops | not started | |
| 8 Customers & support | not started | |
| 9 Config & ops | not started | |
| 10 Dashboard | not started | |
| 11 RLS role matrix | optional | |

### Storefront

| Phase | Status | Notes |
|---|---|---|
| S0 Scaffold | not started | after admin Phase 1 proves the workspace |
| S1 Catalog | not started | via API |
| S2 Cart | not started | |
| S3 Checkout | not started | UI only; api-plan B5 does the work |
| S4 Payment & webhooks | not started | record before acting |
| S5 Account | not started | |
| S6 Support | not started | |
