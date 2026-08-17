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
6. **Never return `err.message` to a caller.** Constraint names, SQL fragments
   and table structure are all reconnaissance. Log the detail under the request
   id and answer with a mapped message or a support code.
7. **Validate input with `@ecom/schema`.** Money and stock are recomputed
   server-side from the database regardless of what the body claims.
8. **Tests run in-process** through `app.request()`: no port, no network, no
   database. Mirror `supabase/tests/01_invariants.sql` — assert the thing
   *refuses*, not just that the happy path works.

## Which Supabase client

This is the decision most likely to be got wrong, and it is silent when it is.

| Situation | Client | Why |
|---|---|---|
| Anything a staff member does as themselves | `callerClient(token)` | RLS applies and `auth.uid()` is populated, so `audit_logs.staff_id` is attributed |
| Checkout, payment capture, webhooks, creating staff auth users | `serviceClient()` | Needs to read prices the client must not choose, or act with no user present |
| Anything else | `callerClient(token)` | Default to the caller |

`audit_row()` reads `auth.uid()`. Run a staff write on the service key and the
row is recorded anonymously — proven in this repo: the same `UPDATE` produced
`staff_id = 879e14e1…` under a forwarded JWT and `NULL` under the service key.
`staff_all` already grants active staff full access, so forwarding costs nothing
in capability.

## Auth

`requireAuth` → 401, "we do not know who you are".
`requireStaff` → 403, "we know, and it is not staff".
`requireRole(...)` → 403, wrong role.

A customer's token is **valid auth**. The missing `staff_users` row is the only
thing keeping shoppers off the admin surface, so `requireStaff` is load-bearing.

Every 401 returns the same message. Telling a caller whether a token was
expired, forged or malformed is a free oracle; the reason goes to the log.

`requireRole` shapes the product surface and **contains nobody** — RLS ignores
`staff_users.role`. Never describe it as a security control.

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

## Adding a route

1. Find the closest existing route and match its shape.
2. Reuse or add the zod schema in `@ecom/schema`.
3. `createRoute` with every status you return, then the handler.
4. Pick the client deliberately: caller-bound unless it is one of the four
   service-key cases.
5. Mount it in `app.ts` — the chained `.route()` is what extends `AppType`.
6. Add a test that asserts the refusal, not only the success.
