import { describe, expect, test } from "bun:test";

import { app } from "../src/app";

/**
 * B10's validation bullet -- "a customer cannot read an internal ticket
 * note or set ticket priority" -- is asserted against a real database in
 * supabase/tests/01_invariants.sql, because both are RLS decisions.
 *
 * What is worth asserting here is the published contract, and one thing
 * about it in particular: `isInternal` and `priority` must not appear in
 * any customer-facing schema. A field a client can see is a field a
 * client will eventually be shown.
 */
const doc = async () =>
  (await (await app.request("/openapi.json")).json()) as {
    paths: Record<string, Record<string, { security?: unknown[] }>>;
    components: { schemas: Record<string, unknown> };
  };

describe("B10 the customer view carries nothing staff-only", () => {
  // The schemas reference each other by $ref, so a substring search over
  // one of them proves nothing. Resolve first.
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

  test("Ticket carries no isInternal, priority, or assignee -- refs and all", async () => {
    const ticket = await resolved("Ticket");
    for (const field of ["isInternal", "priority", "assignedTo", "firstResponseAt"]) {
      expect(`${field}:${ticket.includes(field)}`).toBe(`${field}:false`);
    }
  });

  test("AdminTicket does carry them -- that is the whole difference", async () => {
    const admin = await resolved("AdminTicket");
    for (const field of ["isInternal", "priority", "assignedTo", "firstResponseAt"]) {
      expect(`${field}:${admin.includes(field)}`).toBe(`${field}:true`);
    }
  });

  test("opening a ticket accepts no priority field", async () => {
    const op = (await doc()).paths["/support/tickets"]?.post as
      | { requestBody?: { content: { "application/json": { schema: { properties?: Record<string, unknown> } } } } }
      | undefined;
    const props = Object.keys(
      op?.requestBody?.content["application/json"].schema.properties ?? {},
    );
    // Sending it would be ignored either way -- RLS pins it -- but a
    // field in the contract is a promise, and this one would be false.
    expect(props).not.toContain("priority");
    expect(props).not.toContain("status");
    expect(props).not.toContain("assigned_to");
  });

  test("writing a review accepts neither status nor is_verified", async () => {
    const op = (await doc()).paths["/reviews"]?.post as
      | { requestBody?: { content: { "application/json": { schema: { properties?: Record<string, unknown> } } } } }
      | undefined;
    const props = Object.keys(
      op?.requestBody?.content["application/json"].schema.properties ?? {},
    );
    // is_verified is a generated column; status is pinned by RLS.
    expect(props).not.toContain("is_verified");
    expect(props).not.toContain("status");
  });
});

describe("B10 contract", () => {
  test("every path is published", async () => {
    const paths = (await doc()).paths;
    for (const p of [
      "/account",
      "/account/addresses",
      "/account/preferences",
      "/account/erase",
      "/admin/customers",
      "/admin/customers/{id}/erase",
      "/support/tickets",
      "/admin/tickets",
      "/admin/tickets/{id}",
      "/enquiries",
      "/reviews",
      "/admin/reviews",
      "/wishlist",
      "/stock-alerts",
      "/notifications",
    ]) {
      expect(paths[p]).toBeDefined();
    }
  });

  test("erasure is padlocked on both surfaces", async () => {
    const paths = (await doc()).paths;
    expect(paths["/account/erase"]?.post?.security).toBeDefined();
    expect(paths["/admin/customers/{id}/erase"]?.post?.security).toBeDefined();
  });

  test("enquiries and stock alerts are open to guests", async () => {
    // A bulk enquiry is often the first contact anyone has with the
    // store, and "tell me when it is back" should not need an account.
    for (const path of ["/enquiries", "/stock-alerts"]) {
      const res = await app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(`${path}:${res.status}`).not.toBe(`${path}:401`);
    }
  });

  test.each([
    ["GET", "/account"],
    ["POST", "/account/erase"],
    ["GET", "/support/tickets"],
    ["GET", "/wishlist"],
    ["GET", "/notifications"],
    ["GET", "/admin/tickets"],
    ["GET", "/admin/customers"],
  ])("%s %s is 401 without a token", async (method, path) => {
    const res = await app.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
    });
    expect(res.status).toBe(401);
  });
});
