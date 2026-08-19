import { describe, expect, test } from "bun:test";

import { mapDatabaseError, throwOnDbError } from "../src/errors";

/**
 * These strings are not invented. Each was produced by provoking the rule
 * against the running self-hosted Supabase and copying what Postgres said, so
 * a constraint rename breaks this file rather than silently degrading every
 * error to a 500.
 */
const REAL = {
  oversell:
    'new row for relation "product_variants" violates check constraint "product_variants_stock_check"',
  totals:
    'new row for relation "orders" violates check constraint "orders_totals_balance"',
  phone:
    'new row for relation "customers" violates check constraint "customers_phone_e164"',
  slug: 'new row for relation "products" violates check constraint "products_slug_format"',
  reservation:
    'new row for relation "inventory_movements" violates check constraint "inv_reservation_expires"',
  appendOnly: "inventory_movements is append-only: UPDATE not allowed",
  invoiceEdit:
    "invoices are immutable: only pdf_url and the e-invoice fields may be updated",
  customerDelete:
    'update or delete on table "customers" violates foreign key constraint "credit_ledger_customer_id_fkey" on table "credit_ledger"',
  rls: 'new row violates row-level security policy for table "reviews"',
} as const;

describe("B2 error mapping — real Postgres messages", () => {
  test("overselling is 409 with copy a shopper can act on", () => {
    const m = mapDatabaseError({ message: REAL.oversell });
    expect(m).toEqual({
      status: 409,
      code: "insufficient_stock",
      message: "Not enough stock for one or more items.",
    });
  });

  test("unbalanced totals are 422", () => {
    expect(mapDatabaseError({ message: REAL.totals })?.status).toBe(422);
  });

  test("editing a ledger is 409 and says to add a correcting entry", () => {
    const m = mapDatabaseError({ message: REAL.appendOnly });
    expect(m?.status).toBe(409);
    expect(m?.message).toContain("correcting entry");
  });

  test("editing an invoice points at a credit note", () => {
    expect(mapDatabaseError({ message: REAL.invoiceEdit })?.message).toContain(
      "credit note",
    );
  });

  test("deleting a customer with store credit explains anonymising", () => {
    const m = mapDatabaseError({ message: REAL.customerDelete });
    expect(m?.code).toBe("customer_not_erasable");
  });

  test("an RLS refusal is 403, not 500", () => {
    expect(mapDatabaseError({ message: REAL.rls })?.status).toBe(403);
  });

  test.each([
    ["phone", REAL.phone, "invalid_phone"],
    ["slug", REAL.slug, "invalid_slug"],
    ["reservation expiry", REAL.reservation, "reservation_needs_expiry"],
  ])("%s maps to %s", (_label, message, code) => {
    expect(mapDatabaseError({ message })?.code).toBe(code);
  });

  test("no mapped message ever echoes the constraint name", () => {
    // The whole point: a caller learns what to do, not what the table is called.
    for (const message of Object.values(REAL)) {
      const mapped = mapDatabaseError({ message });
      if (!mapped) continue;
      expect(mapped.message).not.toContain("constraint");
      expect(mapped.message).not.toContain("relation");
      expect(mapped.message).not.toContain("_check");
    }
  });

  test("a missing identity is a 500 -- our bug, not the caller's", () => {
    const m = mapDatabaseError({
      message:
        'null value in column "id" of relation "customers" violates not-null constraint',
    });
    expect(m?.status).toBe(500);
    expect(m?.code).toBe("identity_not_supplied");
  });

  test("an unrecognised error maps to nothing, so callers get a support code", () => {
    expect(
      mapDatabaseError({ message: "something nobody predicted" }),
    ).toBeNull();
  });

  test("throwOnDbError is a no-op on success", () => {
    expect(() => throwOnDbError(null)).not.toThrow();
  });

  test("throwOnDbError refuses to let a database error pass silently", () => {
    // supabase-js RETURNS errors rather than throwing them, which is exactly
    // how a refusal gets reported to the customer as a success.
    expect(() => throwOnDbError({ message: REAL.oversell })).toThrow();
    expect(() => throwOnDbError({ message: "unrecognised" })).toThrow();
  });
});
