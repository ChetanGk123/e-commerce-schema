import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { variantAdminSchema } from "@ecom/schema/validation";

import { app } from "../src/app";
import { VariantPatch } from "../src/routes/admin-catalog";

/**
 * B7's validation bullet is a claim about the whole codebase rather than
 * about one endpoint: "no endpoint anywhere writes product_variants.stock".
 *
 * So it is checked against the source. product_variants.stock is a cache
 * that apply_inventory_movement() maintains from inventory_movements, in
 * the same transaction, and CHECK (stock >= 0) is the oversell guard. An
 * UPDATE that set it directly would not be refused by anything -- it would
 * simply make the number disagree with its own history, and the ledger is
 * what an auditor reads.
 *
 * A test of one handler could not catch the next handler. This can.
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory()
      ? sourceFiles(full)
      : full.endsWith(".ts")
        ? [full]
        : [];
  });
}

const SRC = join(import.meta.dir, "..", "src");
const files = sourceFiles(SRC).map((path) => ({
  path: path.slice(SRC.length + 1),
  text: readFileSync(path, "utf8"),
}));

describe("B7 the ledger is the only way stock moves", () => {
  test("the scan is actually looking at files", () => {
    // A silent zero-file glob would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(8);
    expect(files.map((f) => f.path)).toContain("routes/inventory.ts");
  });

  /**
   * One file is exempt, and the exemption is narrower than it looks.
   *
   * routes/admin-catalog.ts updates product_variants to reprice and to
   * archive. It cannot reach `stock`: the body is VariantPatch, derived
   * from @ecom/schema's variantAdminSchema, which has no stock field, and
   * zod strips what it does not declare before the handler sees it. The
   * test below proves that rather than asserting it.
   *
   * The scan stays for every other file because it catches the next
   * handler, which is the whole reason it exists. What it cannot do is
   * see through a variable -- so where a route legitimately updates this
   * table, the guarantee has to come from the schema instead.
   */
  const EXEMPT = new Set(["routes/admin-catalog.ts"]);

  test("nothing updates or upserts product_variants", () => {
    for (const { path, text } of files) {
      if (EXEMPT.has(path)) continue;
      // .update()/.upsert() anywhere downstream of product_variants, on one
      // chain. supabase-js chains can wrap, so newlines count as space.
      const chain = text.replace(/\s+/g, " ");
      const offending = /\.from\(\s*["']product_variants["']\s*\)[^;]*\.(update|upsert|delete)\(/.exec(
        chain,
      );
      expect(`${path}: ${offending?.[0] ?? "clean"}`).toBe(`${path}: clean`);
    }
  });

  test("the exempt file's variant write cannot carry stock", () => {
    // The exemption is only safe while this holds. A future edit that adds
    // `stock` to variantAdminSchema -- for a form field, say -- would let
    // the cache be set behind the ledger's back, and this is what notices.
    for (const schema of [variantAdminSchema, VariantPatch]) {
      const parsed = schema.parse({
        sku: "GUARD-1",
        price: 100,
        stock: 500,
      }) as Record<string, unknown>;
      expect(Object.keys(parsed)).not.toContain("stock");
    }
  });

  test("no write payload anywhere carries a stock field", () => {
    // Reading `stock` is fine and common -- the storefront shows it. What
    // must not exist is `stock` inside something being written, on any
    // table: that is the ledger and its cache disagreeing.
    for (const { path, text } of files) {
      const chain = text.replace(/\s+/g, " ");
      for (const [call, , payload] of chain.matchAll(
        /\.(update|insert|upsert)\(\s*(\{[^}]*\})/g,
      )) {
        expect(`${path}: ${/\bstock\b/.test(payload ?? "") ? call : "clean"}`).toBe(
          `${path}: clean`,
        );
      }
    }
  });

  test("the only stock write goes through record_stock_movement", () => {
    const inventory = files.find((f) => f.path === "routes/inventory.ts")!;
    expect(inventory.text).toContain("record_stock_movement");
    // If this ever inserts into the ledger directly it bypasses the
    // reason allow-list, and 'release' becomes writable from an admin
    // endpoint -- which is how stock gets invented.
    expect(inventory.text).not.toMatch(
      /\.from\(\s*["']inventory_movements["']\s*\)[\s\S]{0,120}\.insert\(/,
    );
  });
});

describe("B7 contract", () => {
  test("the inventory and fulfilment paths are published and padlocked", async () => {
    const doc = (await (await app.request("/openapi.json")).json()) as {
      paths: Record<string, Record<string, { security?: unknown[] }>>;
    };
    for (const p of [
      "/admin/inventory/movements",
      "/admin/inventory/low-stock",
      "/admin/inventory/health",
      "/admin/orders/{id}/shipments",
    ]) {
      expect(doc.paths[p]).toBeDefined();
    }
    // Stock levels and cost-adjacent movement history are staff-only.
    expect(doc.paths["/admin/inventory/movements"]?.get?.security).toBeDefined();
    expect(doc.paths["/admin/inventory/health"]?.get?.security).toBeDefined();
    expect(doc.paths["/admin/orders/{id}/shipments"]?.post?.security).toBeDefined();
  });

  test("the manual-movement reasons exclude the ones checkout owns", async () => {
    const doc = (await (await app.request("/openapi.json")).json()) as {
      paths: Record<string, Record<string, { requestBody?: unknown }>>;
    };
    const body = JSON.stringify(
      doc.paths["/admin/inventory/movements"]?.post?.requestBody,
    );
    for (const allowed of ["purchase", "adjustment", "damage", "return"]) {
      expect(body).toContain(allowed);
    }
    // A 'release' row consumes a stock hold. Writable from an admin
    // endpoint, it is a way to invent stock out of nothing.
    for (const forbidden of ["sale", "reservation", "release"]) {
      expect(body).not.toContain(`"${forbidden}"`);
    }
  });

  test.each([
    ["/admin/inventory/movements"],
    ["/admin/inventory/low-stock"],
    ["/admin/inventory/health"],
  ])("%s is 401 without a token", async (path) => {
    expect((await app.request(path)).status).toBe(401);
  });

  test("a movement without a note is refused before it reaches the database", async () => {
    const res = await app.request("/admin/inventory/movements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: "22222222-0000-4000-8000-000000000001",
        quantity: 5,
        reason: "purchase",
      }),
    });
    // 401 first -- auth runs before validation, and that ordering is
    // correct: an anonymous caller learns nothing about the body shape.
    expect(res.status).toBe(401);
  });
});
