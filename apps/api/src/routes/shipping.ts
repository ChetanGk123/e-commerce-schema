import { pincode } from "@ecom/schema/validation";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { requireAuth, requireStaff } from "../auth";
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


/* ---------- admin: who we deliver to, and for how much ---------- */

/**
 * The tables shipping_quote() reads, made writable.
 *
 * `setup.md` Step 6 loads zones, rates and pincodes by SQL at install.
 * After that a store could not add a pincode it had started delivering
 * to, or change a rate, without a database client -- while the quote
 * endpoint answered confidently from whatever was loaded that day.
 *
 * The overlap rule is the database's, not this file's.
 * `rates_no_overlap` is a GiST exclusion constraint: exactly one active
 * rate may match any (zone, weight, basket value) point. Trying to add a
 * band that straddles an existing one is refused, and errors.ts already
 * had the mapping for it before anything could provoke it.
 */
const Zone = z
  .object({ id: z.string().uuid(), name: z.string(), position: z.number().int() })
  .openapi("ShippingZone");

const Rate = z
  .object({
    id: z.string().uuid(),
    zoneId: z.string().uuid(),
    minWeightGrams: z.number().int(),
    maxWeightGrams: z.number().int().nullable(),
    minOrderTotal: z.number(),
    maxOrderTotal: z.number().nullable(),
    rate: z.number(),
    codSurcharge: z.number(),
    deliveryDays: z.number().int().nullable(),
    isActive: z.boolean(),
  })
  .openapi("ShippingRate");

const RateBody = z
  .object({
    zone_id: z.string().uuid(),
    min_weight_grams: z.number().int().nonnegative().default(0),
    max_weight_grams: z.number().int().positive().nullable().optional(),
    min_order_total: z.number().nonnegative().default(0),
    max_order_total: z.number().nonnegative().nullable().optional(),
    rate: z.number().nonnegative(),
    cod_surcharge: z.number().nonnegative().default(0),
    delivery_days: z.number().int().positive().optional(),
    is_active: z.boolean().optional(),
  })
  .refine(
    (b) => b.max_weight_grams == null || b.max_weight_grams > b.min_weight_grams,
    { path: ["max_weight_grams"], message: "Must be above min_weight_grams" },
  )
  .refine(
    (b) => b.max_order_total == null || b.max_order_total > b.min_order_total,
    { path: ["max_order_total"], message: "Must be above min_order_total" },
  );

interface ZoneRow { id: string; name: string; position: number }
interface RateRow {
  id: string;
  zone_id: string;
  min_weight_grams: number;
  max_weight_grams: number | null;
  min_order_total: number;
  max_order_total: number | null;
  rate: number;
  cod_surcharge: number;
  delivery_days: number | null;
  is_active: boolean;
}

const RATE_COLUMNS =
  "id, zone_id, min_weight_grams, max_weight_grams, min_order_total, max_order_total, rate, cod_surcharge, delivery_days, is_active";

const presentRate = (r: RateRow) => ({
  id: r.id,
  zoneId: r.zone_id,
  minWeightGrams: r.min_weight_grams,
  maxWeightGrams: r.max_weight_grams,
  minOrderTotal: Number(r.min_order_total),
  maxOrderTotal: r.max_order_total === null ? null : Number(r.max_order_total),
  rate: Number(r.rate),
  codSurcharge: Number(r.cod_surcharge),
  deliveryDays: r.delivery_days,
  isActive: r.is_active,
});

const listZones = createRoute({
  method: "get",
  path: "/admin/shipping/zones",
  tags: ["admin", "shipping"],
  summary: "Delivery zones",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  responses: {
    200: {
      description: "Zones with their rates",
      content: {
        "application/json": {
          schema: z.object({ items: z.array(Zone.extend({ rates: z.array(Rate) })) }),
        },
      },
    },
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
  },
});

const createZone = createRoute({
  method: "post",
  path: "/admin/shipping/zones",
  tags: ["admin", "shipping"],
  summary: "Add a zone",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(2).max(80),
            position: z.number().int().nonnegative().default(0),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: Zone } } },
    400: jsonError("The body does not validate"),
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
    409: jsonError("A zone with that name already exists"),
  },
});

const createRate = createRoute({
  method: "post",
  path: "/admin/shipping/rates",
  tags: ["admin", "shipping"],
  summary: "Add a rate band",
  description:
    "Bands are half-open on both weight and basket value, matching `rates_no_overlap` exactly. A band that overlaps an existing **active** one for the same zone is refused by the database -- deactivate the old one first, or narrow the new one.\n\n`max_weight_grams` and `max_order_total` may be null, meaning no cap.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: { body: { content: { "application/json": { schema: RateBody } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: Rate } } },
    400: jsonError("The body does not validate"),
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
    409: jsonError("Overlaps an existing active band for this zone"),
  },
});

const updateRate = createRoute({
  method: "patch",
  path: "/admin/shipping/rates/{id}",
  tags: ["admin", "shipping"],
  summary: "Change or retire a rate band",
  description:
    "`is_active: false` retires a band. Deactivating is how you make room for a replacement, since the overlap constraint only applies to active rows.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              rate: z.number().nonnegative().optional(),
              cod_surcharge: z.number().nonnegative().optional(),
              delivery_days: z.number().int().positive().optional(),
              is_active: z.boolean().optional(),
            })
            .refine((b) => Object.keys(b).length > 0, {
              message: "Send at least one field to change",
            }),
        },
      },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: Rate } } },
    400: jsonError("The body does not validate, or is empty"),
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
    404: jsonError("No such rate"),
    409: jsonError("Reactivating it would overlap another active band"),
  },
});

const upsertPincode = createRoute({
  method: "put",
  path: "/admin/shipping/pincodes/{pincode}",
  tags: ["admin", "shipping"],
  summary: "Start (or stop) delivering to a PIN code",
  description:
    "An unlisted PIN code is unserviceable: checkout refuses it outright, so this is the switch that opens a new area. Idempotent -- PUT the same code twice and the second call updates it.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ pincode }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            zone_id: z.string().uuid(),
            cod_allowed: z.boolean().default(true),
            courier: z.string().max(60).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Serviceable",
      content: {
        "application/json": {
          schema: z.object({
            pincode: z.string(),
            zoneId: z.string().uuid().nullable(),
            codAllowed: z.boolean(),
            courier: z.string().nullable(),
          }),
        },
      },
    },
    400: jsonError("Not a valid PIN code, or the body does not validate"),
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
    404: jsonError("No such zone"),
  },
});


export const adminShippingRoute = new OpenAPIHono({ defaultHook: validationHook })
  .openapi(listZones, async (c) => {
    const db = c.get("caller").db;
    const [zones, rates] = await Promise.all([
      db.from("shipping_zones").select("id, name, position").order("position"),
      db.from("shipping_rates").select(RATE_COLUMNS).order("min_weight_grams"),
    ]);
    throwOnDbError(zones.error);
    throwOnDbError(rates.error);

    const byZone = new Map<string, RateRow[]>();
    for (const r of (rates.data ?? []) as unknown as RateRow[]) {
      byZone.set(r.zone_id, [...(byZone.get(r.zone_id) ?? []), r]);
    }

    return c.json(
      {
        items: ((zones.data ?? []) as unknown as ZoneRow[]).map((z) => ({
          ...z,
          rates: (byZone.get(z.id) ?? []).map(presentRate),
        })),
      },
      200,
    );
  })

  .openapi(createZone, async (c) => {
    const { data, error } = await c
      .get("caller")
      .db.from("shipping_zones")
      .insert(c.req.valid("json"))
      .select("id, name, position")
      .single();
    throwOnDbError(error);
    return c.json(data as unknown as ZoneRow, 201);
  })

  .openapi(createRate, async (c) => {
    const { data, error } = await c
      .get("caller")
      .db.from("shipping_rates")
      .insert(c.req.valid("json"))
      .select(RATE_COLUMNS)
      .single();
    // 23P01 from rates_no_overlap lands here, and errors.ts already knew
    // the constraint by name before anything could provoke it.
    throwOnDbError(error);
    return c.json(presentRate(data as unknown as RateRow), 201);
  })

  .openapi(updateRate, async (c) => {
    const { id } = c.req.valid("param");
    const { data, error } = await c
      .get("caller")
      .db.from("shipping_rates")
      .update(c.req.valid("json"))
      .eq("id", id)
      .select(RATE_COLUMNS)
      .maybeSingle();
    throwOnDbError(error);
    if (!data) throw new HTTPException(404, { message: "No such rate" });
    return c.json(presentRate(data as unknown as RateRow), 200);
  })

  .openapi(upsertPincode, async (c) => {
    const { pincode: code } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = c.get("caller").db;

    // The FK would refuse an unknown zone as a 23503, which reads like a
    // server fault rather than "you named a zone that does not exist".
    const zone = await db
      .from("shipping_zones")
      .select("id")
      .eq("id", body.zone_id)
      .maybeSingle();
    throwOnDbError(zone.error);
    if (!zone.data) throw new HTTPException(404, { message: "No such zone" });

    const { data, error } = await db
      .from("serviceable_pincodes")
      .upsert({ pincode: code, ...body, updated_at: new Date().toISOString() })
      .select("pincode, zone_id, cod_allowed, courier")
      .single();
    throwOnDbError(error);

    const row = data as unknown as {
      pincode: string;
      zone_id: string | null;
      cod_allowed: boolean;
      courier: string | null;
    };
    c.get("log")?.info({ pincode: code }, "shipping.pincode_upserted");
    return c.json(
      {
        pincode: row.pincode,
        zoneId: row.zone_id,
        codAllowed: row.cod_allowed,
        courier: row.courier,
      },
      200,
    );
  });
