import { describe, expect, test } from "bun:test";

import { app } from "../src/app";
import { requestHash } from "../src/routes/checkout";

/**
 * In-process, so nothing reaches Postgres. What that bounds is deliberate:
 * the behaviour that matters here -- one order per idempotency key, oversell
 * rolls back, a spent coupon is refused -- is transactional, and is asserted
 * in supabase/tests/01_invariants.sql where a real database can refuse things.
 *
 * What is testable here is the layer above: that a bad request never reaches
 * the function at all, and that the contract says what the code does.
 */
const body = {
  items: [{ variant_id: "22222222-0000-4000-8000-000000000001", quantity: 2 }],
  email: "guest@example.com",
  contact_phone: "9876543210",
  shipping_address: {
    line1: "1 Test Street",
    city: "Bengaluru",
    state: "Karnataka",
    postal_code: "560001",
    country: "IN",
  },
  payment_method: "cod",
};

const post = (patch: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  app.request("/checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "test-key-00000001",
      ...headers,
    },
    body: JSON.stringify({ ...body, ...patch }),
  });

describe("B5 request hashing", () => {
  test("key order does not change the hash", () => {
    // idempotency_keys.request_hash is what catches "same key, different
    // basket". If it moved with key order, an identical retry from a client
    // that serialises differently would be rejected as a conflict.
    expect(requestHash({ a: 1, b: [2, { c: 3, d: 4 }] })).toBe(
      requestHash({ b: [2, { d: 4, c: 3 }], a: 1 }),
    );
  });

  test("a changed basket changes the hash", () => {
    expect(requestHash(body)).not.toBe(
      requestHash({ ...body, items: [{ ...body.items[0], quantity: 3 }] }),
    );
  });

  test("array order still counts -- it is not a set", () => {
    expect(requestHash({ x: [1, 2] })).not.toBe(requestHash({ x: [2, 1] }));
  });
});

describe("B5 checkout validation", () => {
  test("a missing Idempotency-Key is refused before anything is claimed", async () => {
    const res = await app.request("/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_request",
    );
  });

  test.each([
    ["an empty basket", { items: [] }],
    ["a zero quantity", { items: [{ variant_id: "22222222-0000-4000-8000-000000000001", quantity: 0 }] }],
    ["a variant id that is not a uuid", { items: [{ variant_id: "nope", quantity: 1 }] }],
    ["a missing email", { email: undefined }],
    ["a five-digit pincode", { shipping_address: { ...body.shipping_address, postal_code: "56001" } }],
    ["an unsupported payment method", { payment_method: "bitcoin" }],
  ])("%s never reaches the database", async (_label, patch) => {
    expect((await post(patch)).status).toBe(400);
  });

  test("a present but invalid token is 401, not a silent guest checkout", async () => {
    // Demoting an expired session to a guest would place the order against no
    // account, and the customer would not find it in their order history.
    const res = await post({}, { Authorization: "Bearer not-a-jwt" });
    expect(res.status).toBe(401);
  });
});

describe("B5 cart", () => {
  test("browsing a cart needs no token", async () => {
    const res = await app.request("/cart");
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  test("a broken token on the cart is still 401", async () => {
    const res = await app.request("/cart", {
      headers: { Authorization: "Bearer not-a-jwt" },
    });
    expect(res.status).toBe(401);
  });

  test("merging requires sign-in -- that is the whole point of it", async () => {
    const res = await app.request("/cart/merge", {
      method: "POST",
      headers: { "X-Cart-Session": "00000000-0000-4000-8000-000000000000" },
    });
    expect(res.status).toBe(401);
  });

  test.each([
    ["a quantity of zero", { variant_id: "22222222-0000-4000-8000-000000000001", quantity: 0 }],
    ["past cart_items' 10000 cap", { variant_id: "22222222-0000-4000-8000-000000000001", quantity: 10001 }],
    ["a variant id that is not a uuid", { variant_id: "nope", quantity: 1 }],
  ])("%s is a 400, not a database error", async (_label, payload) => {
    const res = await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
  });
});

describe("B5 contract", () => {
  test("the new paths are published", async () => {
    const doc = (await (await app.request("/openapi.json")).json()) as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    for (const p of [
      "/cart",
      "/cart/items",
      "/cart/items/{variantId}",
      "/cart/merge",
      "/checkout",
    ]) {
      expect(doc.paths[p]).toBeDefined();
    }

    // A client that cannot tell 409 from 422 will retry the wrong ones: 409
    // means stop and show the basket, 422 means fix a field.
    const checkout = doc.paths["/checkout"]?.post?.responses;
    expect(checkout?.["409"]).toBeDefined();
    expect(checkout?.["422"]).toBeDefined();
  });

  test("no checkout schema exposes a cost field", async () => {
    const doc = (await (await app.request("/openapi.json")).json()) as {
      components: { schemas: Record<string, unknown> };
    };
    for (const name of ["Cart", "CartLine", "CheckoutResponse"]) {
      expect(JSON.stringify(doc.components.schemas[name])).not.toMatch(/cost/i);
    }
  });
});
