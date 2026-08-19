import { describe, expect, test } from "bun:test";

import { app } from "../src/app";

/**
 * Staff accounts.
 *
 * The interesting behaviour here needs a live GoTrue -- creating an auth
 * user is the whole point of the endpoint -- so what belongs in-process
 * is the contract and the refusals that do not need one: who may ask,
 * and the rules that keep the store from being locked out of its own
 * admin surface.
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
          requestBody?: {
            content: { "application/json": { schema: { properties?: Record<string, unknown> } } };
          };
          responses: Record<string, unknown>;
        }
      >
    >;
    components: { schemas: Record<string, unknown> };
  };

describe("who may manage staff", () => {
  test.each([
    ["/admin/staff", "GET"],
    ["/admin/staff", "POST"],
    ["/admin/staff/6f1a5f0e-0000-4000-8000-000000000000", "PATCH"],
  ])("%s %s is 401 without a token", async (path, method) => {
    const res = await app.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(method === "GET" ? {} : { body: "{}" }),
    });
    expect(res.status).toBe(401);
  });

  test("every staff route declares 403 -- the owner gate", async () => {
    const paths = (await doc()).paths;
    for (const [path, method] of [
      ["/admin/staff", "get"],
      ["/admin/staff", "post"],
      ["/admin/staff/{id}", "patch"],
    ] as const) {
      const op = paths[path]?.[method];
      expect(`${path} ${method}: ${op ? Object.keys(op.responses).join(",") : "MISSING"}`).toContain(
        "403",
      );
    }
  });
});

describe("the create contract", () => {
  test("a password is required, and long", async () => {
    const props = (await doc()).paths["/admin/staff"]?.post?.requestBody?.content[
      "application/json"
    ].schema.properties;
    expect(Object.keys(props ?? {})).toContain("password");
    expect((props?.password as { minLength?: number })?.minLength).toBe(12);
  });

  test("the response never carries the password back", async () => {
    // It exists in exactly one place -- the request that set it. Echoing
    // it would put a live credential in every proxy log between here and
    // the browser.
    const schemas = (await doc()).components.schemas;
    expect(JSON.stringify(schemas.StaffMember)).not.toContain("password");
  });

  test("409 and 502 are both declared, because both happen", async () => {
    // A duplicate email is the caller's problem to fix; an unreachable
    // GoTrue is not. A client that cannot tell them apart retries the
    // one that will never succeed.
    const responses = (await doc()).paths["/admin/staff"]?.post?.responses;
    expect(Object.keys(responses ?? {})).toContain("409");
    expect(Object.keys(responses ?? {})).toContain("502");
  });
});

describe("the update contract", () => {
  test("email and password are not editable here", async () => {
    // Both live on the auth user, not this row. Offering them would be a
    // promise this endpoint does not keep.
    const props = (await doc()).paths["/admin/staff/{id}"]?.patch?.requestBody?.content[
      "application/json"
    ].schema.properties;
    const keys = Object.keys(props ?? {});
    expect(keys).not.toContain("email");
    expect(keys).not.toContain("password");
    expect(keys).toEqual(expect.arrayContaining(["role", "is_active"]));
  });

  test("there is no DELETE on a staff member", async () => {
    // audit_logs.staff_id and inventory_movements.created_by point at
    // these rows. Deactivation is the delete.
    const paths = (await doc()).paths;
    expect(Object.keys(paths["/admin/staff/{id}"] ?? {})).not.toContain("delete");
    expect(Object.keys(paths["/admin/staff"] ?? {})).not.toContain("delete");
  });
});

describe("the document covers what was built", () => {
  test("both paths are mounted", async () => {
    const paths = Object.keys((await doc()).paths);
    expect(paths).toContain("/admin/staff");
    expect(paths).toContain("/admin/staff/{id}");
  });

  test("StaffMember is a registered component, not an inlined blob", async () => {
    expect(Object.keys((await doc()).components.schemas)).toContain("StaffMember");
  });
});
