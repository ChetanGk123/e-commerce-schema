# Running it locally

**Two compose projects.** Supabase is infrastructure this repo targets,
not something it contains, so you start it yourself:

```sh
cd "$SUPABASE_DIR" && docker compose up -d     # 13 containers
cd - && docker compose up -d                   # 6 containers: api + monitoring
```

Every step below ends with a check. Run it.

**Companion**: `docker-compose.yml` (what it starts and why) ·
[monitoring.md](monitoring.md) (the dashboard) ·
[setup.md](setup.md) (applying the schema to a fresh database)

---

## What runs where

| | Project | Defined in |
|---|---|---|
| **Supabase**, 13 containers | `supabase` | `ChetanGk123/dokploy-templates` — **not this repo** |
| **api**, hot reload | `ecom` | `apps/api/Dockerfile`, `dev` stage |
| **monitoring**, 5 containers | `ecom` | `monitoring/docker-compose.yml` |

Supabase stays out because the template is deliberately kept
byte-identical to `dokploy-templates`; vendoring it here makes this repo a
fork to reconcile on every Supabase bump. In production Dokploy runs it,
not this file, so keeping the split matches how it actually deploys.

**`dokploy-network` is the whole connection between the two.** The
template puts kong on it — that is what it is for, Traefik reaches kong
the same way — so the API resolves `kong:8000` across the project boundary
with neither side configured for the other. Nothing else in Supabase is on
that network, and nothing else needs to be: the API only ever talks to
Supabase through kong.

`monitoring/docker-compose.yml` is `include`d rather than copied, because
it still has to run standalone on a host where this file does not exist.

Only `apps/api` has a Dockerfile, because it is the only workspace that
runs. `packages/schema` and `packages/client` are libraries — no start
script, nothing to execute.

---

## Step 1. Config

```sh
cp .env.example .env
```

Nothing in it is secret except `METRICS_TOKEN`, which the next step
writes.

A note on wherever you keep the Supabase compose: **that directory is also
where your database physically is.** The template bind-mounts
`files/volumes/db/data` for Postgres, so the path holds the actual data
files. Keep it somewhere durable — a temp directory will be reaped and
take the database with it.

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

## Step 4. Start Supabase

In its own directory, its own project:

```sh
cd /path/to/supabase-local/code && docker compose up -d
```

**Give it two or three minutes.** `analytics` (Logflare) runs Ecto
migrations on boot and is the slow one, and `kong`, `studio` and
`functions` all wait on its healthcheck — so a stack that looks stuck with
three containers in `Created` is usually just Logflare still starting.

**Check:**

```sh
docker ps --filter name=supabase --format '{{.Names}}\t{{.Status}}'
```

Expect **13 containers**, with `kong` and `db` **healthy**. If several are
`Restarting` and their logs say `lookup db ... no such host`, see
[Troubleshooting](#troubleshooting).

---

## Step 5. Start this repo

```sh
docker compose up -d
```

First run builds the API dev image and pulls the monitoring images; allow
a few minutes. After that it is seconds.

**Check:**

```sh
docker compose ps --format '{{.Service}}\t{{.State}}'
```

Expect **6 services, all `running`** — `api` plus the five monitoring
containers.

There is no `depends_on` on kong, because Compose can only wait on
services in its own project. `env.ts` validates at import, so an API
started before Supabase is up exits rather than limping — `restart:
unless-stopped` turns that into a retry until Supabase answers.

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
`files/volumes/db/data` beside the Supabase compose, not a Compose volume,
so it survives. And `down` here does not touch Supabase at all — it is a
separate project.

**`docker compose down -v` is not safe** — it destroys named volumes,
including Grafana's, taking any dashboard you built in the UI with it. It
does not touch the Postgres bind mount.

---

## Troubleshooting

**`network dokploy-network declared as external, but could not be found`**
— Step 3. Both projects need it and neither creates it.

**Supabase containers restarting, logs say `lookup db ... no such host`.**
Their network was removed while they still existed, so they are attached
to one that is gone and DNS resolves nothing. `up` alone will not fix it —
Compose reuses the containers. Recreate them:

```sh
docker compose up -d --force-recreate
```

Safe: Postgres data is a bind mount, not a Compose volume.

**Port 54322 or 8000 already allocated when starting Supabase.** An older
copy of those containers is still running — most likely from a compose
project you have since stopped using. `docker ps -a | grep -E 'kong|db'`
will find them; `docker compose down --remove-orphans` in the project that
created them clears it.

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
