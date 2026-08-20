# Watching the API

From nothing to a screen showing request latency, the mail queue and
searchable logs. Roughly 15 minutes.

Every step ends with a check. Run it — two of the failure modes here are
silent, and both look like something else when you hit them later.

**Companion**: `monitoring/README.md` (what each container does and why) ·
`apps/api/src/metrics.ts` (what is published) ·
`docs/production-readiness.md` #11 (why Prometheus, and what is still open)

- [What you get](#what-you-get)
- [Part A — run it locally](#part-a--run-it-locally)
- [Part B — read the dashboard](#part-b--read-the-dashboard)
- [Part C — ask it questions](#part-c--ask-it-questions)
- [Part D — make alerts reach a human](#part-d--make-alerts-reach-a-human)
- [Part E — deploy it on Dokploy](#part-e--deploy-it-on-dokploy)
- [Troubleshooting](#troubleshooting)

---

## What you get

Nothing here is new instrumentation. `apps/api` already publishes
Prometheus metrics at `GET /metrics` and already writes pino JSON to
stdout; this stack is the five commodity containers that read them.

| | |
|---|---|
| **Grafana** | The screen. One provisioned dashboard |
| **Prometheus** | Scrapes `/metrics` every 15s, evaluates 7 alert rules |
| **Alertmanager** | Turns a firing rule into a message you receive |
| **Loki** | Stores logs, 31 days |
| **Alloy** | Reads the Docker socket, ships every container's stdout to Loki |

The API is unaware this exists and stays deployable without it.

---

## Part A — run it locally

### Step 1. Create the scrape token

`/metrics` does not exist until `METRICS_TOKEN` is set — it returns 404,
the same answer as any path the service does not serve. Closed by default,
because `/metrics` publishes the route table, the traffic shape and the
state of the mail queue.

```sh
openssl rand -hex 32 > monitoring/secrets/metrics_token
```

**Check:**

```sh
wc -c < monitoring/secrets/metrics_token
```

Expect **65** (64 hex characters and a newline). `env.ts` requires at
least 16; anything shorter is refused at boot.

---

### Step 2. Configure the stack

```sh
cp monitoring/.env.example monitoring/.env
docker network create ecom-local
```

Edit `monitoring/.env`:

```
MONITORING_API_NETWORK=ecom-local
GRAFANA_PASSWORD=pick-something
```

**Put these in `.env`, never on the command line.** The API network is
`external: true`, so its name is resolved when a container is *created*
and baked in from then on. One `docker compose up -d` that forgets an
inline `MONITORING_API_NETWORK=` silently rebinds Prometheus to the wrong
network, and the symptom is not "wrong network" — it is `lookup api ... no
such host`, which reads like DNS or a dead API.

**Check:**

```sh
docker network ls --filter name=ecom-local --format '{{.Name}}'
```

Expect **ecom-local**.

---

### Step 3. Start the API with the token

The API must be on the same Docker network as Prometheus, and must carry
the *same* token.

```sh
docker build -t ecom-api-local .
docker run -d --name api --network ecom-local \
  -e SUPABASE_URL="$SUPABASE_URL" \
  -e SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" \
  -e SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
  -e SUPABASE_JWT_SECRET="$SUPABASE_JWT_SECRET" \
  -e METRICS_TOKEN="$(cat monitoring/secrets/metrics_token)" \
  ecom-api-local
```

**Check:**

```sh
docker logs api 2>&1 | grep 'api listening'
```

Expect `"port":3001,"env":"production"`. If the container exited instead,
`env.ts` validates at import and refuses to boot on bad config — the log
line names the variable.

Whether the *token* is right is proven in Step 5, where a mismatch shows
up as a 404.

> **Running `bun run dev` instead?** Then the API is on your laptop, not
> on a Docker network, and `api:3001` resolves to nothing. Change the
> target in `monitoring/prometheus/prometheus.yml` to
> `host.docker.internal:3001` — and change it back before you deploy.

---

### Step 4. Start the stack

```sh
cd monitoring && docker compose up -d
```

**Check:**

```sh
docker compose ps --format '{{.Service}}\t{{.State}}'
```

Expect **five services, all `running`**. A container that is restarting is
a config error — `docker compose logs <service>` names it.

---

### Step 5. Confirm Prometheus can actually reach the API

This is the step that silently half-works: the stack comes up fine whether
or not the scrape succeeds.

**Check:**

```sh
docker exec ecom-monitoring-prometheus-1 \
  wget -qO- 'http://localhost:9090/api/v1/targets?state=active' | grep -o '"health":"[a-z]*"'
```

Expect **two `"health":"up"`** — the API and Prometheus itself. If the API
is `down`, see [Troubleshooting](#troubleshooting); the `lastError` field
in that same output says which of the three causes it is.

---

### Step 6. Open Grafana

<http://127.0.0.1:3000> — user `admin`, password from `.env`.

**Check:** the dashboard **E-commerce API** is already in the list. It is
provisioned from `monitoring/grafana/dashboards/ecom-api.json`, so it
appears without importing anything. If it is missing, Grafana could not
read the file — `docker compose logs grafana | grep provisioning`.

---

## Part B — read the dashboard

The top row is ordered deliberately. **The second panel decides whether
you can believe the rest of the page.**

| Panel | Reading it |
|---|---|
| **API** | Prometheus `up`. Green means scrapeable *from inside the Docker network* — it says nothing about Traefik, TLS or DNS on the public path |
| **Ops snapshot age** | **Read this before the Ops row.** Green: the jobs tick is publishing and those gauges are real. Red or "never published": the tick is dead, and the Ops panels are showing *absence*, not zero |
| **5xx rate** | Ratio, not a count. A fixed count pages on a traffic spike and stays quiet during a low-traffic outage |
| **p95 latency** | All routes together. The per-route breakdown is below |
| **req/s** | Total throughput |

### Why the snapshot age panel matters so much

The ops gauges are **published by the jobs tick, not read when Prometheus
scrapes**. A scrape must not cost three database round trips, and the tick
has already computed the numbers.

The consequence is the thing to internalise: before the first tick,
`ecom_webhooks_exhausted` does not read zero — **the series does not
exist**. An empty "Money at risk" panel therefore means *unknown*, not
*fine*, and a rule of `ecom_webhooks_exhausted > 0` would stay silent
exactly when the tick has died and nobody is computing the number.

`ecom_ops_snapshot_age_seconds` is the one gauge published
unconditionally (`-1` when nothing ever has). That is why `metrics.ts`
says to alert on it *before trusting the rest*, and why Alertmanager
suppresses the gauge alerts while `OpsSnapshotStale` is firing.

### The rest of the page

**Traffic** — requests and p95 broken out by route. `route` is the
registered pattern (`/catalog/products/:slug`), never the path: labelling
by path gives Prometheus one time series per product slug, which is how a
metrics endpoint takes down the thing it was installed to watch.

**Ops** — the outbox by status, and "Money at risk". `ecom_webhooks_exhausted`
is the expensive one: a capture among those is money taken against an
order this database still calls pending.

**Logs** — warnings and errors, with a container picker at the top of the
dashboard that covers everything on the host, Supabase included.

---

## Part C — ask it questions

The workflow this is built for: a spike on **p95 by route** tells you
*which* route and *when*; the Logs panel tells you *why*. Every pino line
carries `reqId`, so you can go from a slow route to the exact requests.

Alloy labels lines with `container` and `stream` and nothing else — every
distinct label combination is a Loki stream, and the failure mode of
over-labelling is the log system falling over during the incident you
installed it for. Everything else is a query-time parse and costs nothing
at ingest:

```logql
{container="api"} | json | level >= 50           # errors and fatals
{container="api"} | json | route = "/checkout"   # one route
{container="api"} | json | reqId = "b52591da-…"  # one request, end to end
{container="api"} |= "ops.webhooks_exhausted"    # the alert's own log line
{container="supabase-db-1"} |= "ERROR"           # Postgres, same UI
```

pino levels are numeric: **30** info, **40** warn, **50** error, **60**
fatal.

Useful PromQL, in Grafana's **Explore** tab:

```promql
# Which routes are slowest right now
topk(5, histogram_quantile(0.95,
  sum by (route, le) (rate(http_request_duration_seconds_bucket[5m]))))

# Which routes are erroring
sum by (route) (rate(http_requests_total{status=~"5.."}[5m]))

# Is the mail queue draining or growing
ecom_outbox_messages
```

---

## Part D — make alerts reach a human

**The stack ships swallowing every alert.** `alertmanager.yml` has a
receiver with no destination, so it is safe to start before you have
decided where to be paged — and useless until you fix that.

Edit `monitoring/alertmanager/alertmanager.yml` and uncomment one receiver.
A Slack incoming webhook is the fastest:

```yaml
receivers:
  - name: default
    webhook_configs:
      - url: https://hooks.slack.com/services/…
```

Then `docker compose restart alertmanager`.

**Check:** with the API stopped, `ApiDown` fires after 2 minutes.

```sh
docker exec ecom-monitoring-alertmanager-1 \
  wget -qO- http://localhost:9093/api/v2/alerts | grep -o '"alertname":"[A-Za-z]*"'
```

Expect **`"alertname":"ApiDown"`** — and a message wherever you pointed it.

The seven rules live in `monitoring/prometheus/rules.yml`. Three are about
money or mail (`WebhooksExhausted`, `OutboxStalled`, `StorageGcStalled`),
one is the guard (`OpsSnapshotStale`), and three are about traffic shape.

---

## Part E — deploy it on Dokploy

Same stack, three changes.

1. **`.env`**: `MONITORING_API_NETWORK=dokploy-network`, and a real
   `GRAFANA_PASSWORD`.
2. **`METRICS_TOKEN`** on the API service, matching
   `secrets/metrics_token`. Redeploy the API — `/metrics` 404s until it
   restarts with the variable set.
3. **Grafana's `ports:`**: delete it and add a Traefik label instead, the
   same pattern the Supabase template uses for `kong`.

**Expose Grafana and nothing else.** Prometheus, Alertmanager and Loki
have no authentication of their own. Prometheus alone will hand a stranger
your route table, your traffic shape and your alert rules.

One gap worth naming: `ApiDown` is `up == 0`, which Prometheus evaluates
from *inside* the Docker network. It will not catch Traefik, TLS or public
DNS failing while the container is perfectly healthy. If you want that
covered, add `blackbox_exporter` probing the public `/health/ready`.

---

## Troubleshooting

**The API target is `down`.** Read `lastError` in the targets output from
Step 5. There are three causes and they say different things:

| `lastError` contains | Cause |
|---|---|
| `no such host` | Prometheus is on the wrong network — see Step 2. Confirm with `docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' ecom-monitoring-prometheus-1` |
| `404` | `METRICS_TOKEN` is not set on the API, or the two values differ |
| `connection refused` | The API is not listening. `PORT` defaults to 3001 |

**Grafana shows "No data" but the target is up.** The stack has only just
started; the rate windows need two scrapes. Wait 30 seconds. If it
persists, check the time range — the dashboard defaults to the last 6
hours and a fresh stack has seconds.

**Loki logs `entry too far behind` on first start.** Alloy is backfilling
the history of containers that were already running when you installed
this. It stops once it catches up and affects nothing ongoing.

**Grafana logs two `xychart` errors on boot.** An upstream quirk in
Grafana 11.x, not this config. Everything else here is silent on a healthy
start — if you see another error line, it is real.

**Everything is empty after a host reboot.** The containers are
`restart: unless-stopped`, so they come back with Docker. The API does
not, unless whatever runs it does.
