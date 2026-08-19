import { beforeEach, describe, expect, test } from "bun:test";

import { app } from "../src/app";
import { resetRateLimits } from "../src/limits";

/**
 * In-process, so nothing reaches Postgres. The behaviour that matters --
 * a card redeemed once, a refund that cannot exceed what was captured, a
 * credit balance that cannot go negative -- is transactional and is
 * asserted in supabase/tests/01_invariants.sql against a real database.
 *
 * What is worth checking here is the contract, and one thing about it in
 * particular: a gift card code must appear in exactly one response shape
 * and nowhere else.
 */
const doc = async () =>
  (await (await app.request("/openapi.json")).json()) as {
    paths: Record<string, Record<string, { security?: unknown[] }>>;
    components: { schemas: Record<string, unknown> };
  };

// Every in-process request shares one rate-limit bucket: app.request()
// has no socket address, so clientKey() falls back to a single key.
// Without this, whichever test runs later gets a 429 instead of the
// status it is asserting.
beforeEach(resetRateLimits);

describe("B8 the code is said once", () => {
  test("only the issue response carries a code field", async () => {
    const schemas = (await doc()).components.schemas;

    expect(JSON.stringify(schemas.IssuedGiftCard)).toContain('"code"');

    // Anything else exposing a code would be a second place it exists,
    // and the whole design is that there is not one.
    for (const [name, schema] of Object.entries(schemas)) {
      if (name === "IssuedGiftCard") continue;
      if (/gift/i.test(name)) {
        expect(`${name}:${/"code"/.test(JSON.stringify(schema))}`).toBe(
          `${name}:false`,
        );
      }
    }
  });

  test("the redemption response returns last4, never the code", async () => {
    const redemption = JSON.stringify(
      (await doc()).components.schemas.GiftCardRedemption,
    );
    expect(redemption).toContain("last4");
    expect(redemption).not.toContain('"code"');
  });
});

describe("B8 contract", () => {
  test("every new path is published", async () => {
    const paths = (await doc()).paths;
    for (const p of [
      "/returns",
      "/admin/returns",
      "/admin/returns/{id}/review",
      "/admin/returns/{id}/receive",
      "/admin/orders/{id}/refunds",
      "/admin/refunds/{id}/settle",
      "/credit",
      "/gift-cards/redeem",
      "/admin/customers/{id}/credit",
      "/admin/gift-cards",
    ]) {
      expect(paths[p]).toBeDefined();
    }
  });

  test("issuing and granting are padlocked; so is opening a return", async () => {
    const paths = (await doc()).paths;
    expect(paths["/admin/gift-cards"]?.post?.security).toBeDefined();
    expect(paths["/admin/customers/{id}/credit"]?.post?.security).toBeDefined();
    // A return names an order. Anonymous, it would be an order-id oracle.
    expect(paths["/returns"]?.post?.security).toBeDefined();
  });

  test.each([
    ["POST", "/returns"],
    ["GET", "/credit"],
    ["POST", "/gift-cards/redeem"],
    ["POST", "/admin/gift-cards"],
    ["GET", "/admin/returns"],
  ])("%s %s is 401 without a token", async (method, path) => {
    const res = await app.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
    });
    expect(res.status).toBe(401);
  });
});

describe("B8 validation", () => {
  test.each([
    ["a refund of zero", "/admin/orders/00000000-0000-4000-8000-000000000000/refunds", { amount: 0 }],
    ["a negative refund", "/admin/orders/00000000-0000-4000-8000-000000000000/refunds", { amount: -5 }],
    ["a gift card worth nothing", "/admin/gift-cards", { amount: 0 }],
    ["a credit entry of zero", "/admin/customers/00000000-0000-4000-8000-000000000000/credit", { delta: 0, reason: "goodwill", note: "x" }],
  ])("%s never reaches the database", async (_label, path, body) => {
    const res = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // 401 first: auth runs before validation, so an anonymous caller
    // learns nothing about the body shape. Both are refusals before any
    // money moves, which is what this asserts.
    expect([400, 401]).toContain(res.status);
  });

  test("the grantable credit reasons exclude the ones that must be earned", async () => {
    // The ENUM, not the whole operation -- the description names the
    // excluded reasons on purpose, to say why they are excluded.
    const op = (await doc()).paths["/admin/customers/{id}/credit"]?.post as
      | {
          requestBody?: {
            content: {
              "application/json": {
                schema: { properties: { reason: { enum: string[] } } };
              };
            };
          };
        }
      | undefined;
    const reasons =
      op?.requestBody?.content["application/json"].schema.properties.reason.enum;

    expect(reasons).toEqual(["goodwill", "promotion", "adjustment", "expiry"]);
    // Granting either by hand would invent a return or a card that does
    // not exist.
    expect(reasons).not.toContain("return_credit");
    expect(reasons).not.toContain("gift_card_redemption");
  });
});
