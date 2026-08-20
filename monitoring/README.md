# Monitoring

Prometheus, Alertmanager, Loki, Alloy and Grafana, reading what `apps/api`
already publishes. **Nothing here touches the application** — the API is
unaware this stack exists and stays deployable without it.

> **Getting it running and using it: [`docs/monitoring.md`](../docs/monitoring.md).**
> That is the step-by-step runbook, each step with a check. This file is
> the reference for what the containers are and why they are configured
> the way they are.

| Container | Does |
|---|---|
| `prometheus` | Scrapes `/metrics` every 15s, evaluates `prometheus/rules.yml` |
| `alertmanager` | Routes a firing rule somewhere a human sees it |
| `loki` | Stores logs, 31 days |
| `alloy` | Reads the Docker socket, ships every container's stdout to Loki |
| `grafana` | The screen. One provisioned dashboard, two datasources |

## Start it

```sh
# 1. The scrape token. /metrics 404s until METRICS_TOKEN is set on the
#    API, and this file must hold the same value.
openssl rand -hex 32 > secrets/metrics_token

# 2. Set that same value as METRICS_TOKEN on apps/api and redeploy it.

# 3. Config. Compose reads .env from this directory automatically.
cp .env.example .env && $EDITOR .env

# 4. Start.
docker compose up -d
```

Grafana is on `127.0.0.1:3000`, user `admin`. The dashboard is
**E-commerce API**, provisioned — it appears on first start.

**Put the settings in `.env`, not on the command line.** The `api` network
is `external: true`, so its name is resolved when a container is *created*
and baked in from then on. One `docker compose up -d` that forgets an
inline `MONITORING_API_NETWORK=` silently rebinds Prometheus to the
default network, and the symptom is not "wrong network", it is

```
Get "http://api:3001/metrics": dial tcp: lookup api ... no such host
```

which reads like DNS or a dead API. This is not hypothetical — it is how
the file was written first, and it broke on the second `up`.

Locally, where there is no `dokploy-network`, create one and point `.env`
at it:

```sh
docker network create ecom-local     # then MONITORING_API_NETWORK=ecom-local
```

### If the API runs on the host, not in Docker

`bun run dev` puts the API on your laptop, not on a Docker network, so
`api:3001` resolves to nothing. Point the scrape at the host instead — in
`prometheus/prometheus.yml`:

```yaml
      - targets: [host.docker.internal:3001]
```

That name works out of the box on Docker Desktop (macOS, Windows). On
Linux it does not exist until you add to the `prometheus` service:

```yaml
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

Remember to change the target back before deploying. `MONITORING_API_NETWORK`
is then irrelevant — but the network is still `external: true`, so it must
name a network that exists. Any will do.

## Exposing it

Only Grafana. Prometheus, Alertmanager and Loki have **no authentication
of their own** — Prometheus alone will hand a stranger your route table,
traffic shape and alert rules. On Dokploy, drop Grafana's `ports:` and
give it a Traefik label instead, the same pattern the Supabase template
uses for `kong`.

## Alerts

`alertmanager/alertmanager.yml` ships with a receiver that **swallows
everything**, so the stack is safe to start before you have decided where
to be paged. It is also useless until you fix that — uncomment one of the
receivers in that file.

Seven rules, in `prometheus/rules.yml`. Two are worth knowing about:

**`OpsSnapshotStale` is the guard, and it invalidates the others.**
`metrics.ts` publishes the ops gauges only when a jobs-tick snapshot
exists. Before the first tick, `ecom_webhooks_exhausted` does not read
zero — *the series does not exist*, so `> 0` is silent in exactly the
situation you most want it loud. `ecom_ops_snapshot_age_seconds` is
published unconditionally (`-1` if nothing ever has), which is why the
code comment says to alert on it *before trusting the rest*. Alertmanager
inhibits the gauge alerts while it fires, so a stale zero cannot read as
good news.

**`ApiDown` is `up == 0`**, synthesised by Prometheus per scrape. No
blackbox exporter — a target that cannot be scraped is a target that is
down, and that is one container we do not run. The gap: it probes from
inside the Docker network, so it will not catch Traefik, TLS or DNS
failing while the container is healthy. Add `blackbox_exporter` against
the public `/health/ready` if you want that covered.

## Logs

Alloy labels lines with `container` and `stream` and **nothing else**.
Every distinct label combination is a Loki stream, and the failure mode
of over-labelling is the log system falling over during the incident you
installed it for.

The API logs pino JSON in production, so everything else is a query-time
parse and costs nothing at ingest:

```logql
{container="api"} | json | level >= 50            # errors and fatals
{container="api"} | json | req_id = "01J..."      # one request end to end
{container="api"} |= "ops.webhooks_exhausted"     # the alert's own log line
```

pino levels are numeric: 30 info, 40 warn, 50 error, 60 fatal.

## Known noise

Grafana logs two `level=error` lines on boot about `xychart` being
"already registered". It is an upstream quirk in Grafana 11.x, not this
config, and nothing is broken by it. Everything else here is silent on a
healthy start — if you see another error line, it is real.

Loki may log `entry too far behind` on first start. That is Alloy
backfilling the history of containers that were already running when you
installed this; it stops once it catches up and affects nothing ongoing.

## What this deliberately does not have

- **Tracing.** `docs/production-readiness.md` #11 leaves it open on
  purpose — it needs a collector running and an SDK in the dependency
  tree, and it is a decision rather than an effort. If you take it up,
  SigNoz or Tempo would replace part of this stack rather than sit beside
  it.
- **A second Prometheus.** This is one instance on one host with local
  disk. It dies with the host, and so does the evidence of why the host
  died. Ship to something off-box before that matters.
- **Per-replica dashboards.** Metrics are per-instance and `sum by (route)`
  puts them back together, which is what `metrics.ts` was built for.
