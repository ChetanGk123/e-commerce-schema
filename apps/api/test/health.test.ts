import { describe, expect, test } from "bun:test";

import { app } from "../src/app";
import { beginShutdown } from "../src/routes/health";

/**
 * The readiness check itself needs a database, so what it answers when the
 * database is reachable is proven against a real stack, not here. What is
 * purely the API's is the distinction between the two probes -- and the
 * draining branch, which deliberately answers before touching Supabase and
 * is therefore the one part that can be asserted in process.
 *
 * This file runs beginShutdown() and never undoes it, so it must be the
 * last word on readiness in the suite.
 */
describe("liveness and readiness are not the same question", () => {
  test("both are public -- an orchestrator has no token", async () => {
    const doc = (await (await app.request("/openapi.json")).json()) as {
      paths: Record<string, Record<string, { security?: unknown[] }>>;
    };
    expect(doc.paths["/health"]?.get?.security).toBeUndefined();
    expect(doc.paths["/health/ready"]?.get?.security).toBeUndefined();
  });

  test("readiness declares 503, so a caller knows it is a rotation signal", async () => {
    const doc = (await (await app.request("/openapi.json")).json()) as {
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
    };
    expect(doc.paths["/health/ready"]?.get?.responses?.["503"]).toBeDefined();
  });

  test("neither probe echoes configuration", async () => {
    // A health endpoint that reports which host it talks to is a config
    // leak reachable without a token.
    const body = await (await app.request("/health")).text();
    expect(body).not.toContain("supabase");
    expect(body).not.toContain("http");
  });

  describe("once a shutdown has begun", () => {
    test("readiness fails without asking the database", async () => {
      beginShutdown();
      const res = await app.request("/health/ready");
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        status: "draining",
        latency_ms: null,
      });
    });

    test("liveness stays green, or the drain gets killed mid-request", async () => {
      // The whole point of the split. Failing liveness here would have the
      // orchestrator restart a process that is deliberately finishing work.
      const res = await app.request("/health");
      expect(res.status).toBe(200);
    });
  });
});
