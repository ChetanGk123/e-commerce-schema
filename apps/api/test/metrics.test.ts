import { beforeEach, describe, expect, test } from "bun:test";

import { app } from "../src/app";
import { publishOps, recordRequest, render, resetMetrics } from "../src/metrics";

/**
 * A malformed exposition payload is rejected by the scraper, and the
 * symptom is an empty dashboard rather than an error anybody sees. So
 * the format is what is asserted here, not merely that numbers move.
 */

const lines = () => render().split("\n");
const find = (prefix: string) => lines().filter((l) => l.startsWith(prefix));
const value = (line: string) => Number(line.slice(line.lastIndexOf(" ") + 1));

describe("exposition format", () => {
  beforeEach(resetMetrics);

  test("every metric declares HELP and TYPE, and the payload ends in a newline", () => {
    recordRequest("GET", "/catalog/products", 200, 0.03);
    const out = lines();
    expect(out).toContain("# TYPE http_requests_total counter");
    expect(out).toContain("# TYPE http_request_duration_seconds histogram");
    for (const name of ["http_requests_total", "http_request_duration_seconds"]) {
      expect(out.some((l) => l.startsWith(`# HELP ${name} `))).toBe(true);
    }
    expect(render().endsWith("\n")).toBe(true);
  });

  test("buckets are cumulative and +Inf equals the count", () => {
    // The invariant a scraper relies on. Buckets counting only their own
    // slice look perfectly plausible and make every quantile wrong.
    for (const s of [0.001, 0.03, 0.4, 30]) {
      recordRequest("GET", "/catalog/products", 200, s);
    }

    const buckets = find("http_request_duration_seconds_bucket").map(value);
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i]!).toBeGreaterThanOrEqual(buckets[i - 1]!);
    }

    const count = value(find("http_request_duration_seconds_count")[0]!);
    expect(count).toBe(4);
    expect(value(find("http_request_duration_seconds_bucket").at(-1)!)).toBe(count);

    // 30s is past the last bound, so it lands in +Inf and nowhere else --
    // which is the only reason a timed-out request stays visible at all.
    const tenSecond = find("http_request_duration_seconds_bucket").find((l) =>
      l.includes('le="10"'),
    )!;
    expect(value(tenSecond)).toBe(3);
  });

  test("sum is seconds, not milliseconds", () => {
    // Wrong, this makes every latency panel off by a factor of 1000 and
    // still renders happily. One assertion is cheap.
    recordRequest("GET", "/x", 200, 0.25);
    recordRequest("GET", "/x", 200, 0.25);
    expect(value(find("http_request_duration_seconds_sum")[0]!)).toBeCloseTo(0.5, 6);
  });

  test("status splits the counter but not the histogram", () => {
    recordRequest("GET", "/x", 200, 0.01);
    recordRequest("GET", "/x", 500, 0.01);
    expect(find("http_requests_total{")).toHaveLength(2);
    expect(find("http_request_duration_seconds_count")).toHaveLength(1);
  });

  test("one series per route pattern, whatever the traffic", () => {
    // The cardinality guarantee. If this is ever labelled by path,
    // Prometheus gets a time series per product slug.
    for (let i = 0; i < 4; i++) {
      recordRequest("GET", "/catalog/products/:slug", 200, 0.01);
    }
    expect(find("http_requests_total{")).toHaveLength(1);
    expect(find("http_requests_total{")[0]).toContain('route="/catalog/products/:slug"');
  });
});

describe("the ops gauges", () => {
  beforeEach(resetMetrics);

  test("age is -1 until the jobs tick has published once", () => {
    // Not 0. A dashboard cannot tell "fresh" from "never ran" if the
    // absence of a snapshot reads as zero seconds old.
    expect(find("ecom_ops_snapshot_age_seconds")[0]).toBe("ecom_ops_snapshot_age_seconds -1");
    expect(find("ecom_webhooks_exhausted")).toHaveLength(0);
  });

  test("published values appear, with a fresh age", () => {
    publishOps({
      outbox: { queued: 3, sent: 91 },
      outboxStalled: 1,
      webhooksUnprocessed: 2,
      webhooksExhausted: 0,
      authLockouts: 7,
    });

    expect(find('ecom_outbox_messages{status="queued"}')[0]).toContain(" 3");
    expect(find("ecom_outbox_stalled")[0]).toBe("ecom_outbox_stalled 1");
    expect(find("ecom_auth_lockouts_active")[0]).toBe("ecom_auth_lockouts_active 7");

    const age = value(find("ecom_ops_snapshot_age_seconds")[0]!);
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(5);
  });
});

describe("the endpoint", () => {
  test("is not there without METRICS_TOKEN", async () => {
    // The default, and the state this whole suite runs in.
    expect((await app.request("/metrics")).status).toBe(404);
  });

  test("with a token: the right one serves, a wrong one looks like off", async () => {
    // A subprocess, because env.ts validates at import time and bun
    // shares one module registry across test files -- app.ts has already
    // been imported with no token by the time this runs.
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `const { app } = await import("${import.meta.dir}/../src/app.ts");
         // Real traffic first, so the labels come from requestLogger and
         // the router rather than from a direct recordRequest call.
         await app.request("/health");
         await app.request("/health");
         await app.request("/catalog/products?limit=500");   // 400
         await app.request("/no-such-route-at-all");         // 404
         const hit = async (h) => (await app.request("/metrics", { headers: h })).status;
         const ok = await app.request("/metrics", {
           headers: { authorization: "Bearer " + process.env.METRICS_TOKEN },
         });
         console.log(JSON.stringify({
           none: await hit({}),
           wrong: await hit({ authorization: "Bearer nope" }),
           right: ok.status,
           type: ok.headers.get("content-type"),
           body: await ok.text(),
         }));`,
      ],
      {
        env: {
          ...process.env,
          METRICS_TOKEN: "a-scrape-token-at-least-16-chars",
          LOG_LEVEL: "fatal",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const text = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());

    const r = JSON.parse(text.trim().split("\n").pop()!) as Record<string, string | number>;
    expect(r.right).toBe(200);
    // Prometheus checks the version parameter; without it the scrape is
    // refused as an unknown format.
    expect(String(r.type)).toContain("version=0.0.4");
    const body = String(r.body);
    expect(body).toContain("# TYPE http_requests_total counter");

    // The seam requestLogger owns: the label is the registered pattern
    // the router matched, and two requests to one route are one series.
    expect(body).toContain('http_requests_total{method="GET",route="/health",status="200"} 2');
    // A rejected query is still that route, not a separate one.
    expect(body).toContain('route="/catalog/products",status="400"');
    // And a path that matched nothing is named as such -- the catch-all
    // middleware's own "/*" would read like a real route.
    expect(body).toContain('route="unmatched",status="404"');
    // The scrape itself is not counted; counting the observer says
    // nothing about the service.
    expect(body).not.toContain('route="/metrics"');

    // Both failures answer identically, so a wrong token cannot be told
    // apart from an endpoint that was never switched on.
    expect(r.none).toBe(404);
    expect(r.wrong).toBe(404);
  });
});
