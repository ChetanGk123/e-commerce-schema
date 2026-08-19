import { discountAdminSchema } from "@ecom/schema/validation";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { requireAuth, requireStaff } from "../auth";
import { throwOnDbError } from "../errors";
import { jsonError, pageQuery, validationHook } from "../schemas";

/**
 * Discounts, which checkout has been able to apply since B5 and nothing
 * could create.
 *
 * `checkout()` takes p_coupon_code and enforce_discount_limits() guards
 * the redemption race, so the hard part has been done and tested for
 * three phases. The codes themselves were inserted by hand.
 *
 * WHAT IS NOT WRITABLE HERE, and it is the important part: `used_count`.
 * It is incremented in the same transaction as the redemption row, and
 * `discounts_within_max_uses` is the CHECK that actually stops a
 * single-use code being claimed twice by concurrent checkouts. An
 * endpoint that let someone set it could hand out a code that had
 * already been spent, or wind one back after the fact. It is not in
 * discountAdminSchema, and it is not added here.
 */
const DiscountRow = z
  .object({
    id: z.string().uuid(),
    code: z.string(),
    description: z.string().nullable(),
    kind: z.enum(["percent", "fixed", "free_shipping"]),
    value: z.number(),
    appliesTo: z.enum(["order", "collection", "product"]),
    collectionId: z.string().uuid().nullable(),
    productId: z.string().uuid().nullable(),
    minOrderTotal: z.number().nullable(),
    maxUses: z.number().int().nullable(),
    maxUsesPerCustomer: z.number().int().nullable(),
    /** Read-only, and the reason this endpoint cannot write it. */
    usedCount: z.number().int(),
    startsAt: z.string(),
    endsAt: z.string().nullable(),
    isActive: z.boolean(),
  })
  .openapi("Discount");

interface Row {
  id: string;
  code: string;
  description: string | null;
  kind: "percent" | "fixed" | "free_shipping";
  value: number;
  applies_to: "order" | "collection" | "product";
  collection_id: string | null;
  product_id: string | null;
  min_order_total: number | null;
  max_uses: number | null;
  max_uses_per_customer: number | null;
  used_count: number;
  starts_at: string;
  ends_at: string | null;
  is_active: boolean;
}

const COLUMNS =
  "id, code, description, kind, value, applies_to, collection_id, product_id, min_order_total, max_uses, max_uses_per_customer, used_count, starts_at, ends_at, is_active";

const present = (r: Row) => ({
  id: r.id,
  code: r.code,
  description: r.description,
  kind: r.kind,
  value: Number(r.value),
  appliesTo: r.applies_to,
  collectionId: r.collection_id,
  productId: r.product_id,
  minOrderTotal: r.min_order_total === null ? null : Number(r.min_order_total),
  maxUses: r.max_uses,
  maxUsesPerCustomer: r.max_uses_per_customer,
  usedCount: r.used_count,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  isActive: r.is_active,
});

/** Everything except the code, which is the one thing a live code cannot change. */
const DiscountPatch = discountAdminSchema
  .innerType()
  .omit({ code: true })
  .partial()
  .extend({ is_active: z.boolean().optional() })
  .refine((b) => Object.keys(b).length > 0, {
    message: "Send at least one field to change",
  });

const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

const list = createRoute({
  method: "get",
  path: "/admin/discounts",
  tags: ["admin", "discounts"],
  summary: "Every code, spent or not",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: { query: z.object({ ...pageQuery, active: z.enum(["true", "false"]).optional() }) },
  responses: {
    200: {
      description: "Codes, newest first",
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(DiscountRow),
            total: z.number().int().nullable(),
            limit: z.number().int(),
            offset: z.number().int(),
          }),
        },
      },
    },
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
  },
});

const create = createRoute({
  method: "post",
  path: "/admin/discounts",
  tags: ["admin", "discounts"],
  summary: "Create a code",
  description:
    "`code` is case-insensitive (citext) and unique, so a duplicate is a 409 whatever case it is sent in.\\n\\nThe body's rules are the schema's: a percentage over 100 is refused, free shipping must carry value 0, a collection or product discount must name one, and an end date must follow its start.\\n\\n`used_count` cannot be set here, ever. It moves only in the transaction that redeems the code.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: { body: { content: { "application/json": { schema: discountAdminSchema } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: DiscountRow } } },
    400: jsonError("The body does not validate"),
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
    409: jsonError("That code already exists"),
  },
});

const update = createRoute({
  method: "patch",
  path: "/admin/discounts/{id}",
  tags: ["admin", "discounts"],
  summary: "Change or switch off a code",
  description:
    "Partial. `is_active: false` is how a code is withdrawn -- deleting one would take its redemption history with it, and that history is what explains a discounted order months later.\\n\\nThe code itself cannot be changed: customers already have the old one, and renaming it silently invalidates every place it was printed.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { "application/json": { schema: DiscountPatch } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: DiscountRow } } },
    400: jsonError("The body does not validate, or is empty"),
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
    404: jsonError("No such discount"),
    409: jsonError("Lowering max_uses below what has already been spent"),
  },
});

export const discountsRoute = new OpenAPIHono({ defaultHook: validationHook })
  .openapi(list, async (c) => {
    const { limit, offset, active } = c.req.valid("query");
    let q = c
      .get("caller")
      .db.from("discounts")
      .select(COLUMNS, { count: "exact" });
    if (active) q = q.eq("is_active", active === "true");

    const { data, error, count } = await q
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    throwOnDbError(error);

    return c.json(
      {
        items: ((data ?? []) as unknown as Row[]).map(present),
        total: count ?? null,
        limit,
        offset,
      },
      200,
    );
  })

  // caller.db, not the service key: trg_audit_discounts records who
  // created a code and who withdrew one, and it takes that from
  // auth.uid(). A discount is money, so the trail matters.
  .openapi(create, async (c) => {
    const { data, error } = await c
      .get("caller")
      .db.from("discounts")
      .insert(defined(c.req.valid("json")))
      .select(COLUMNS)
      .single();
    throwOnDbError(error);

    const row = data as unknown as Row;
    c.get("log")?.info({ code: row.code }, "discounts.created");
    return c.json(present(row), 201);
  })

  .openapi(update, async (c) => {
    const { id } = c.req.valid("param");
    const patch = defined(c.req.valid("json"));

    const { data, error } = await c
      .get("caller")
      .db.from("discounts")
      .update(patch)
      .eq("id", id)
      .select(COLUMNS)
      .maybeSingle();
    throwOnDbError(error);
    if (!data) throw new HTTPException(404, { message: "No such discount" });

    c.get("log")?.info({ id, fields: Object.keys(patch) }, "discounts.updated");
    return c.json(present(data as unknown as Row), 200);
  });
