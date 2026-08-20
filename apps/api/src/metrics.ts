/**
 * Prometheus metrics, hand-rolled.
 *
 * The exposition format is a few lines of text, and prom-client is a Node
 * library carrying a default registry, a global clock and process
 * collectors this service does not want. Forty lines here beats a
 * dependency whose surface is ten times what gets used.
 *
 * TWO KINDS OF NUMBER LIVE HERE, and the difference matters when reading
 * a dashboard:
 *
 *   REQUEST COUNTERS AND LATENCY are recorded in-process by
 *   requestLogger as requests finish. Exact, free, and reset when the
 *   process does -- which is what rate() expects of a counter.
 *
 *   THE OPS GAUGES are a snapshot published by the jobs tick, not
 *   queried when you scrape. A scrape must not cost three database round
 *   trips, and the tick already has these numbers. The price is that
 *   they are up to one tick stale, and if the tick is not running they
 *   are stale forever -- so ecom_ops_snapshot_age_seconds is published
 *   next to them. Alert on that before trusting the rest.
 *
 * PER INSTANCE, like everything else held in memory here. Prometheus
 * scrapes each replica separately and `sum by (route)` puts them back
 * together, which makes this the one place the per-instance problem is
 * not a problem.
 */

/**
 * Seconds. The low end is where this service actually lives -- most
 * handlers are one PostgREST round trip -- and the top exists so a
 * request that sat behind REQUEST_TIMEOUT_MS lands somewhere other than
 * +Inf, where it would be indistinguishable from a hang.
 */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

interface Series {
  method: string;
  route: string;
  /** Counted per status. Latency is not: status is not a latency dimension. */
  byStatus: Map<number, number>;
  buckets: number[];
  sum: number;
  count: number;
}

const series = new Map<string, Series>();

/**
 * Cardinality is bounded by the route table rather than by traffic:
 * `route` is the registered pattern (`/catalog/products/:slug`), never
 * the path. Labelling with the path gives Prometheus one time series per
 * product slug, which is how a metrics endpoint takes down the thing it
 * was installed to watch.
 */
export function recordRequest(
  method: string,
  route: string,
  status: number,
  seconds: number,
): void {
  const key = `${method} ${route}`;
  let s = series.get(key);
  if (!s) {
    s = {
      method,
      route,
      byStatus: new Map(),
      buckets: new Array<number>(BUCKETS.length).fill(0),
      sum: 0,
      count: 0,
    };
    series.set(key, s);
  }

  s.byStatus.set(status, (s.byStatus.get(status) ?? 0) + 1);
  s.sum += seconds;
  s.count += 1;
  // Cumulative, as the format requires: a bucket counts everything at or
  // below its bound, not everything since the previous bound.
  for (let i = 0; i < BUCKETS.length; i++) {
    if (seconds <= BUCKETS[i]!) s.buckets[i]! += 1;
  }
}

interface OpsSnapshot {
  at: number;
  outbox: Record<string, number>;
  outboxStalled: number;
  webhooksUnprocessed: number;
  webhooksExhausted: number;
  authLockouts: number;
  storageGcQueued: number;
  storageGcStalled: number;
}

let ops: OpsSnapshot | null = null;

/** Called by the jobs tick, which has already computed all of this. */
export function publishOps(snapshot: Omit<OpsSnapshot, "at">): void {
  ops = { ...snapshot, at: Date.now() };
}

/** Label values are quoted; these three characters are the ones that break out. */
const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

export function render(): string {
  const out: string[] = [];

  out.push(
    "# HELP http_requests_total Requests handled, by route pattern, method and status.",
    "# TYPE http_requests_total counter",
  );
  for (const s of series.values()) {
    for (const [status, n] of s.byStatus) {
      out.push(
        `http_requests_total{method="${esc(s.method)}",route="${esc(s.route)}",status="${status}"} ${n}`,
      );
    }
  }

  out.push(
    "# HELP http_request_duration_seconds Time to produce a response.",
    "# TYPE http_request_duration_seconds histogram",
  );
  for (const s of series.values()) {
    const labels = `method="${esc(s.method)}",route="${esc(s.route)}"`;
    for (let i = 0; i < BUCKETS.length; i++) {
      out.push(`http_request_duration_seconds_bucket{${labels},le="${BUCKETS[i]}"} ${s.buckets[i]}`);
    }
    // +Inf is mandatory, and must equal _count or the histogram is invalid.
    out.push(`http_request_duration_seconds_bucket{${labels},le="+Inf"} ${s.count}`);
    out.push(`http_request_duration_seconds_sum{${labels}} ${s.sum}`);
    out.push(`http_request_duration_seconds_count{${labels}} ${s.count}`);
  }

  // Published rather than queried, so its age is part of the answer. A
  // dashboard reading zeroes off a tick that stopped an hour ago is worse
  // than having no panel at all. -1 means nothing has published yet.
  out.push(
    "# HELP ecom_ops_snapshot_age_seconds Age of the jobs-tick snapshot the gauges below come from. -1 if none.",
    "# TYPE ecom_ops_snapshot_age_seconds gauge",
    `ecom_ops_snapshot_age_seconds ${ops ? (Date.now() - ops.at) / 1000 : -1}`,
  );

  if (ops) {
    out.push(
      "# HELP ecom_outbox_messages Mail in the outbox, by status.",
      "# TYPE ecom_outbox_messages gauge",
    );
    for (const [status, n] of Object.entries(ops.outbox)) {
      out.push(`ecom_outbox_messages{status="${esc(status)}"} ${n}`);
    }
    out.push(
      "# HELP ecom_outbox_stalled Messages claimed by a drainer that never finished.",
      "# TYPE ecom_outbox_stalled gauge",
      `ecom_outbox_stalled ${ops.outboxStalled}`,
      "# HELP ecom_webhooks_unprocessed Gateway deliveries not yet applied.",
      "# TYPE ecom_webhooks_unprocessed gauge",
      `ecom_webhooks_unprocessed ${ops.webhooksUnprocessed}`,
      "# HELP ecom_webhooks_exhausted Deliveries that gave up. A capture among these is money taken against an order still marked pending.",
      "# TYPE ecom_webhooks_exhausted gauge",
      `ecom_webhooks_exhausted ${ops.webhooksExhausted}`,
      "# HELP ecom_auth_lockouts_active Accounts currently locked out of sign-in.",
      "# TYPE ecom_auth_lockouts_active gauge",
      `ecom_auth_lockouts_active ${ops.authLockouts}`,
      "# HELP ecom_storage_gc_queued Image objects waiting to be collected.",
      "# TYPE ecom_storage_gc_queued gauge",
      `ecom_storage_gc_queued ${ops.storageGcQueued}`,
      // Not the same signal. A queue with depth is working; a queue with
      // exhausted rows has stopped, and every one of those is an object
      // being billed for indefinitely.
      "# HELP ecom_storage_gc_stalled Objects that gave up after exhausting their attempts.",
      "# TYPE ecom_storage_gc_stalled gauge",
      `ecom_storage_gc_stalled ${ops.storageGcStalled}`,
    );
  }

  // Trailing newline: the format requires one, and a scraper is entitled
  // to reject a payload without it.
  return out.join("\n") + "\n";
}

/** Exposed for tests; nothing in the service has a reason to call it. */
export function resetMetrics(): void {
  series.clear();
  ops = null;
}
