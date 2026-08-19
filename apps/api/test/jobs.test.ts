import { describe, expect, test } from "bun:test";

import { app } from "../src/app";

/**
 * The claim/settle cycle is asserted in
 * supabase/tests/01_invariants.sql, because SKIP LOCKED and the retry
 * ladder are database behaviour and a mock would only prove the mock.
 *
 * Here: the guard on the drain endpoint, which is the one thing in this
 * phase that is purely the API's.
 */
const doc = async () =>
  (await (await app.request("/openapi.json")).json()) as {
    paths: Record<string, Record<string, { security?: unknown[] }>>;
    components: {
      schemas: Record<string, { properties?: Record<string, unknown> }>;
    };
  };

const drain = (headers: Record<string, string> = {}) =>
  app.request("/jobs/drain", { method: "POST", headers });

describe("B11 the drain endpoint is not open", () => {
  test("no secret header is a 400", async () => {
    expect((await drain()).status).toBe(400);
  });

  test("a wrong secret is 403, and says nothing else", async () => {
    const res = await drain({ "X-Jobs-Secret": "0123456789abcdef-wrong" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("forbidden");
    // Not "no secret configured" and not "wrong secret" -- either would
    // tell someone probing which of the two they are looking at.
    expect(body.error.message).toBe("Not allowed.");
  });

  test("a too-short secret cannot even be sent", async () => {
    // The 16-char floor is in the schema, so a deployment cannot be
    // guarded by something guessable.
    expect((await drain({ "X-Jobs-Secret": "short" })).status).toBe(400);
  });

  test("the drain carries no bearerAuth -- the secret IS the auth", async () => {
    const paths = (await doc()).paths;
    expect(paths["/jobs/drain"]?.post).toBeDefined();
    expect(paths["/jobs/drain"]?.post?.security).toBeUndefined();
    // Outbox health is a staff screen and does use a token.
    expect(paths["/admin/outbox"]?.get?.security).toBeDefined();
  });

  test("outbox health is 401 without a token", async () => {
    expect((await app.request("/admin/outbox")).status).toBe(401);
  });
});

/**
 * The redrive itself needs a database to do anything, so what it does is
 * asserted where a database exists. What is purely the API's -- and what
 * was actually missing -- is that the queue is reachable at all: from the
 * in-process loop, from an external scheduler, and from a staff screen.
 */
describe("failed webhooks are not a dead end", () => {
  test("the drain reports the redrive, so a JOBS_INTERVAL_SECONDS=0 deployment gets it too", async () => {
    // The whole reason the redrive rides on /jobs/drain rather than
    // taking an endpoint of its own: a deployment that turned the
    // in-process loop off has exactly one cron entry, and it points here.
    const props = (await doc()).components.schemas.DrainResult?.properties;
    expect(props).toBeDefined();
    expect(props?.webhooks).toBeDefined();
  });

  test("webhook health is a staff screen", async () => {
    expect((await app.request("/admin/webhooks")).status).toBe(401);
    expect((await doc()).paths["/admin/webhooks"]?.get?.security).toBeDefined();
  });
});
