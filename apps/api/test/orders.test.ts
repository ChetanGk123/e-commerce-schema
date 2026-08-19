import { describe, expect, test } from "bun:test";

import { app } from "../src/app";
import { mapDatabaseError } from "../src/errors";

/**
 * Orders.
 *
 * The database owns what a capture and a cancel actually do -- the stock
 * ledger arithmetic is asserted in supabase/tests/01_invariants.sql,
 * where real triggers can refuse real writes.
 *
 * What belongs here is the contract: that a customer's order does not
 * carry our notes about them, that a caller has to be somebody, and that
 * the two RPCs' refusals arrive as 404s and 409s rather than 500s.
 */
const doc = async () =>
  (await (await app.request("/openapi.json")).json()) as {
    paths: Record<
      string,
      Record<
        string,
        {
          security?: unknown[];
          parameters?: { name: string; in: string; required?: boolean }[];
          responses: Record<string, unknown>;
        }
      >
    >;
    components: { schemas: Record<string, unknown> };
  };

/** The schemas reference each other by $ref, so resolve before searching. */
const resolved = async (name: string) => {
  const schemas = (await doc()).components.schemas as Record<string, unknown>;
  const seen = new Set<string>();
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const ref = (node as { $ref?: string }).$ref;
      if (ref) {
        const target = ref.split("/").pop()!;
        if (seen.has(target)) return {};
        seen.add(target);
        return walk(schemas[target]);
      }
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, walk(v)]),
      );
    }
    return node;
  };
  return JSON.stringify(walk(schemas[name]));
};

describe("the customer's order carries none of our notes about them", () => {
  test("Order has no risk score, risk flags or campaign attribution", async () => {
    const order = await resolved("Order");
    for (const field of [
      "riskScore",
      "riskFlags",
      "utmSource",
      "utmMedium",
      "utmCampaign",
      "customerId",
    ]) {
      expect(`${field}:${order.includes(field)}`).toBe(`${field}:false`);
    }
  });

  test("AdminOrder does carry them -- that is the whole difference", async () => {
    const admin = await resolved("AdminOrder");
    for (const field of ["riskScore", "riskFlags", "utmSource", "customerId", "payments"]) {
      expect(`${field}:${admin.includes(field)}`).toBe(`${field}:true`);
    }
  });

  /**
   * order_events.note is staff free text with no is_internal column to
   * check, so a cancellation reason reading "suspected fraud" would go
   * straight to the customer. The timeline is shared between both order
   * shapes, which is exactly how it would happen.
   */
  test("the customer timeline carries no staff note", async () => {
    expect(await resolved("OrderEvent")).not.toContain("note");
    expect(await resolved("AdminOrderEvent")).toContain("note");
  });

  test("Order's events are OrderEvent, not the admin one", async () => {
    // .extend() does not reach inside an array: without the explicit
    // override on AdminOrder, both shapes would share one event type and
    // the note would leak through the customer's own order.
    const order = await resolved("Order");
    expect(order).not.toContain("actorId");
    expect(await resolved("AdminOrder")).toContain("actorId");
  });
});

describe("who may ask", () => {
  test.each([
    ["/orders"],
    ["/orders/6f1a5f0e-0000-4000-8000-000000000000"],
    ["/admin/orders"],
    ["/admin/orders/6f1a5f0e-0000-4000-8000-000000000000"],
  ])("%s is 401 without a token", async (path) => {
    const res = await app.request(path);
    expect(res.status).toBe(401);
  });

  test.each([
    ["/admin/orders/6f1a5f0e-0000-4000-8000-000000000000/capture-cod"],
    ["/admin/orders/6f1a5f0e-0000-4000-8000-000000000000/cancel"],
  ])("%s is 401 without a token", async (path) => {
    const res = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "not-a-real-key" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  test("every admin order route declares staff 403 in the document", async () => {
    const paths = (await doc()).paths;
    for (const [path, method] of [
      ["/admin/orders", "get"],
      ["/admin/orders/{id}", "get"],
      ["/admin/orders/{id}/capture-cod", "post"],
      ["/admin/orders/{id}/cancel", "post"],
    ] as const) {
      const op = paths[path]?.[method];
      expect(`${path}: ${op ? Object.keys(op.responses).join(",") : "missing"}`).toContain("403");
    }
  });

  test("the 401 does not say why", async () => {
    // A token that will not parse, and one that parses but is signed
    // with the wrong key. Two different internal failures; telling them
    // apart would hand an attacker a free oracle, so the caller gets one
    // message and the reason goes to the log.
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const wronglySigned = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
      sub: "6f1a5f0e-0000-4000-8000-000000000000",
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.notthesignature`;

    const messages: string[] = [];
    for (const token of ["not.a.jwt", wronglySigned]) {
      const res = await app.request("/orders", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(401);
      messages.push(((await res.json()) as { error: { message: string } }).error.message);
    }
    expect(messages[0]).toBe(messages[1]!);
  });
});

describe("capture-cod moves money, so it demands a key", () => {
  test("the header is declared required", async () => {
    const params = (await doc()).paths["/admin/orders/{id}/capture-cod"]?.post?.parameters;
    const key = params?.find(
      (p) => p.name.toLowerCase() === "idempotency-key" && p.in === "header",
    );
    expect(key?.required).toBe(true);
  });

  test("cancel does not demand one", async () => {
    // Its refusal is more useful than a replayed success: the status
    // check makes a second cancel a 409 that says why.
    const params = (await doc()).paths["/admin/orders/{id}/cancel"]?.post?.parameters;
    const key = params?.find((p) => p.name.toLowerCase() === "idempotency-key");
    expect(key).toBeUndefined();
  });
});

describe("the two RPCs' refusals are not 500s", () => {
  test.each([
    ["order ORD-2026-00042 is shipped and cannot be cancelled", 409, "order_not_cancellable"],
    ["order ORD-2026-00042 is paid, not pending", 409, "order_not_pending"],
  ])("%s -> %i", (message, status, code) => {
    // Both functions predate the ECOM1/ECOM2 convention and raise plain
    // SQLSTATEs. Unmapped, the most ordinary mistake in the console --
    // cancelling twice -- would tell an admin to contact support.
    const m = mapDatabaseError({ message });
    expect(m?.status).toBe(status as 409);
    expect(m?.code).toBe(code);
  });

  test("a missing order is a 404, from the SQLSTATE alone", () => {
    const m = mapDatabaseError({
      code: "P0002",
      message: "order 6f1a5f0e-0000-4000-8000-000000000000 not found",
    });
    expect(m?.status).toBe(404);
  });

  test("neither refusal echoes the order number back", () => {
    for (const message of [
      "order ORD-2026-00042 is shipped and cannot be cancelled",
      "order ORD-2026-00042 is paid, not pending",
    ]) {
      expect(mapDatabaseError({ message })?.message).not.toContain("ORD-2026-00042");
    }
  });
});

describe("the document covers what was built", () => {
  test("all six paths are mounted", async () => {
    const paths = Object.keys((await doc()).paths);
    for (const p of [
      "/orders",
      "/orders/{id}",
      "/admin/orders",
      "/admin/orders/{id}",
      "/admin/orders/{id}/capture-cod",
      "/admin/orders/{id}/cancel",
    ]) {
      expect(paths).toContain(p);
    }
  });

  test("the order console filters are all declared", async () => {
    const names = (await doc()).paths["/admin/orders"]?.get?.parameters?.map((p) => p.name);
    for (const q of ["status", "email", "q", "placed_from", "placed_to", "flagged"]) {
      expect(names).toContain(q);
    }
  });

  test("auth runs before validation, so a bad id leaks no shape", async () => {
    const res = await app.request("/orders/not-a-uuid", {
      headers: { Authorization: "Bearer not.a.jwt" },
    });
    // 401 rather than 400: an unauthenticated caller learns nothing
    // about what the endpoint expects.
    expect(res.status).toBe(401);
  });
});
