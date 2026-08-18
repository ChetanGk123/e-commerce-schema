import { pincode } from "@ecom/schema/validation";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { throwOnDbError } from "../errors";
import { jsonError, validationHook } from "../schemas";
import { anonClient } from "../supabase";

/**
 * "Do you deliver to 560001, and what does it cost?"
 *
 * One RPC rather than three round trips, because the band predicate has to
 * mirror the rates_no_overlap exclusion constraint exactly -- half-open on
 * both weight and basket value. Reimplementing it here in TypeScript is how a
 * 500g parcel matches two bands and the customer is charged whichever one the
 * planner happened to return first.
 *
 * Checkout (B5) prices shipping through the same function. If it did not, the
 * quote on the cart page and the amount on the invoice could disagree.
 */
const Quote = z
  .object({
    serviceable: z.boolean(),
    codAllowed: z.boolean(),
    courier: z.string().nullable(),
    rate: z.number().nullable(),
    codSurcharge: z.number().nullable(),
    deliveryDays: z.number().int().nullable(),
    freeShipping: z.boolean(),
    rateSource: z.enum(["zone_rate", "flat_rate", "free_shipping"]).nullable(),
  })
  .openapi("ShippingQuote");

interface QuoteRow {
  zone_id: string | null;
  cod_allowed: boolean;
  courier: string | null;
  rate: number;
  cod_surcharge: number;
  delivery_days: number | null;
  free_shipping: boolean;
  rate_source: "zone_rate" | "flat_rate" | "free_shipping";
}

const quote = createRoute({
  method: "get",
  path: "/shipping/quote",
  tags: ["shipping"],
  summary: "Serviceability and shipping price for one pincode",
  description:
    "An unserviceable pincode is a 200 with `serviceable: false`, not a 404 -- the question was answered. Weight and order total pick the rate band; leave them at zero for a bare serviceability check.",
  request: {
    query: z.object({
      pincode,
      weight_grams: z.coerce.number().int().min(0).max(50_000).default(0),
      order_total: z.coerce.number().min(0).max(10_000_000).default(0),
    }),
  },
  responses: {
    200: {
      description: "The quote",
      content: { "application/json": { schema: Quote } },
    },
    400: jsonError("Invalid pincode or parameters"),
  },
});

export const shippingRoute = new OpenAPIHono({ defaultHook: validationHook }).openapi(quote, async (c) => {
  const q = c.req.valid("query");

  const { data, error } = await anonClient().rpc("shipping_quote", {
    p_pincode: q.pincode,
    p_weight_grams: q.weight_grams,
    p_order_total: q.order_total,
  });
  throwOnDbError(error);

  // Zero rows is the function's way of saying "we do not deliver there".
  const row = ((data ?? []) as unknown as QuoteRow[])[0];
  if (!row) {
    return c.json(
      {
        serviceable: false,
        codAllowed: false,
        courier: null,
        rate: null,
        codSurcharge: null,
        deliveryDays: null,
        freeShipping: false,
        rateSource: null,
      },
      200,
    );
  }

  return c.json(
    {
      serviceable: true,
      codAllowed: row.cod_allowed,
      courier: row.courier,
      rate: row.rate,
      codSurcharge: row.cod_surcharge,
      deliveryDays: row.delivery_days,
      freeShipping: row.free_shipping,
      rateSource: row.rate_source,
    },
    200,
  );
});
