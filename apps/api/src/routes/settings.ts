import { ROLES } from "@ecom/schema/enums";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireAuth, requireRole, requireStaff } from "../auth";
import { throwOnDbError } from "../errors";
import { jsonError, validationHook } from "../schemas";

/**
 * The one row in store_settings.
 *
 * `docs/setup.md` Step 5 sets these by SQL at install and there has been
 * no way to change them since -- which means the GSTIN printed on every
 * invoice, and the switch that turns cash on delivery off, were both
 * beyond reach of anyone without database access.
 *
 * `config` (jsonb) is deliberately NOT exposed. Nothing in this service
 * reads it, and the README is explicit that it is for non-secret
 * configuration only; an HTTP endpoint accepting arbitrary JSON into it
 * is an invitation to put a gateway key there. Add it when something
 * actually needs to read it.
 */
const Settings = z
  .object({
    storeName: z.string(),
    supportEmail: z.string().nullable(),
    supportPhone: z.string().nullable(),
    sellerGstin: z.string().nullable(),
    sellerStateCode: z.string().nullable(),
    freeShippingAbove: z.number().nullable(),
    flatShippingRate: z.number().nullable(),
    codEnabled: z.boolean(),
    updatedAt: z.string(),
  })
  .openapi("StoreSettings");

interface Row {
  store_name: string;
  support_email: string | null;
  support_phone: string | null;
  seller_gstin: string | null;
  seller_state_code: string | null;
  free_shipping_above: number | null;
  flat_shipping_rate: number | null;
  cod_enabled: boolean;
  updated_at: string;
}

const COLUMNS =
  "store_name, support_email, support_phone, seller_gstin, seller_state_code, free_shipping_above, flat_shipping_rate, cod_enabled, updated_at";

const present = (r: Row) => ({
  storeName: r.store_name,
  supportEmail: r.support_email,
  supportPhone: r.support_phone,
  sellerGstin: r.seller_gstin,
  sellerStateCode: r.seller_state_code,
  freeShippingAbove: r.free_shipping_above === null ? null : Number(r.free_shipping_above),
  flatShippingRate: r.flat_shipping_rate === null ? null : Number(r.flat_shipping_rate),
  codEnabled: r.cod_enabled,
  updatedAt: r.updated_at,
});

/**
 * GSTIN and the state code are checked here as well as in the database,
 * because getting them wrong is not caught by anything downstream: the
 * invoice is issued, numbered gap-free, and is a legal document by the
 * time anyone notices the number on it is malformed.
 */
const SettingsPatch = z
  .object({
    store_name: z.string().min(1).max(120).optional(),
    support_email: z.string().email().max(254).optional(),
    support_phone: z.string().max(20).optional(),
    seller_gstin: z
      .string()
      .regex(
        /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/,
        "Not a valid 15-character GSTIN",
      )
      .optional(),
    seller_state_code: z
      .string()
      .regex(/^[0-9]{2}$/, "Two digits, and it must match the GSTIN's first two")
      .optional(),
    free_shipping_above: z.number().nonnegative().optional(),
    flat_shipping_rate: z.number().nonnegative().optional(),
    cod_enabled: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: "Send at least one field to change",
  })
  .refine(
    (b) =>
      !b.seller_gstin ||
      !b.seller_state_code ||
      b.seller_gstin.startsWith(b.seller_state_code),
    {
      path: ["seller_state_code"],
      message: "Must match the first two characters of the GSTIN",
    },
  );

const read = createRoute({
  method: "get",
  path: "/admin/settings",
  tags: ["admin", "settings"],
  summary: "Store configuration",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  responses: {
    200: { description: "The row", content: { "application/json": { schema: Settings } } },
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
  },
});

const update = createRoute({
  method: "patch",
  path: "/admin/settings",
  tags: ["admin", "settings"],
  summary: "Change store configuration",
  description:
    "Owner and admin only. `seller_gstin` and `seller_state_code` appear on every invoice this store issues, and invoices are immutable once written -- a wrong value is not something a later edit can repair, so both are format-checked here and must agree with each other.\\n\\n`cod_enabled: false` turns cash on delivery off at checkout for the whole store.\\n\\n`config` is not writable through this API. See the route source for why.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff, requireRole(ROLES.OWNER, ROLES.ADMIN)] as const,
  request: { body: { content: { "application/json": { schema: SettingsPatch } } } },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: Settings } } },
    400: jsonError("The body does not validate, or is empty"),
    401: jsonError("Missing or invalid token"),
    403: jsonError("Not staff, or not owner/admin"),
  },
});

const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export const settingsRoute = new OpenAPIHono({ defaultHook: validationHook })
  .openapi(read, async (c) => {
    const { data, error } = await c
      .get("caller")
      .db.from("store_settings")
      .select(COLUMNS)
      .eq("id", 1)
      .single();
    throwOnDbError(error);
    return c.json(present(data as unknown as Row), 200);
  })

  .openapi(update, async (c) => {
    // caller.db: trg_audit_settings takes staff_id from auth.uid(), and a
    // changed GSTIN is exactly the edit someone will need to trace.
    const { data, error } = await c
      .get("caller")
      .db.from("store_settings")
      .update(defined(c.req.valid("json")))
      .eq("id", 1)
      .select(COLUMNS)
      .single();
    throwOnDbError(error);

    c.get("log")?.info(
      { fields: Object.keys(c.req.valid("json")) },
      "settings.updated",
    );
    return c.json(present(data as unknown as Row), 200);
  });
