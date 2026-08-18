---
name: hono-api-patterns
description: House conventions for the Hono-on-Bun API in apps/api — route modules, OpenAPI-from-zod, middleware, auth, the caller-bound vs service-key Supabase split, error envelopes, logging, and in-process tests. Use when adding or changing an endpoint, writing middleware, deciding which Supabase client an operation gets, mapping a database error to a response, or writing a test for apps/api. Also use when deciding where a file belongs inside apps/api.
---

# Hono API patterns

Conventions for `apps/api`, extracted from what is already built there. When
this file and the code disagree, the code is probably right and this file is
stale — fix it.

**Era:** Hono 4, `@hono/zod-openapi` 0.19, Bun 1.3, zod **v3**, TypeScript
strict. Zod stays on v3 because `@ecom/schema` is written in v3 syntax; one zod
version across the workspace is deliberate.

`nextjs-admin-patterns` and `code-layout` do not apply here — both are
React/Next-shaped. This is the API's own convention.

## The one rule that drives everything

**One zod schema, four outputs.** A schema written once in `@ecom/schema`
becomes runtime validation, TypeScript types, the OpenAPI document, and the
`hc` client type. Never redeclare a shape that already exists in
`types/validation.ts` — importing it is what keeps the contract from drifting
across three consumers.

## Folder structure

```
apps/api/
├── src/
│   ├── app.ts           builds the app, mounts routes, exports AppType
│   ├── server.ts        process entry — the ONLY file that binds a port
│   ├── index.ts         package entry: AppType for hc
│   ├── env.ts           validated at import; throws on bad config
│   ├── logger.ts        pino + request-id middleware
│   ├── auth.ts          requireAuth / requireStaff / requireRole
│   ├── supabase.ts      callerClient() / serviceClient()
│   ├── errors.ts        constraint name -> status + message   (B2, not yet)
│   └── routes/
│       └── <area>.ts    one file per area, exports <area>Route
└── test/
    └── <area>.test.ts   in-process, app.request()
```

| Question | Answer |
|---|---|
| A new endpoint | `src/routes/<area>.ts`, grouped by domain area, not by verb |
| Used by 2+ routes | `src/<name>.ts` at the top level |
| Only this route needs it | Keep it unexported in the route file |
| Touches money or stock | It is server-side by definition — see "Which client" |

## Rules

1. **`server.ts` is the only file that binds a port.** `app.ts` builds and
   exports; importing `AppType` or calling `app.request()` in a test must never
   start a listener as an import side effect.
2. **Every route is declared with `createRoute`,** not `app.get(...)`. The
   declaration is what produces the OpenAPI entry and the `hc` type. A raw
   handler is invisible to both.
3. **Name response schemas with `.openapi("Name")`** so they become reusable
   components rather than inlined blobs.
4. **Register the failure statuses you actually return** (401/403/404/409) in
   `responses`. An undocumented status is a client that cannot handle it.
5. **Middleware via `createMiddleware`** from `hono/factory`, with anything it
   sets declared on `ContextVariableMap` so `c.get()` stays typed.
6. **Every router is `new OpenAPIHono({ defaultHook: validationHook })`.** Without
   it a 400 answers with `{ success: false, error: { issues: [...] } }` --
   a different envelope from every other failure, with no `code` to branch on.
7. **Never return `err.message` to a caller** -- with exactly one exception.
   Constraint names, SQL fragments and table structure are all reconnaissance,
   so the detail goes to the log under the request id and the caller gets a
   mapped message or a support code. The exception is a refusal raised with
   SQLSTATE `ECOM1` (-> 422) or `ECOM2` (-> 409). Postgres never emits those,
   so the SQLSTATE proves *we* wrote the message; `hint` carries the machine
   code. Raise them from SQL when the copy belongs beside the rule that
   decided it -- `checkout()` does.
8. **Validate input with `@ecom/schema`.** Money and stock are recomputed
   server-side from the database regardless of what the body claims.
9. **Tests run in-process** through `app.request()`: no port, no network, no
   database. Mirror `supabase/tests/01_invariants.sql` — assert the thing
   *refuses*, not just that the happy path works.

## Which Supabase client

This is the decision most likely to be got wrong, and it is silent when it is.

| Situation | Client | Why |
|---|---|---|
| Anything a staff member does as themselves | `callerClient(token)` | RLS applies and `auth.uid()` is populated, so `audit_logs.staff_id` is attributed |
| Public storefront reads (`/catalog`, `/shipping`) | `anonClient()` | The public view of the catalog, identically for everyone. RLS's `public_read` policies do the scoping |
| Guest carts (no token at all) | `serviceClient()` | `carts` has no policy for `anon`; the schema says a JWT-less session identity cannot be trusted to RLS |
| Payment capture, webhooks, creating staff auth users | `serviceClient()` | Acts with no user present |
| Reading a guest order (`/payments/*`) | `serviceClient()` | A guest order has no `customer_id`, so no policy can reach it; authorise explicitly in the handler |
| Anything else | `callerClient(token)` | Default to the caller |

Storefront routes use `anonClient()` **even when the caller is signed in**. Forwarding a
staff token to `/catalog` would show drafts on the public storefront; forwarding a
customer's changes nothing, because the policies are identical for `anon` and
`authenticated`. Determinism is worth more than the token.

**`/checkout` is not on the service key,** despite writing orders. `checkout()` is
SECURITY DEFINER and reads the customer from `auth.uid()`, so the caller's token has to
reach Postgres — signed in it is `caller.db`, guest it is `anonClient()`. On the service
key `auth.uid()` is null and every order becomes a guest order: no `customer_id`,
invisible in "my orders", unattached to the account that paid. Nothing errors.

`X-Cart-Session` is a **bearer credential**, not an identifier. Generate it server-side,
never echo a client-supplied one back as the cart's own id, and never log it.

`audit_row()` reads `auth.uid()`. Run a staff write on the service key and the
row is recorded anonymously — proven in this repo: the same `UPDATE` produced
`staff_id = 879e14e1…` under a forwarded JWT and `NULL` under the service key.
`staff_all` already grants active staff full access, so forwarding costs nothing
in capability.

## Auth

`requireAuth` → 401, "we do not know who you are".
`optionalAuth` → guest if there is no token, **401 if there is a broken one**.
`requireStaff` → 403, "we know, and it is not staff".
`requireRole(...)` → 403, wrong role.

`optionalAuth` is for the surfaces a shopper reaches before signing in — the cart and
checkout. Demoting an expired token to a guest instead of answering 401 would hand the
customer an empty cart and place their order against no account.

A customer's token is **valid auth**. The missing `staff_users` row is the only
thing keeping shoppers off the admin surface, so `requireStaff` is load-bearing.

Every 401 returns the same message. Telling a caller whether a token was
expired, forged or malformed is a free oracle; the reason goes to the log.

`requireRole` shapes the product surface and **contains nobody** — RLS ignores
`staff_users.role`. Never describe it as a security control.

## Money leaving

Refunds, credit and gift cards follow the same shape as webhooks, for the same
reason: the record has to survive the failure.

1. **Write the intent first, then call the gateway.** `admin_refund` inserts a
   `refunds` row as `initiated` before anything reaches Razorpay. A refund that
   evaporates on a timeout is one the customer was already told about.
2. **Never compute a balance in the handler.** `customer_credit_balances` for store
   credit, `gift_cards.balance` maintained by trigger. `credit_ledger` is append-only:
   a wrong entry is fixed by a compensating entry, and both stay visible.
3. **A gift card code exists in exactly one response.** Only `digest(code,'sha256')` is
   stored. Never log it, never return it again, and keep it out of every schema but the
   issue response.
4. **One message for every redemption failure.** "Expired" versus "unknown" tells
   someone guessing codes that they guessed one.
5. **pgcrypto is in the `extensions` schema on Supabase**, so any function using
   `digest()` or `gen_random_bytes()` needs `set search_path = public, extensions,
   pg_temp`. A missing schema in search_path is ignored, so this is safe on plain
   Postgres. pg_temp stays last.

## Webhooks

Verify, record, act, mark processed — in that order, and the order is the design.

1. **The signature is the only authentication.** Verify it over the **raw body**
   (`await c.req.text()`), never over re-serialised JSON: the HMAC is over bytes, and
   whitespace or key order changing makes every signature fail in a way that reads like
   a wrong secret.
2. **Record before acting.** `record_webhook()` first. A crash between acting and
   recording captures twice.
3. **Gate on `processed_at`, not on the unique index.** A duplicate whose first attempt
   *failed* still needs processing.
4. **Acknowledgement means recorded, not acted on.** Once the row is written, answer
   200 even if processing failed and put the reason in `webhook_events.error`. Reserve
   5xx for "could not write it down" — the only failure a retry fixes.
5. **No `security: [{ bearerAuth: [] }]`** on a webhook route. A gateway cannot send our
   token, and declaring it makes the published docs lie.
6. **Reject unverified deliveries without recording them**, or anyone can fill the
   table by posting garbage. The rejection goes to the log.

## Logging

Paired `-->` and `<--` lines per request sharing a request id, emitted from a
`finally` so a throwing route still logs its end. A request that hangs or kills
the process leaves its `-->` behind; a single completion line would show
nothing.

Log method, path, status, duration, and `userId` once resolved. **Never** log
headers, bodies, query values, tokens, gift-card codes or customer PII — a log
line outlives the request and lands in every backup of the log store.

## Anti-patterns

| Don't | Do | Why |
|---|---|---|
| `app.get("/x", handler)` | `createRoute` + `.openapi()` | Invisible to OpenAPI and to `hc` |
| Service key for a staff write | `callerClient(token)` | Anonymises `audit_logs` |
| `return c.json({ error: err.message })` | Map it, or return a support code | Leaks constraint and table names |
| Redeclare a zod shape already in `types/validation.ts` | Import it | Three consumers drift apart |
| `update product_variants set stock` | Insert `inventory_movements` | Stock is a ledger cache — see `schema-rules` |
| Start a server in `app.ts` | Keep it in `server.ts` | Importing `AppType` would bind a port |
| Test by booting a server on a port | `app.request()` | Slower, flakier, needs a free port |
| Different 401 messages per failure mode | One message | Free oracle for attackers |
| `new OpenAPIHono()` bare | Pass `defaultHook: validationHook` | 400s answer in a different envelope |
| Re-declaring `ErrorResponse` per route file | Import from `schemas.ts` | `.openapi("ErrorResponse")` may register the name once |
| Money arithmetic in the handler | Compute it in SQL | A cart and an invoice a paisa apart |

## Adding a route

1. Find the closest existing route and match its shape.
2. Reuse or add the zod schema in `@ecom/schema`.
3. `createRoute` with every status you return, then the handler.
4. Pick the client deliberately: caller-bound unless it is one of the four
   service-key cases.
5. Mount it in `app.ts` — the chained `.route()` is what extends `AppType`.
6. Add a test that asserts the refusal, not only the success.
