import { createHmac } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { app } from "../src/app";

/**
 * In-process, so nothing reaches Postgres or Razorpay. That leaves exactly
 * one thing worth asserting here, and it is the important one: an unsigned or
 * tampered delivery must be rejected BEFORE any of the code that changes an
 * order can run.
 *
 * The idempotency itself -- same delivery twice, one state change -- is
 * asserted in supabase/tests/01_invariants.sql against a real database,
 * because that is where the unique index and the ledger actually live.
 *
 * The secret here matches apps/api/.env for local runs. When it does not, a
 * correctly-signed body is rejected too, which is why the suite asserts the
 * REJECTIONS rather than the happy path: those hold either way.
 */
const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";

const body = JSON.stringify({
  event: "payment.captured",
  payload: { payment: { entity: { id: "pay_X", order_id: "order_X", amount: 100 } } },
});

const deliver = (headers: Record<string, string>) =>
  app.request("/webhooks/razorpay", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });

const sign = (raw: string, secret = SECRET) =>
  createHmac("sha256", secret).update(raw).digest("hex");

describe("B6 webhook authentication", () => {
  test("no signature is refused", async () => {
    const res = await deliver({});
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_signature",
    );
  });

  test("a signature from the wrong secret is refused", async () => {
    const res = await deliver({ "X-Razorpay-Signature": sign(body, "not-the-secret") });
    expect(res.status).toBe(401);
  });

  test("a valid signature over a DIFFERENT body is refused", async () => {
    // The whole attack: replay yesterday's signature against today's amount.
    const res = await deliver({ "X-Razorpay-Signature": sign('{"event":"other"}') });
    expect(res.status).toBe(401);
  });

  test("a garbage signature header does not crash the handler", async () => {
    // validateWebhookSignature throws rather than returning false on some
    // malformed input; a 500 here would be a free denial of service.
    const res = await deliver({ "X-Razorpay-Signature": "!!!not-hex!!!" });
    expect(res.status).toBe(401);
  });

  test("every rejection says the same thing", async () => {
    const codes = await Promise.all(
      ([
        {},
        { "X-Razorpay-Signature": sign(body, "wrong") },
        { "X-Razorpay-Signature": "!!!" },
      ] as Record<string, string>[]).map(async (h) => {
        const body = (await (await deliver(h)).json()) as {
          error: { message: string };
        };
        return body.error.message;
      }),
    );
    // Telling a caller which way it failed narrows the search for them.
    expect(new Set(codes).size).toBe(1);
  });
});

describe("B6 payments contract", () => {
  test("the routes are published, webhook without a padlock", async () => {
    const doc = (await (await app.request("/openapi.json")).json()) as {
      paths: Record<string, Record<string, { security?: unknown[]; responses: Record<string, unknown> }>>;
    };
    expect(doc.paths["/payments/razorpay/order"]).toBeDefined();
    expect(doc.paths["/webhooks/razorpay"]).toBeDefined();

    // A webhook cannot carry our bearer token -- the signature is the
    // authentication. Declaring bearerAuth on it would be a lie in the docs.
    expect(doc.paths["/webhooks/razorpay"]?.post?.security).toBeUndefined();

    // 503 is the honest answer on a deployment with no gateway credentials,
    // and it has to be documented or a client treats it as an outage.
    expect(doc.paths["/payments/razorpay/order"]?.post?.responses["503"]).toBeDefined();
    expect(doc.paths["/payments/razorpay/order"]?.post?.responses["502"]).toBeDefined();
  });

  test("no payment schema leaks the key secret", async () => {
    const doc = (await (await app.request("/openapi.json")).json()) as {
      components: { schemas: Record<string, unknown> };
    };
    const intent = JSON.stringify(doc.components.schemas.PaymentIntent);
    expect(intent).toContain("keyId");
    expect(intent).not.toMatch(/secret/i);
  });

  test("opening a payment needs a uuid, not any string", async () => {
    const res = await app.request("/payments/razorpay/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_id: "ORD-2026-00001" }),
    });
    expect(res.status).toBe(400);
  });
});
