# Running the whole thing locally

One command brings up 19 containers: self-hosted Supabase, the API with
hot reload, and the monitoring stack.

```sh
docker compose up -d
```

Every step below ends with a check. Run it.

**Companion**: `docker-compose.yml` (what it starts and why) ·
[monitoring.md](monitoring.md) (the dashboard) ·
[setup.md](setup.md) (applying the schema to a fresh database)

---

## What starts, and what owns it

| | Where it is defined |
|---|---|
| **Supabase**, 13 containers | `${SUPABASE_COMPOSE_DIR}` — **not in this repo** |
| **api**, hot reload | `apps/api/Dockerfile`, `dev` stage |
| **monitoring**, 5 containers | `monitoring/docker-compose.yml` |

The root `docker-compose.yml` owns only the `api` service and `include`s
the other two. Neither belongs here: the Supabase compose is
`ChetanGk123/dokploy-templates` and is deliberately kept byte-identical to
it, and the monitoring compose has to keep working on its own on a Dokploy
host beside an API this file knows nothing about.

`include` puts all three in **one** Compose project, so every service
reaches every other by service name. That is why the API is configured
with `kong:8000` rather than `localhost:8000`.

Only `apps/api` has a Dockerfile, because it is the only workspace that
runs. `packages/schema` and `packages/client` are libraries — no start
script, nothing to execute.

---

## Step 1. Point at your Supabase

```sh
cp .env.example .env
```

Set `SUPABASE_COMPOSE_DIR` to wherever your Supabase compose lives.

**That directory is also where your database physically is.** The template
bind-mounts `files/volumes/db/data` for Postgres, so the path you choose
holds the actual data files. Put it somewhere durable — a temp directory
will be reaped and take the database with it.

**Check:**

```sh
ls "$(grep SUPABASE_COMPOSE_DIR .env | cut -d= -f2)"/docker-compose.yml
```

Expect the file to exist. If `SUPABASE_COMPOSE_DIR` is unset, Compose
refuses to start and says so by name.

---

## Step 2. The metrics token

`GET /metrics` does not exist until `METRICS_TOKEN` is set — it 404s, the
same answer as any unserved path. Prometheus needs the *same* value, and
it reads a **file** rather than the environment, so this one secret
genuinely has two homes. Write both from one call:

```sh
TOKEN=$(openssl rand -hex 32)
printf '%s' "$TOKEN" > monitoring/secrets/metrics_token
sed -i '' "s|^METRICS_TOKEN=.*|METRICS_TOKEN=$TOKEN|" .env    # macOS
```

**Check:**

```sh
[ "$(cat monitoring/secrets/metrics_token)" = "$(grep '^METRICS_TOKEN=' .env | cut -d= -f2)" ] \
  && echo match || echo MISMATCH
```

Expect **match**. A mismatch shows up later as a Prometheus target that is
`down` with a 404 — which reads like the endpoint is off.

---

## Step 3. The shared network

Supabase and the monitoring stack each declare an external network.
`.env` points both at the same one, so there is a single network to
create:

```sh
docker network create dokploy-network
```

**Check:**

```sh
docker network ls --filter name=dokploy-network --format '{{.Name}}'
```

Expect **dokploy-network**. Without it Compose refuses to start and names
the missing network.

---

## Step 4. Up

```sh
docker compose up -d
```

First run builds the API dev image and pulls ~19 images; allow a few
minutes. After that it is seconds.

**Check:**

```sh
docker compose ps --format '{{.Service}}\t{{.State}}'
```

Expect **19 services, all `running`**.

The API waits for Kong's healthcheck before starting — `env.ts` validates
at import, so an API that raced Supabase would just exit.

**Check** the whole path, API through Kong to Postgres and back:

```sh
curl -s localhost:3001/health/ready
```

Expect `{"status":"ready","database":"ok","latency_ms":…}`. That probe
reads a real row through the anon role, so it exercises Kong, PostgREST,
Postgres and RLS rather than asserting the process is alive.

---

## Working on it

**Editing a route reloads it.** The repo is bind-mounted and the `dev`
stage runs `bun --hot`, so a save is live in about a second. No rebuild,
no restart.

```sh
docker compose logs -f api
```

**Rebuild only when dependencies change**, since `bun install` happens in
the image:

```sh
docker compose up -d --build api
```

**To run what actually deploys** instead of the source, switch the build
target in `docker-compose.yml` from `dev` to `runtime`. That is the single
bundled file Dokploy runs; it will not hot reload, which is the point of
it.

### Logs are JSON on purpose

The compose sets `NODE_ENV=production` for the API. That is what decides
whether Grafana's log panel works: `| json | level >= 40` needs one JSON
object per line, and `pino-pretty` output is not that.

If you would rather read the terminal than the dashboard, set
`NODE_ENV: development` in `docker-compose.yml`. Hot reload does not care
either way.

---

## Stopping

```sh
docker compose stop     # keeps containers and data
docker compose down     # removes containers, keeps the database
```

`down` is safe. Postgres data is a **bind mount** under
`$SUPABASE_COMPOSE_DIR/../files/volumes/db/data`, not a Compose volume, so
it survives.

**`docker compose down -v` is not safe** — it destroys named volumes,
including Grafana's, taking any dashboard you built in the UI with it. It
does not touch the Postgres bind mount.

---

## Troubleshooting

**`required variable SUPABASE_COMPOSE_DIR is missing a value`** — no
`.env`, or the variable is empty. Step 1.

**`network dokploy-network declared as external, but could not be found`**
— Step 3.

**The `api` container exits immediately.** `env.ts` validates at import and
refuses to boot on bad config; the log names the variable:

```sh
docker compose logs api | head -20
```

**`auth_unavailable` from `/auth/sign-in`.** `/auth/*` proxies to GoTrue.
Check `docker compose ps auth` — and note this is an HTTP 502 with a
structured body, so `curl … | jq -r .accessToken` prints a bare `null`
that looks like an empty result. Ask for the body.

**Port 3001 already in use.** Something else is serving it — most likely a
`bun run dev` from before you had this file:

```sh
lsof -nP -iTCP:3001 -sTCP:LISTEN
```

**Prometheus target `down` with `no such host`.** The `api` service must
join `dokploy-network`, not only the project default — Prometheus is
pinned to `[monitoring, api]` and a service that names any network stops
joining the default one. The root compose already does this; if you edited
the `networks:` list, that is why.
