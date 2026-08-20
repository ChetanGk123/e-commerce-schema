# Deploying to Dokploy

The API and its monitoring, deployed as one Compose stack beside a Supabase
you deploy separately.

```
docker-compose.yml + docker-compose.prod.yml
```

Both files, in that order. The base alone is development-shaped — it builds
the hot-reload stage, bind-mounts the working tree and publishes host ports.
Deployed unchanged it would ship all three.

**Companion**: [development.md](development.md) (running it locally) ·
[setup.md](setup.md) Part C (self-hosted Supabase on Dokploy) ·
[monitoring.md](monitoring.md) (the dashboard)

- [Where environment variables live](#where-environment-variables-live)
- [What to put in the Environment tab](#what-to-put-in-the-environment-tab)
- [Deploying](#deploying)
- [Domains](#domains)
- [More than one environment](#more-than-one-environment)
- [Things that will bite](#things-that-will-bite)

---

## Where environment variables live

Locally, each workspace has its own `.env`. **That layout does not survive
deployment**, and it is worth being clear why rather than working around it
later.

Dokploy gives a Compose deployment **one** environment, written as a single
`.env` beside the compose file. There is no per-app equivalent, and
`apps/api/.env` is gitignored — so on the deploy host it does not exist at
all. The base compose declares it `required: false` for exactly this
reason; without that, Compose aborts on the missing file, and the prod
override could not undo it because **`env_file` lists merge rather than
replace**.

So the model is:

| | Where |
|---|---|
| Secrets and per-deployment values | **Dokploy's Environment tab**, nothing in git |
| Which variables each service reads | `docker-compose.prod.yml`, `environment:` |
| Values that are always the same in production | Hardcoded in the override |
| What a value means | `apps/api/.env.example` — still the documentation |

The override maps variables **explicitly** rather than using `env_file`.
Two reasons: the API container has no business reading `GRAFANA_PASSWORD`,
and the compose file becomes the written contract of what each service
needs, which otherwise exists only inside `env.ts`.

---

## What to put in the Environment tab

**Five are mandatory.** The first three have no default in `env.ts`, which
validates at import — the container exits rather than starting
half-configured. The other two are required by the compose files
themselves.

```
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_JWT_SECRET=
METRICS_TOKEN=
GRAFANA_PASSWORD=
ADMIN_URL=
```

`ADMIN_URL` is the admin console's own public address. Next uses it for
`metadataBase`, so canonical and OG links resolve absolutely instead of to
localhost. There is no sensible default for someone else's domain, so it
is guarded like the rest.

`.env.prod.example` is this list in full, with the optional ones below it.

`SUPABASE_URL` is the fourth thing `env.ts` demands and is **not** in that
list — the override hardcodes it to `http://kong:8000`. See
[Things that will bite](#things-that-will-bite).

The override guards those with `${VAR:?...}`, so a missing one fails at
`compose up` naming the variable, rather than at container start as a
crash loop.

**Everything else has a default in `env.ts`** — 31 of the 35 — so add one
only when you turn that feature on:

| Turning on | Add |
|---|---|
| The storefront calling the API | `CORS_ORIGINS` |
| Payments | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` |
| Email | `MAIL_PROVIDER`, `MAIL_FROM`, and `RESEND_API_KEY` **or** the `SMTP_*` set |
| Images | `STORAGE_BUCKET`, `STORAGE_PUBLIC_URL` |
| Swagger UI in public | `DOCS_PUBLIC=true` — defaults to `false` here |

`METRICS_TOKEN` is one value used twice: the API needs it to serve
`/metrics` at all, and Prometheus needs the identical string to scrape it.
Generate with `openssl rand -hex 32`.

---

## Deploying

1. **Supabase first**, from `ChetanGk123/dokploy-templates`, per
   [setup.md](setup.md) Part C. It must be on `dokploy-network` — the
   template already puts kong there.
2. **Apply the schema.** `supabase/migrations/` holds one squashed
   baseline; paste it into the SQL editor or `psql -f` it. setup.md has
   the checks.
3. **This repo** as a Compose application. Set the compose file to
   `docker-compose.yml` and `docker-compose.prod.yml`, in that order.
4. **Environment tab**, per above.
5. Deploy.

**Check** — from any container on `dokploy-network`:

```sh
wget -qO- http://api:3001/health/ready
```

Expect `{"status":"ready","database":"ok","latency_ms":…}`. That probe
reads a real row through the anon role, so it exercises kong, PostgREST,
Postgres and RLS rather than asserting the process is alive.

---

## Domains

Attach them in Dokploy's UI, which generates the Traefik router labels
itself. The override sets only `traefik.docker.network=dokploy-network`,
the same single label the Supabase template puts on kong — hand-writing
routers here would fight Dokploy for control of them.

**Give a domain to `api` and to `grafana`, and to nothing else.**
Prometheus, Alertmanager and Loki have no authentication of their own.
Prometheus alone will hand a stranger your route table, your traffic shape
and your alert rules.

Point Dokploy's health check at `/health`, **not** `/health/ready`.
Liveness stays 200 during a shutdown drain and does not touch Postgres;
pointed at readiness, a thirty-second database blip restarts every
container in the service instead of taking them out of rotation. The
Dockerfile's `HEALTHCHECK` makes the same choice for the same reason.

---

## More than one environment

qa, uat, prod and so on. **No extra compose files.** The same
`docker-compose.yml` + `docker-compose.prod.yml`, deployed as one Dokploy
application per environment. What differs is the Environment tab and the
git branch each application tracks.

Each environment is two Dokploy applications:

```
supabase-qa     13 containers   from ChetanGk123/dokploy-templates
ecom-qa          1 container    this repo
```

Plus **one** monitoring stack for all of them — not one per environment.
Four Grafanas is four places to look, and monitoring should not redeploy
every time an API does.

### Two variables make an environment

```
COMPOSE_PROJECT_NAME=ecom-qa
SUPABASE_NETWORK=supabase-qa_default
```

`COMPOSE_PROJECT_NAME` names the compose project, and container names are
built from it — two environments both called `ecom` collide on
`ecom-api-1`.

`SUPABASE_NETWORK` decides **which database this environment talks to**,
and it is the one to get right.

### Why `kong` is not good enough

`kong` is a network *alias*, and **aliases are not unique**. Every
Supabase stack publishes `kong` on the shared `dokploy-network`, so with
qa, uat and prod up, three containers answer to that name and Docker
resolves round-robin. The QA API reaches the production database some of
the time — which is worse than failing outright, because it mostly works
and the failures look random.

Measured here with two environments on one host:

```
ecom-api-1     dokploy-network aliases = [ecom-api-1  api  ecom-api]
ecom-qa-api-1  dokploy-network aliases = [ecom-qa-api-1  api  ecom-qa-api]
```

Both claim `api`. The same is true of `kong` across Supabase stacks.

The fix is to address each environment over **its own** network. Every
Supabase project has one — `supabase-qa_default` — and naming it is
unambiguous by construction. `dokploy-network` then does only what it is
for: Traefik ingress, and letting the shared monitoring stack in.

### Scraping several environments

The API publishes a second alias carrying the project name —
`ecom-qa-api`, `ecom-prod-api` — precisely so one Prometheus can tell them
apart. Give the shared monitoring stack one target per environment, with
a label:

```yaml
  - job_name: ecom-api
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/metrics_token
    static_configs:
      - targets: [ecom-qa-api:3001]
        labels: { env: qa }
      - targets: [ecom-prod-api:3001]
        labels: { env: prod }
```

Prometheus does no environment interpolation in its config, so this list
is written out rather than templated. The monitoring stack must join every
environment's `dokploy-network` — it already does — and every environment
must share one `METRICS_TOKEN`, or give each its own scrape job with its
own `credentials_file`.

Then `sum by (env, route) (...)` separates them, and the dashboard gets an
`env` variable.

### What this costs

**Four environments of self-hosted Supabase is 52 containers**, at roughly
2–3 GB of RAM each — 8–12 GB before your own services, and Logflare is a
meaningful part of it.

You cannot share one Supabase between environments to avoid that.
`auth.users` is global, so QA test accounts and real customers would sit
in one table, and `anonymize_customer()` would be one mistake away from
the wrong row. If the memory matters, run fewer environments, or put the
lower ones on Supabase Cloud and self-host only uat and prod.

---

## Things that will bite

**`SUPABASE_URL` is hardcoded, deliberately.** Inside `dokploy-network` it
is always `http://kong:8000`. If it goes in the Environment tab, someone
will eventually paste the public `https://supabase.<domain>` — which sends
internal traffic out through Traefik and back, slower, and failing whenever
TLS or public DNS does. `setup.md:400` draws the same line. The override
keeps it out of reach.

**Prometheus cannot read a token from the environment.** It reads a *file*,
and does no environment interpolation in its config at all — so a platform
that hands you variables cannot configure it. The override writes the file
at boot from `METRICS_TOKEN` before exec'ing Prometheus. If the scrape
target is `down` with a 404, the API and Prometheus have different values.

**`GRAFANA_PASSWORD` only applies to a fresh volume.** Grafana reads it
when it initialises its database and never again; after that the password
lives in `grafana-data` and editing the Environment tab does nothing.
**Set it before the first deploy.** Afterwards, change it in the UI — or
destroy the volume, losing anything built there.

**`docker compose down -v` destroys the monitoring volumes**, Grafana's
included. It does not touch Supabase, which is a separate project with its
Postgres data on a bind mount.

**The API waits for nothing.** Compose can only express `depends_on` within
one project, and Supabase is another. `env.ts` validates at import, so an
API that starts before Supabase exits rather than limping;
`restart: unless-stopped` turns that into a retry until kong answers. A
container restarting a few times on first deploy is that, not a fault.
