import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";

import { app } from "../src/app";
import { resetRateLimits } from "../src/limits";

beforeEach(resetRateLimits);

const doc = async () =>
  (await (await app.request("/openapi.json")).json()) as {
    paths: Record<string, Record<string, { middleware?: unknown }>>;
    components: { schemas: Record<string, unknown> };
  };

describe("B12 the spec covers every route", () => {
  test("no route is declared with app.get/post instead of createRoute", () => {
    // A raw handler is invisible to both the OpenAPI document and the hc
    // client, so a front end simply cannot call it. This is the check
    // that the convention is actually being followed.
    const dir = join(import.meta.dir, "..", "src", "routes");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(join(dir, file), "utf8").replace(/\s+/g, " ");
      // The leading slash matters: c.get("caller") is not a route.
      const raw = /\.(get|post|patch|put|delete)\(\s*["'`]\//.exec(text);
      expect(`${file}: ${raw?.[0] ?? "clean"}`).toBe(`${file}: clean`);
    }
  });

  test("every mounted path appears in the document", async () => {
    const paths = Object.keys((await doc()).paths);
    // A representative from every phase. If a router is ever dropped from
    // the chain in app.ts it stops extending AppType, and the front end
    // loses those routes silently -- this is what notices.
    for (const p of [
      "/health", "/me", "/catalog/products", "/shipping/quote",
      "/cart", "/checkout", "/payments/razorpay/order", "/webhooks/razorpay",
      "/admin/inventory/movements", "/admin/orders/{id}/shipments",
      "/returns", "/credit", "/invoices", "/account", "/support/tickets",
      "/wishlist", "/jobs/drain",
    ]) {
      expect(paths).toContain(p);
    }
    expect(paths.length).toBeGreaterThan(45);
  });
});

describe("B12 money-moving POSTs demand an idempotency key", () => {
  test.each([
    ["/checkout"],
    ["/admin/orders/{id}/refunds"],
    ["/admin/gift-cards"],
  ])("%s declares the header as required", async (path) => {
    const params = ((await doc()).paths[path]?.post as
      | { parameters?: { name: string; in: string; required?: boolean }[] }
      | undefined)?.parameters;
    const key = params?.find(
      (p) => p.name.toLowerCase() === "idempotency-key" && p.in === "header",
    );
    expect(`${path}: ${key ? "declared" : "missing"}`).toBe(`${path}: declared`);
    expect(key?.required).toBe(true);
  });
});

describe("B12 rate limiting", () => {
  test("the budget is spent and then refused", async () => {
    // /enquiries costs 6, so the default 60/min allows ten.
    const codes: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await app.request("/enquiries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      codes.push(res.status);
    }
    expect(codes).toContain(429);
    // And not from the first request: a limiter that refuses immediately
    // is a limiter nobody can use.
    expect(codes[0]).not.toBe(429);
  });

  test("a refusal says when to come back", async () => {
    let res = await app.request("/enquiries", { method: "POST", body: "{}" });
    for (let i = 0; i < 15 && res.status !== 429; i += 1) {
      res = await app.request("/enquiries", { method: "POST", body: "{}" });
    }
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(res.headers.get("RateLimit-Remaining")).toBe("0");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "rate_limited",
    );
  });

  test("reads are not limited -- browsing a catalog is not an attack", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      codes.push((await app.request("/health")).status);
    }
    expect(codes.every((s) => s === 200)).toBe(true);
  });
});

describe("B12 CORS is closed by default", () => {
  test("an unlisted origin gets no allow header", async () => {
    const res = await app.request("/health", {
      headers: { Origin: "https://evil.example.com" },
    });
    // No Access-Control-Allow-Origin means the browser drops the response.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("a request with no Origin is untouched -- webhooks and cron send none", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });
});
