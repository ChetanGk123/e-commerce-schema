# Test accounts

Sign-ins for exercising the API by hand — Swagger UI at
`http://localhost:3001/docs`, Postman, or curl.

> **Local development only.** These accounts and this password exist on the
> self-hosted Supabase stack running on your machine. Never create them
> anywhere reachable from the internet, and never reuse this password.

---

## The accounts

Password, the same for all four:

```
DevPassw0rd!
```

Emails:

```
staff@test.local
```
```
warehouse@test.local
```
```
shopper2@test.local
```
```
staff2@test.local
```


| Email | Role | What it is for |
|---|---|---|
| `staff@test.local` | `owner` | Everything. `/admin/*`, erasure, invoicing, refunds |
| `warehouse@test.local` | `warehouse` | The role boundary — full admin surface, but **cannot** erase a customer |
| `shopper2@test.local` | customer | The storefront: cart, checkout, `/account`, `/credit`, orders, invoices, tickets |
| `staff2@test.local` | `owner` + customer | Both surfaces behind one sign-in |

`staff@test.local` has **no** `customers` row, deliberately — it is the case
where a valid staff token has no shopper account behind it, and `/account`
should say so rather than inventing one.

`warehouse@test.local` exists so the role gate has something to refuse. Without
a non-owner staff account, `staff_has_role('owner','admin')` is never actually
exercised.

---

## Getting a token

Swagger's **Authorize** box wants a JWT, not a password. Run one of these —
each prints a token and nothing else, ready to paste into
`http://localhost:3001/docs`.

These go through the API's own `POST /auth/sign-in` (api-plan B16), not
Supabase Auth directly: the browser no longer holds the anon key, so neither
should the thing you use to imitate it. **The API must be running.**

`staff@test.local` — owner, full admin:

```sh
curl -s http://localhost:3001/auth/sign-in \
  -H 'Content-Type: application/json' \
  -d '{"email":"staff@test.local","password":"DevPassw0rd!"}' | jq -r .accessToken
```

`warehouse@test.local` — staff, but cannot erase:

```sh
curl -s http://localhost:3001/auth/sign-in \
  -H 'Content-Type: application/json' \
  -d '{"email":"warehouse@test.local","password":"DevPassw0rd!"}' | jq -r .accessToken
```

`shopper2@test.local` — customer surface:

```sh
curl -s http://localhost:3001/auth/sign-in \
  -H 'Content-Type: application/json' \
  -d '{"email":"shopper2@test.local","password":"DevPassw0rd!"}' | jq -r .accessToken
```

`staff2@test.local` — both:

```sh
curl -s http://localhost:3001/auth/sign-in \
  -H 'Content-Type: application/json' \
  -d '{"email":"staff2@test.local","password":"DevPassw0rd!"}' | jq -r .accessToken
```

Paste the output into Authorize **without** the word `Bearer` — the UI adds it.
Append `| pbcopy` to any of them to skip the copying.

Tokens last **one hour**. A sudden wall of 401s across every endpoint almost
always means yours expired, not that something broke.

**Failed to fetch** in Swagger is not a CORS problem, whatever the message
says — it is what the UI shows for any network failure, and the usual cause is
that the API is not running. Check `curl localhost:3001/health` first, then
start it with `bun run dev` from `apps/api`. Open the docs on
`localhost:3001`, not `127.0.0.1:3001`: those are different origins to a
browser, and only same-origin requests skip the CORS allowlist.

---

## What each account should return

Worth re-running after any change to auth or RLS; the shape of this table is
the assertion.

| Request | `staff` | `warehouse` | `shopper2` |
|---|---|---|---|
| `GET /me` | `owner` | `warehouse` | **403** |
| `GET /account` | **404** | 200 | 200 |
| `GET /invoices` | 0 items | 0 items | 2 items |
| `GET /support/tickets` | 0 items | 0 items | 2 items |
| `GET /admin/products` | 200 | 200 | **403** |
| `POST /admin/customers/{id}/erase` | 200 | **403** | **403** |

Three of those are the interesting ones:

- **`shopper2` gets 403 from `/me`**, not 401. Their token is perfectly valid
  auth; the missing `staff_users` row is the only thing keeping shoppers off the
  admin surface, so a 403 here is the system working.
- **`staff` gets 404 from `/account`** because it has no `customers` row. Not an
  error — the wrong endpoint for that sign-in.
- **`warehouse` gets 403 from erase.** Erasure destroys personal data and cannot
  be undone, so it needs `owner` or `admin`. The check lives inside
  `anonymize_customer()`, not in the route: every staff member can reach
  PostgREST directly with their own JWT, so a guard in a handler is advice.

---

## Endpoints that do not use a token

| Endpoint | Guard |
|---|---|
| `POST /jobs/drain` | `X-Jobs-Secret` header (`JOBS_SECRET` in `.env`) |
| `POST /webhooks/razorpay` | `X-Razorpay-Signature` — an HMAC over the raw body |
| `/catalog/*`, `/shipping/quote`, `/health` | None. Public by design |

The jobs secret, for pasting into Swagger or curl:

```
local-dev-jobs-secret-0123456789
```

---

## Data already sitting there

Useful for hitting read endpoints without setting anything up first. `shopper2`
owns all of it:

| | |
|---|---|
| Store credit | ₹2,549 — a redeemed gift card, a return credit, and a goodwill grant |
| Orders | Several, across `pending`, `paid` and `shipped` |
| Invoices | One tax invoice with an e-invoice stamp, one credit note against it |
| Support tickets | Two, one carrying a staff-only internal note |
| Outbox | ~8 queued order confirmations, waiting on a mail provider |

The ticket with the internal note is the one worth opening from both sides:
staff see two messages, `shopper2` sees one, and the note's text appears nowhere
in the shopper's payload.

---

## Resetting a password

Passwords go through GoTrue's admin API, not SQL — `auth.users` stores a hash,
and writing to it directly will not work:

```sh
curl -s -X PUT "$SUPABASE_URL/auth/v1/admin/users/<user-id>" \
  -H "apikey: $SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"password":"DevPassw0rd!","email_confirm":true}'
```

To rebuild the database itself, `make verify` drops and recreates a throwaway
Postgres from the migrations. That container is **separate** from the Supabase
stack these accounts live on — see `docs/setup.md`.
