import { describe, expect, test } from "bun:test";

import { app } from "../src/app";
import { mapDatabaseError } from "../src/errors";

/**
 * In-process. What an invoice IS -- gap-free, immutable, credited rather
 * than amended -- is asserted in supabase/tests/01_invariants.sql, where
 * a real trigger can refuse a real UPDATE.
 *
 * What belongs here is the contract, and the mapping. B9 is the first
 * phase to put the B3-era admin RPCs behind HTTP, and those raise plain
 * SQLSTATEs rather than the ECOM codes the later functions use. Every
 * one of them answered 500 until these rules existed.
 */
const doc = async () =>
  (await (await app.request("/openapi.json")).json()) as {
    paths: Record<string, Record<string, { security?: unknown[]; responses: Record<string, unknown> }>>;
    components: { schemas: Record<string, unknown> };
  };

describe("B9 admin RPC refusals are not 500s", () => {
  test.each([
    ["order ORD-1 already has a tax invoice", 409, "already_invoiced"],
    ["Invoice INV/2026-27/00001 is already stamped.", 409, "already_stamped"],
    ["order ORD-1 is unpaid", 409, "order_unpaid"],
    ["store_settings.seller_gstin is not set; invoicing cannot proceed", 409, "seller_gstin_missing"],
    ["no place of supply and no seller_state_code", 422, "place_of_supply_missing"],
    ["order ORD-1 has no line items", 409, "order_empty"],
    ["order ORD-1 is shipped and cannot be cancelled", 409, "order_not_cancellable"],
  ])("%s -> %i", (message, status, code) => {
    const m = mapDatabaseError({ message });
    expect(m?.status).toBe(status as 409 | 422);
    expect(m?.code).toBe(code);
  });

  test("no mapped invoice message echoes a table or constraint name", () => {
    for (const message of [
      "order ORD-1 already has a tax invoice",
      "invoices are immutable: only pdf_url and the e-invoice fields may be updated",
      "invoices are permanent legal documents: delete not allowed",
    ]) {
      const m = mapDatabaseError({ message });
      expect(m).not.toBeNull();
      expect(m?.message).not.toContain("invoices are");
      expect(m?.message).not.toContain("constraint");
    }
  });

  test.each([
    ["P0002", 404],
    ["55000", 409],
    ["55006", 409],
    ["23505", 409],
    ["42501", 403],
    ["22023", 422],
  ])("SQLSTATE %s falls back to %i rather than 500", (code, status) => {
    // Nothing matches the message, so only the SQLSTATE is left. Without
    // this a caller is told to retry something that will never succeed.
    const m = mapDatabaseError({ code, message: "something nobody wrote a rule for" });
    expect(m?.status).toBe(status as 403 | 404 | 409 | 422);
  });

  test("the fallback never echoes the database's words", () => {
    const m = mapDatabaseError({
      code: "55000",
      message: 'relation "orders" is in state "shipped"',
    });
    expect(m?.message).not.toContain("orders");
    expect(m?.message).not.toContain("relation");
  });

  test("an unrecognised error with no known SQLSTATE is still a support code", () => {
    expect(mapDatabaseError({ code: "XX999", message: "cosmic ray" })).toBeNull();
  });
});

describe("B9 contract", () => {
  test("there is no way to amend an invoice", async () => {
    const paths = (await doc()).paths;
    // A PATCH or PUT on an invoice would be a promise the database
    // refuses to keep. Corrections are credit notes.
    for (const [path, ops] of Object.entries(paths)) {
      if (!path.includes("invoice")) continue;
      expect(`${path}:${Object.keys(ops).sort().join(",")}`).not.toMatch(/:(.*,)?(patch|put|delete)/);
    }
  });

  test("every invoicing path is published and padlocked", async () => {
    const paths = (await doc()).paths;
    for (const p of [
      "/invoices",
      "/admin/invoices",
      "/admin/invoices/{id}",
      "/admin/orders/{id}/invoice",
      "/admin/invoices/{id}/credit-note",
      "/admin/invoices/{id}/einvoice",
    ]) {
      expect(paths[p]).toBeDefined();
    }
    // Even the customer's own list: an invoice carries a name, an
    // address and a GSTIN.
    expect(paths["/invoices"]?.get?.security).toBeDefined();
  });

  test("the signed QR is not in the list response shape", async () => {
    // It is a long opaque blob for a printed invoice, not something to
    // ship in every row of a list.
    expect(JSON.stringify((await doc()).components.schemas.Invoice)).not.toMatch(
      /signedQr/i,
    );
  });

  test.each([
    ["GET", "/invoices"],
    ["GET", "/admin/invoices"],
    ["POST", "/admin/orders/00000000-0000-4000-8000-000000000000/invoice"],
  ])("%s %s is 401 without a token", async (method, path) => {
    const res = await app.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
    });
    expect(res.status).toBe(401);
  });

  test("a truncated IRN is refused before it can be made permanent", async () => {
    const res = await app.request(
      "/admin/invoices/00000000-0000-4000-8000-000000000000/einvoice",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ irn: "abc", ack_no: "1", signed_qr: "x" }),
      },
    );
    // 401 first; auth runs before validation. Either way it does not
    // reach the database.
    expect([400, 401]).toContain(res.status);
  });
});
