import { createHash } from "node:crypto";

import { checkoutSchema } from "@ecom/schema/validation";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { optionalAuth } from "../auth";
import { throwOnDbError } from "../errors";
import { jsonError, validationHook } from "../schemas";
import { anonClient } from "../supabase";

/**
 * Placing an order.
 *
 * The handler is thin on purpose. Everything that must not be interleaved --
 * claiming the idempotency key, reserving stock, writing the order, counting
 * the coupon, queueing the confirmation -- happens inside checkout() in one
 * transaction, because supabase-js has none and a half-applied checkout is
 * how stock goes missing and coupons get spent twice.
 *
 * This route does three things the database cannot: validate the request
 * shape, hash it for the idempotency check, and choose the client.
 *
 * That last one is not cosmetic. checkout() is SECURITY DEFINER and takes the
 * customer from auth.uid(), never from a parameter -- so the caller's token
 * has to reach Postgres. Running this on the service key would silently make
 * every order a guest order, with no customer_id, invisible in "my orders",
 * and unattached to the account that paid.
 */
const CheckoutResponse = z
  .object({
    orderId: z.string().uuid(),
    orderNumber: z.string(),
    status: z.string(),
    paymentId: z.string().uuid(),
    paymentMethod: z.enum(["razorpay", "cod"]),
    currency: z.string(),
    subtotal: z.number(),
    discountTotal: z.number(),
    shippingTotal: z.number(),
    taxTotal: z.number(),
    grandTotal: z.number(),
    /** When the stock hold lapses if payment has not completed. */
    reservedUntil: z.string(),
  })
  .openapi("CheckoutResponse");

interface CheckoutRow {
  order_id: string;
  order_number: string;
  status: string;
  payment_id: string;
  payment_method: "razorpay" | "cod";
  currency: string;
  subtotal: number;
  discount_total: number;
  shipping_total: number;
  tax_total: number;
  grand_total: number;
  reserved_until: string;
}

/**
 * A stable fingerprint of the request.
 *
 * idempotency_keys.request_hash exists to catch the same key sent with a
 * different basket, which is a client bug that replaying the first response
 * would hide -- and hide by charging for the wrong order. Keys are sorted so
 * two encodings of the same body agree.
 */
export function requestHash(body: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, canonical(val)]),
      );
    }
    return v;
  };
  return createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex");
}

const checkout = createRoute({
  method: "post",
  path: "/checkout",
  tags: ["checkout"],
  summary: "Place an order",
  description:
    "Requires an Idempotency-Key header. Replaying the same key with the same body returns the first response and creates nothing; replaying it with a different body is a 409, because the alternative is charging for a basket the customer never confirmed.\n\nPrices, discounts, shipping and tax are all recomputed from the database. The body says which variants and how many; it does not say what they cost.",
  security: [{ bearerAuth: [] }],
  middleware: [optionalAuth] as const,
  request: {
    headers: z.object({
      "idempotency-key": z
        .string()
        .min(8)
        .max(255)
        .openapi({ description: "Any unique string per attempt; a uuid is fine." }),
    }),
    body: {
      content: { "application/json": { schema: checkoutSchema } },
    },
  },
  responses: {
    201: {
      description: "Order placed, awaiting payment",
      content: { "application/json": { schema: CheckoutResponse } },
    },
    400: jsonError("Invalid body or missing Idempotency-Key"),
    401: jsonError("A token was sent but is not valid"),
    409: jsonError(
      "Conflict: key replayed with a different body, a checkout already in flight, an item that went out of stock, or a spent coupon",
    ),
    422: jsonError(
      "Refused: unserviceable pincode, COD unavailable, or an invalid coupon",
    ),
  },
});

export const checkoutRoute = new OpenAPIHono({
  defaultHook: validationHook,
}).openapi(checkout, async (c) => {
  const body = c.req.valid("json");
  const key = c.req.valid("header")["idempotency-key"];
  const caller = c.get("caller");

  // Guests get the anon client. Either way the caller's own identity reaches
  // Postgres, which is where checkout() reads it from.
  const db = caller?.db ?? anonClient();
  const cartId = c.req.header("X-Cart-Id");

  const { data, error } = await db.rpc("checkout", {
    p_idempotency_key: key,
    p_request_hash: requestHash(body),
    p_email: body.email,
    p_phone: body.contact_phone,
    p_items: body.items,
    p_shipping_address: body.shipping_address,
    p_payment_method: body.payment_method,
    p_coupon_code: body.coupon_code ?? null,
    p_cart_id: cartId ?? null,
  });
  throwOnDbError(error);

  const row = data as unknown as CheckoutRow | null;
  if (!row) {
    // Should be unreachable: the function either returns a row or raises.
    throw new HTTPException(500, {
      message: "Checkout returned nothing",
      cause: { code: "checkout_empty" },
    });
  }

  c.get("log")?.info(
    { orderNumber: row.order_number, method: row.payment_method },
    "checkout.placed",
  );

  return c.json(
    {
      orderId: row.order_id,
      orderNumber: row.order_number,
      status: row.status,
      paymentId: row.payment_id,
      paymentMethod: row.payment_method,
      currency: row.currency,
      subtotal: Number(row.subtotal),
      discountTotal: Number(row.discount_total),
      shippingTotal: Number(row.shipping_total),
      taxTotal: Number(row.tax_total),
      grandTotal: Number(row.grand_total),
      reservedUntil: row.reserved_until,
    },
    201,
  );
});
