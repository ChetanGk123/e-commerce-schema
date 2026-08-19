# `@ecom/api`

Hono on Bun. One service behind both the admin console and the storefront.

```sh
bun run dev        # http://localhost:3001, hot reload
bun test           # 136 in-process tests: no port, no network, no database
bun run typecheck
```

Needs `apps/api/.env` — copy `.env.example` and fill it from your Supabase
stack (`docs/setup.md`).

---

## Poking at it

### Swagger UI — `http://localhost:3001/docs`

Every route is declared with `createRoute`, so the OpenAPI document is
generated from the same zod schemas that validate the requests. It cannot
drift from the code the way a hand-written spec does.

Click **Authorize**, paste an access token (see below), and the protected
routes work from the browser. Routes are marked in the document as they are in
the code:

| | |
|---|---|
| `/health`, `/catalog/*`, `/shipping/quote` | public — no token, by design |
| `/me`, `/admin/*` | padlocked — `requireAuth` + `requireStaff` |

Swagger UI loads its assets from a CDN, so `/docs` needs internet.
`/openapi.json` does not.

### Postman / Insomnia / Bruno / Hoppscotch

Import the URL directly:

```
http://localhost:3001/openapi.json
```

That generates a request for every endpoint with the parameters and example
bodies filled in. Set a collection-level Bearer auth token and it applies to
the whole collection.

Re-import after adding routes — nothing is maintained by hand, so nothing goes
stale.

### curl

```sh
curl -s 'localhost:3001/catalog/products?q=macbok' | jq
curl -s 'localhost:3001/shipping/quote?pincode=560001&weight_grams=500&order_total=500' | jq
curl -s -H "Authorization: Bearer $TOKEN" 'localhost:3001/admin/products' | jq
```

---

## Getting a token

> Working sign-ins for the local stack — four accounts covering owner,
> warehouse, shopper and both-at-once — are in
> [`docs/testing-accounts.md`](../../docs/testing-accounts.md), along with what
> each one should return.


The API verifies Supabase access tokens (HS256, the shared JWT secret). Ask
GoTrue for one exactly as the front ends will:

```sh
export SUPABASE_URL=http://localhost:8000     # kong; your own URL in production
export ANON_KEY=...                           # from apps/api/.env

export TOKEN=$(curl -s "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' \
  -d '{"email":"staff@test.local","password":"..."}' | jq -r .access_token)

curl -s -H "Authorization: Bearer $TOKEN" localhost:3001/me | jq
```

`GET /me` is the check that matters. It answers:

| Response | Meaning |
|---|---|
| `200` with `isStaff: true` | signed in as staff — `/admin/*` will work |
| `401` | the token is missing, expired, or not signed with this secret |
| `403` | a real account with no `staff_users` row — a shopper |

A shopper's token is **valid auth**. The missing `staff_users` row is the only
thing keeping them off the admin surface, so a 403 here is the system working.

Tokens expire in an hour by default. A sudden wall of 401s in Swagger usually
means yours has, not that anything broke.

---

## What the tests actually cover

Three layers, deliberately, because each catches what the others cannot:

| | Command | Catches |
|---|---|---|
| `apps/api/test/` | `bun test` | routing, validation, auth wiring, the error envelope, the published contract. No database, so it is fast and cannot flake |
| `supabase/tests/01_invariants.sql` | `make test` (from the repo root) | the rules themselves — RLS scoping, append-only ledgers, rate-band boundaries. Runs as `anon` and as a customer against a throwaway Postgres |
| by hand, against a real stack | the curls above | that PostgREST, GoTrue and Kong agree with all of it |

The row-level guarantees are asserted in the **middle** layer, not the first. A
handler test that mocked the database would only prove the mock; RLS is what
actually hides a draft product, so that is where it is tested.

---

## Adding a route

See `.claude/skills/hono-api-patterns/SKILL.md`. The short version: declare it
with `createRoute` (never `app.get`), reuse the zod schema from `@ecom/schema`,
pick the Supabase client deliberately, mount it in `app.ts`, and add
`security: [{ bearerAuth: [] }]` if it needs a token — otherwise it renders in
Swagger with no way to send one and looks broken rather than guarded.
