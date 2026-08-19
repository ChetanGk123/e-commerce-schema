import { describe, expect, test } from "bun:test";

import { app } from "../src/app";
import {
  STOREFRONT_PRODUCT_COLUMNS,
  STOREFRONT_VARIANT_COLUMNS,
} from "../src/routes/catalog";

/**
 * In-process, so nothing here reaches Postgres. That bounds what can be
 * asserted: validation and shape, which run before any query, plus the
 * contract published in the OpenAPI document.
 *
 * The row-level guarantees -- a draft product is invisible, cost_price is
 * unreachable -- are asserted where they are actually enforced, in
 * supabase/tests/01_invariants.sql under the customer role. A test here that
 * mocked the database would only prove the mock.
 */

interface Doc {
  paths: Record<string, unknown>;
  components: { schemas: Record<string, unknown> };
}

const doc = async () => (await (await app.request("/openapi.json")).json()) as Doc;

describe("B4 storefront scoping", () => {
  test("no storefront select list mentions cost_price", () => {
    for (const cols of [
      STOREFRONT_PRODUCT_COLUMNS,
      STOREFRONT_VARIANT_COLUMNS,
    ]) {
      expect(cols).not.toContain("cost_price");
    }
  });

  test("variants come from the view, so the column is not even reachable", () => {
    // storefront_variants does not project cost_price and product_variants has
    // no public RLS policy. Naming a column here that does not exist on the
    // view would be a 400 from PostgREST, not a leak -- but the list is the
    // first line of defence and cheap to keep honest.
    expect(STOREFRONT_VARIANT_COLUMNS).toContain("price");
    expect(STOREFRONT_VARIANT_COLUMNS).not.toMatch(/cost/);
  });

  test("the published storefront schemas expose no cost field", async () => {
    const schemas = (await doc()).components.schemas;
    for (const name of ["ProductSummary", "ProductDetail", "CatalogVariant"]) {
      expect(JSON.stringify(schemas[name])).not.toMatch(/cost/i);
    }
  });

  test("the admin variant schema does expose it -- that is the difference", async () => {
    const schemas = (await doc()).components.schemas;
    expect(JSON.stringify(schemas.AdminVariant)).toContain("costPrice");
  });
});

describe("B4 route contract", () => {
  test("every new path is in the OpenAPI document", async () => {
    const paths = (await doc()).paths;
    for (const p of [
      "/catalog/products",
      "/catalog/products/{slug}",
      "/catalog/categories",
      "/catalog/collections",
      "/admin/products",
      "/admin/products/{id}",
      "/shipping/quote",
    ]) {
      expect(paths[p]).toBeDefined();
    }
  });

  test.each([
    ["one-character search", "/catalog/products?q=a"],
    ["a page size past the cap", "/catalog/products?limit=500"],
    ["a negative offset", "/catalog/products?offset=-1"],
    ["a five-digit pincode", "/shipping/quote?pincode=56001"],
    ["a pincode starting with zero", "/shipping/quote?pincode=060001"],
    ["a negative weight", "/shipping/quote?pincode=560001&weight_grams=-5"],
  ])("%s is rejected before any query runs", async (_label, path) => {
    const res = await app.request(path);
    expect(res.status).toBe(400);

    // In the same envelope as everything else. @hono/zod-openapi's default is
    // { success: false, error: { issues: [...] } }, which has no `code` for a
    // client to branch on and publishes the zod internals.
    const body = (await res.json()) as {
      error: { code: string; message: string; requestId: string };
    };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.requestId).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("ZodError");
  });
});

describe("browsable docs", () => {
  test("/docs serves Swagger UI", async () => {
    const res = await app.request("/docs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("the bearer scheme is declared, so Swagger shows an Authorize button", async () => {
    const d = (await doc()) as unknown as {
      components: { securitySchemes?: Record<string, unknown> };
      paths: Record<string, Record<string, { security?: unknown[] }>>;
    };
    expect(d.components.securitySchemes?.bearerAuth).toBeDefined();

    // A protected route with no `security` renders with no way to send a
    // token, which reads as broken rather than guarded.
    for (const p of ["/me", "/admin/products", "/admin/products/{id}"]) {
      expect(d.paths[p]?.get?.security).toBeDefined();
    }
    // ...and a public one must not ask for a token it does not need.
    expect(d.paths["/catalog/products"]?.get?.security).toBeUndefined();
  });
});

describe("DOCS_PUBLIC=false", () => {
  /**
   * In a subprocess, because env.ts validates at import time and bun
   * shares one module registry across every test file -- by the time
   * this runs, app.ts has already been imported with the flag on.
   * Setting process.env here would prove nothing.
   *
   * Worth the fifteen lines: the untested direction is the one somebody
   * relies on. A gate that silently fails open leaves a deployment
   * believing its route map is private.
   */
  const run = async (): Promise<Record<string, number>> => {
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `const { app } = await import("${import.meta.dir}/../src/app.ts");
         const out = {};
         for (const p of ["/docs", "/openapi.json", "/catalog/products?limit=1"]) {
           out[p] = (await app.request(p)).status;
         }
         console.log(JSON.stringify(out));`,
      ],
      {
        env: { ...process.env, DOCS_PUBLIC: "false", LOG_LEVEL: "fatal" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const text = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) {
      throw new Error(await new Response(proc.stderr).text());
    }
    return JSON.parse(text.trim().split("\n").pop()!) as Record<string, number>;
  };

  test("both documents are gone, and nothing else is", async () => {
    const status = await run();
    expect(status["/docs"]).toBe(404);
    expect(status["/openapi.json"]).toBe(404);
    // 404 rather than 401: a 401 confirms there is something there, which
    // is the one fact whoever asked for the route map was after. And the
    // service still serves -- hiding the map is not turning the API off.
    expect(status["/catalog/products?limit=1"]).not.toBe(404);
  });
});

describe("B4 admin catalog is behind auth", () => {
  test.each([
    ["/admin/products"],
    ["/admin/products/00000000-0000-4000-8000-000000000000"],
  ])("%s answers 401 without a token", async (path) => {
    const res = await app.request(path);
    expect(res.status).toBe(401);
  });

  test("both admin routes declare 403, so requireStaff is wired not just requireAuth", async () => {
    // A customer's token is valid auth. If a route documented only 401 it
    // would almost certainly be missing requireStaff, and every shopper would
    // be reading cost_price.
    const paths = (await doc()).paths as Record<
      string,
      Record<string, { responses: Record<string, unknown> }>
    >;
    for (const p of ["/admin/products", "/admin/products/{id}"]) {
      expect(paths[p]?.get?.responses["403"]).toBeDefined();
    }
  });

  test("the storefront needs no token at all", async () => {
    // The catalog is public, and a storefront that requires sign-in to
    // browse is not a storefront.
    //
    // Asserted from the document rather than by calling the route. The
    // call reached a real database -- the only test in this suite that
    // did -- so it passed or failed on whether a stack happened to be
    // running, and against an unreachable one it outlived bun's default
    // timeout rather than failing on the thing it was checking.
    const paths = (await doc()).paths as Record<
      string,
      Record<string, { security?: unknown[]; responses: Record<string, unknown> }>
    >;
    const get = paths["/catalog/products"]?.get;
    expect(get).toBeDefined();
    expect(get?.security).toBeUndefined();
    expect(get?.responses["401"]).toBeUndefined();
    expect(get?.responses["403"]).toBeUndefined();
  });
});

describe("caching", () => {
  /**
   * The 200-with-an-ETag path needs real rows, so it lives in the seam
   * suite. What can be proved here is the half that matters more: that
   * nothing outside the catalog is cacheable, and that a catalog request
   * which failed does not get the catalog's header by association.
   */
  test.each([
    ["/health"],
    ["/me"],
    ["/openapi.json"],
    ["/orders/track?orderNumber=X&email=a@b.c"],
  ])("%s is no-store", async (path) => {
    const res = await app.request(path);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("a rejected catalog request is not cached", async () => {
    // Sixty seconds of a cached 400 would outlive the typo that caused it.
    const res = await app.request("/catalog/products?limit=500");
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("etag")).toBeNull();
  });
});
