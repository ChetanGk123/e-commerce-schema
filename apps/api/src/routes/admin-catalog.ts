import { productAdminSchema, variantAdminSchema } from "@ecom/schema/validation";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { requireAuth, requireStaff } from "../auth";
import { throwOnDbError } from "../errors";
import { PAGE_MAX, jsonError, pageQuery, validationHook } from "../schemas";
import {
  deleteObject,
  pathFromUrl,
  sniffImageType,
  storageConfigured,
  uploadImage,
} from "../storage";

/**
 * Admin catalog reads and writes.
 *
 * The mirror image of routes/catalog.ts, and the differences are the whole
 * point:
 *
 *   - caller.db, not anonClient(). Every read runs as the signed-in staff
 *     member so auth.uid() is populated -- which matters the moment these
 *     screens gain a write, because audit_row() takes staff_id from it.
 *   - product_variants, not storefront_variants. That is where cost_price,
 *     low_stock_threshold and archived variants live.
 *   - No status filter of its own. staff_all lets staff see drafts; asking for
 *     `status=draft` narrows, it does not unlock.
 */
const ADMIN_PRODUCT_COLUMNS =
  "id, slug, name, brand, description, category_id, hsn_code, gst_rate, status, created_at, updated_at";

const ADMIN_VARIANT_COLUMNS =
  "id, product_id, sku, title, description, specs, price, compare_at_price, cost_price, currency, stock, low_stock_threshold, weight_grams, barcode, is_default, status, is_purchasable, options_signature, created_at, updated_at";

interface AdminProductRow {
  id: string;
  slug: string;
  name: string;
  brand: string | null;
  description: string | null;
  category_id: string | null;
  hsn_code: string | null;
  gst_rate: number | null;
  status: "draft" | "active" | "archived";
  created_at: string;
  updated_at: string;
}

interface AdminVariantRow {
  id: string;
  product_id: string;
  sku: string;
  title: string | null;
  description: string | null;
  specs: Record<string, unknown>;
  price: number;
  compare_at_price: number | null;
  cost_price: number | null;
  currency: string;
  stock: number;
  low_stock_threshold: number;
  weight_grams: number | null;
  barcode: string | null;
  is_default: boolean;
  status: "active" | "archived";
  is_purchasable: boolean;
  options_signature: string | null;
  created_at: string;
  updated_at: string;
}

/* ---------- response shapes ---------- */

const AdminVariant = z
  .object({
    id: z.string().uuid(),
    sku: z.string(),
    title: z.string().nullable(),
    description: z.string().nullable(),
    specs: z.record(z.unknown()),
    price: z.number(),
    compareAtPrice: z.number().nullable(),
    costPrice: z.number().nullable(),
    currency: z.string(),
    stock: z.number().int(),
    lowStockThreshold: z.number().int(),
    weightGrams: z.number().int().nullable(),
    barcode: z.string().nullable(),
    isDefault: z.boolean(),
    status: z.enum(["active", "archived"]),
    buyable: z.boolean(),
    optionsSignature: z.string().nullable(),
    optionValueIds: z.array(z.string().uuid()),
  })
  .openapi("AdminVariant");

const AdminProductSummary = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    brand: z.string().nullable(),
    categoryId: z.string().uuid().nullable(),
    hsnCode: z.string().nullable(),
    gstRate: z.number().nullable(),
    status: z.enum(["draft", "active", "archived"]),
    variantCount: z.number().int(),
    stock: z.number().int(),
    lowStock: z.boolean(),
    priceFrom: z.number().nullable(),
    priceTo: z.number().nullable(),
    updatedAt: z.string(),
  })
  .openapi("AdminProductSummary");

const AdminProductList = z
  .object({
    items: z.array(AdminProductSummary),
    total: z.number().int().nullable(),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .openapi("AdminProductList");

const AdminProductDetail = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    brand: z.string().nullable(),
    description: z.string().nullable(),
    categoryId: z.string().uuid().nullable(),
    hsnCode: z.string().nullable(),
    gstRate: z.number().nullable(),
    status: z.enum(["draft", "active", "archived"]),
    createdAt: z.string(),
    updatedAt: z.string(),
    images: z.array(
      z.object({
        id: z.string().uuid(),
        variantId: z.string().uuid().nullable(),
        url: z.string(),
        altText: z.string().nullable(),
        position: z.number().int(),
      }),
    ),
    options: z.array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        position: z.number().int(),
        values: z.array(
          z.object({
            id: z.string().uuid(),
            value: z.string(),
            position: z.number().int(),
          }),
        ),
      }),
    ),
    variants: z.array(AdminVariant),
  })
  .openapi("AdminProductDetail");

/* ---------- write schemas ---------- */

/**
 * The bodies come from @ecom/schema, unchanged.
 *
 * productAdminSchema and variantAdminSchema were written for the admin
 * forms and had no caller: the catalog was readable through this API and
 * editable only in SQL. Reusing them rather than restating the rules here
 * is what keeps the form, the request and this handler agreeing about
 * what a valid product is.
 *
 * Two things they deliberately leave out, and both are load-bearing:
 *
 *   `status` is not a create field. A product arrives as 'draft' -- the
 *   column default -- so publishing is a separate, deliberate act rather
 *   than a checkbox someone leaves ticked by accident.
 *
 *   `stock` is not a variant field. inventory_movements is the source of
 *   truth and variant.stock is a cache its trigger maintains; setting it
 *   here would put the cache and the ledger out of step with nothing to
 *   notice. Stock changes through POST /admin/inventory/movements.
 */
const ProductPatch = productAdminSchema
  .partial()
  .extend({ status: z.enum(["draft", "active", "archived"]).optional() })
  .refine((b) => Object.keys(b).length > 0, {
    message: "Send at least one field to change",
  });

export const VariantPatch = variantAdminSchema
  .innerType()
  .partial()
  .extend({ status: z.enum(["active", "archived"]).optional() })
  .refine((b) => Object.keys(b).length > 0, {
    message: "Send at least one field to change",
  });

const Created = z
  .object({ id: z.string().uuid() })
  .openapi("CreatedResource");

/** snake_case for the database; the schemas already speak it. */
const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/* ---------- routes ---------- */

/* ---------- writes ---------- */

/**
 * Options, and what makes this schema worth having.
 *
 * "Amazon / Apple-style configurations" is the README's first sentence,
 * and none of it was reachable: product_options, product_option_values
 * and variant_option_values had no write path, so every product created
 * through this API was a simple one with a single unconfigured variant.
 *
 * BATCHED ON PURPOSE, both of them. refresh_signature() is a
 * STATEMENT-level trigger over a transition table: insert a variant's
 * option values in one statement and options_signature is computed once,
 * and the unique index on (product_id, options_signature) then rejects a
 * duplicate combination with no help from this code. Insert them one at a
 * time and an intermediate signature can collide with another variant's
 * final one, raising a unique violation that names nothing anyone can act
 * on. The schema says so in a comment; these two routes are the reason
 * it says it.
 */
const createOption = createRoute({
  method: "post",
  path: "/admin/products/{id}/options",
  tags: ["admin", "catalog"],
  summary: "Add an option and its values",
  description:
    "One call, because an option with no values configures nothing -- `Colour` on its own cannot be chosen.\n\nValues are inserted in a single statement. Names are unique per product and values unique per option, so a repeat is a 409.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1).max(60),
            position: z.number().int().nonnegative().default(0),
            values: z
              .array(z.string().min(1).max(80))
              .min(1, "An option needs at least one value")
              .max(50),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Created",
      content: {
        "application/json": {
          schema: z.object({
            id: z.string().uuid(),
            name: z.string(),
            values: z.array(z.object({ id: z.string().uuid(), value: z.string() })),
          }),
        },
      },
    },
    400: jsonError("The body does not validate"),
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
    404: jsonError("No such product"),
    409: jsonError("That option name, or one of those values, already exists"),
  },
});

const setVariantOptions = createRoute({
  method: "put",
  path: "/admin/variants/{id}/options",
  tags: ["admin", "catalog"],
  summary: "Set which combination a variant is",
  description:
    "Replaces the whole set: send every option value this variant represents, not a delta.\n\nThe composite foreign keys make an option value from another product **impossible to attach** -- both sides have to resolve to the same `product_id` -- so a mistake here is a 422 (`cross_product_option`), never a variant quietly belonging to two products.\n\nA combination another variant already claims is refused by the unique index on `(product_id, options_signature)`, which the statement trigger maintains. Send an empty array to clear the combination.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            option_value_ids: z.array(z.string().uuid()).max(20),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Set",
      content: {
        "application/json": {
          schema: z.object({
            variantId: z.string().uuid(),
            optionValueIds: z.array(z.string().uuid()),
            optionsSignature: z.string().nullable(),
          }),
        },
      },
    },
    400: jsonError("The body does not validate"),
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
    404: jsonError("No such variant"),
    409: jsonError("That combination is already taken by another variant"),
    422: jsonError("An option value belonging to a different product"),
  },
});

const createProduct = createRoute({
  method: "post",
  path: "/admin/products",
  tags: ["admin", "catalog"],
  summary: "Create a product",
  description:
    "Created as a **draft**, whatever the body says -- `status` is not an input here. A product with no variants cannot be sold, so publishing is a second step taken after there is something to sell.\n\nA duplicate slug answers 409 rather than 500: `products_slug_format` and the unique index are the schema refusing, and errors.ts translates both.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    body: { content: { "application/json": { schema: productAdminSchema } } },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: Created } } },
    400: jsonError("The body does not validate"),
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
    409: jsonError("That slug is already taken"),
  },
});

const updateProduct = createRoute({
  method: "patch",
  path: "/admin/products/{id}",
  tags: ["admin", "catalog"],
  summary: "Change a product, or publish it",
  description:
    "Partial: send only what changes. `status` moves it between draft, active and archived -- this is the publish button.\n\nEvery field here is audited. The write runs as the signed-in staff member, not on the service key, so `audit_logs.staff_id` names whoever made the change; doing it the other way records it anonymously and the trail is worth nothing.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { "application/json": { schema: ProductPatch } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: Created } } },
    400: jsonError("The body does not validate, or is empty"),
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
    404: jsonError("No such product"),
    409: jsonError("That slug is already taken"),
  },
});

const createVariant = createRoute({
  method: "post",
  path: "/admin/products/{id}/variants",
  tags: ["admin", "catalog"],
  summary: "Add a variant",
  description:
    "The variant is the unit of sale, so this is what makes a product sellable.\n\n**Stock is not a field.** `inventory_movements` is the source of truth and `product_variants.stock` is a cache its trigger maintains -- a variant starts at zero and takes stock through POST /admin/inventory/movements. Setting it here would put the cache and the ledger out of step, and nothing downstream would report it.\n\n`compare_at_price` below `price` is refused: a strike-through under the selling price is a pricing bug and, in India, a consumer-protection problem.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { "application/json": { schema: variantAdminSchema } } },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: Created } } },
    400: jsonError("The body does not validate"),
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
    404: jsonError("No such product"),
    409: jsonError("That SKU is already taken"),
  },
});

const updateVariant = createRoute({
  method: "patch",
  path: "/admin/variants/{id}",
  tags: ["admin", "catalog"],
  summary: "Reprice or archive a variant",
  description:
    "Partial. A price change writes a `price_history` row by trigger, in the same transaction -- that record is what makes a disputed order price answerable months later, and it is not optional.\n\nStill no `stock`: use POST /admin/inventory/movements.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { "application/json": { schema: VariantPatch } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: Created } } },
    400: jsonError("The body does not validate, or is empty"),
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
    404: jsonError("No such variant"),
    409: jsonError("That SKU is already taken"),
  },
});

const listProducts = createRoute({
  method: "get",
  path: "/admin/products",
  tags: ["admin", "catalog"],
  summary: "Catalog list for the admin console",
  description:
    "Every status, with cost price and stock. `q` is the same typo-tolerant search the storefront uses; `sku` is an exact-substring match, which is what someone holding a physical label actually wants.",
  middleware: [requireAuth, requireStaff] as const,
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      q: z.string().trim().min(2).max(80).optional(),
      sku: z.string().trim().min(2).max(80).optional(),
      status: z.enum(["draft", "active", "archived"]).optional(),
      ...pageQuery,
    }),
  },
  responses: {
    200: {
      description: "A page of products",
      content: { "application/json": { schema: AdminProductList } },
    },
    400: jsonError("Invalid query parameters"),
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
  },
});

const getProduct = createRoute({
  method: "get",
  path: "/admin/products/{id}",
  tags: ["admin", "catalog"],
  summary: "One product, everything the editor needs",
  middleware: [requireAuth, requireStaff] as const,
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: "The product",
      content: { "application/json": { schema: AdminProductDetail } },
    },
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
    404: jsonError("No product with that id"),
  },
});

export const adminCatalogRoute = new OpenAPIHono({ defaultHook: validationHook })
  .openapi(listProducts, async (c) => {
    const { q, sku, status, limit, offset } = c.req.valid("query");
    const db = c.get("caller").db;

    // Both narrow to a set of ids. Combined, they intersect.
    let ids: string[] | null = null;

    if (q) {
      const { data, error } = await db.rpc("search_products", {
        p_q: q,
        p_limit: PAGE_MAX,
      });
      throwOnDbError(error);
      ids = ((data ?? []) as unknown as { id: string }[]).map((h) => h.id);
    }

    if (sku) {
      // % and _ are wildcards to ilike. A SKU containing either would
      // otherwise match far more than the one on the label.
      const escaped = sku.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      const { data, error } = await db
        .from("product_variants")
        .select("product_id")
        .ilike("sku", `%${escaped}%`)
        .limit(PAGE_MAX);
      throwOnDbError(error);
      const found = ((data ?? []) as unknown as { product_id: string }[]).map(
        (v) => v.product_id,
      );
      ids = ids ? ids.filter((id) => found.includes(id)) : found;
    }

    if (ids && ids.length === 0) {
      return c.json({ items: [], total: 0, limit, offset }, 200);
    }

    let query = db
      .from("products")
      .select(ADMIN_PRODUCT_COLUMNS, { count: "exact" });
    if (ids) query = query.in("id", ids);
    if (status) query = query.eq("status", status);

    const { data, error, count } = await query
      .order("updated_at", { ascending: false })
      .range(offset, offset + limit - 1);
    throwOnDbError(error);

    const rows = (data ?? []) as unknown as AdminProductRow[];
    if (rows.length === 0) {
      return c.json({ items: [], total: count ?? 0, limit, offset }, 200);
    }

    const variants = await db
      .from("product_variants")
      .select("product_id, price, stock, low_stock_threshold")
      .in(
        "product_id",
        rows.map((p) => p.id),
      );
    throwOnDbError(variants.error);

    const byProduct = new Map<
      string,
      { price: number; stock: number; low_stock_threshold: number }[]
    >();
    for (const v of (variants.data ?? []) as unknown as {
      product_id: string;
      price: number;
      stock: number;
      low_stock_threshold: number;
    }[]) {
      const list = byProduct.get(v.product_id);
      if (list) list.push(v);
      else byProduct.set(v.product_id, [v]);
    }

    return c.json(
      {
        items: rows.map((p) => {
          const vs = byProduct.get(p.id) ?? [];
          const prices = vs.map((v) => v.price);
          return {
            id: p.id,
            slug: p.slug,
            name: p.name,
            brand: p.brand,
            categoryId: p.category_id,
            hsnCode: p.hsn_code,
            gstRate: p.gst_rate,
            status: p.status,
            variantCount: vs.length,
            stock: vs.reduce((sum, v) => sum + v.stock, 0),
            lowStock: vs.some((v) => v.stock <= v.low_stock_threshold),
            priceFrom: prices.length ? Math.min(...prices) : null,
            priceTo: prices.length ? Math.max(...prices) : null,
            updatedAt: p.updated_at,
          };
        }),
        total: count ?? null,
        limit,
        offset,
      },
      200,
    );
  })

  .openapi(getProduct, async (c) => {
    const { id } = c.req.valid("param");
    const db = c.get("caller").db;

    const product = await db
      .from("products")
      .select(ADMIN_PRODUCT_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    throwOnDbError(product.error);
    if (!product.data) {
      throw new HTTPException(404, {
        message: "No such product",
        cause: { code: "not_found" },
      });
    }
    const row = product.data as unknown as AdminProductRow;

    const [options, values, variants, vov, images] = await Promise.all([
      db
        .from("product_options")
        .select("id, name, position")
        .eq("product_id", id)
        .order("position", { ascending: true }),
      db
        .from("product_option_values")
        .select("id, option_id, value, position")
        .eq("product_id", id)
        .order("position", { ascending: true }),
      db
        .from("product_variants")
        .select(ADMIN_VARIANT_COLUMNS)
        .eq("product_id", id)
        .order("created_at", { ascending: true }),
      db
        .from("variant_option_values")
        .select("variant_id, option_value_id")
        .eq("product_id", id),
      db
        .from("product_images")
        .select("id, variant_id, url, alt_text, position")
        .eq("product_id", id)
        .order("position", { ascending: true }),
    ]);
    for (const r of [options, values, variants, vov, images]) {
      throwOnDbError(r.error);
    }

    const valueRows = (values.data ?? []) as unknown as {
      id: string;
      option_id: string;
      value: string;
      position: number;
    }[];
    const optionValueIds = new Map<string, string[]>();
    for (const link of (vov.data ?? []) as unknown as {
      variant_id: string;
      option_value_id: string;
    }[]) {
      const list = optionValueIds.get(link.variant_id);
      if (list) list.push(link.option_value_id);
      else optionValueIds.set(link.variant_id, [link.option_value_id]);
    }

    return c.json(
      {
        id: row.id,
        slug: row.slug,
        name: row.name,
        brand: row.brand,
        description: row.description,
        categoryId: row.category_id,
        hsnCode: row.hsn_code,
        gstRate: row.gst_rate,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        images: (
          (images.data ?? []) as unknown as {
            id: string;
            variant_id: string | null;
            url: string;
            alt_text: string | null;
            position: number;
          }[]
        ).map((i) => ({
          id: i.id,
          variantId: i.variant_id,
          url: i.url,
          altText: i.alt_text,
          position: i.position,
        })),
        options: (
          (options.data ?? []) as unknown as {
            id: string;
            name: string;
            position: number;
          }[]
        ).map((o) => ({
          ...o,
          values: valueRows
            .filter((v) => v.option_id === o.id)
            .map(({ id: vid, value, position }) => ({
              id: vid,
              value,
              position,
            })),
        })),
        variants: ((variants.data ?? []) as unknown as AdminVariantRow[]).map(
          (v) => ({
            id: v.id,
            sku: v.sku,
            title: v.title,
            description: v.description,
            specs: v.specs,
            price: v.price,
            compareAtPrice: v.compare_at_price,
            costPrice: v.cost_price,
            currency: v.currency,
            stock: v.stock,
            lowStockThreshold: v.low_stock_threshold,
            weightGrams: v.weight_grams,
            barcode: v.barcode,
            isDefault: v.is_default,
            status: v.status,
            buyable: v.is_purchasable,
            optionsSignature: v.options_signature,
            optionValueIds: optionValueIds.get(v.id) ?? [],
          }),
        ),
      },
      200,
    );
  })

  /**
   * Every write below runs on caller.db -- the staff member's own token --
   * and never on the service key. audit_row() reads auth.uid(), so the
   * service key would record each price edit and each publish as having
   * been made by nobody. staff_all already grants the access, so
   * forwarding the JWT costs nothing and buys the whole audit trail.
   */
  .openapi(createProduct, async (c) => {
    const body = c.req.valid("json");
    const { data, error } = await c
      .get("caller")
      .db.from("products")
      // No status: the column defaults to 'draft', and letting the body
      // set it would make "published by accident" a one-keystroke
      // mistake on the create form.
      .insert(defined(body))
      .select("id")
      .single();
    throwOnDbError(error);

    c.get("log")?.info({ id: (data as { id: string }).id }, "catalog.product_created");
    return c.json({ id: (data as { id: string }).id }, 201);
  })

  .openapi(updateProduct, async (c) => {
    const { id } = c.req.valid("param");
    const patch = defined(c.req.valid("json"));

    const { data, error } = await c
      .get("caller")
      .db.from("products")
      .update(patch)
      .eq("id", id)
      .select("id")
      .maybeSingle();
    throwOnDbError(error);
    // maybeSingle rather than single: an id that matches nothing is a 404,
    // not the 500 that PGRST116 would otherwise become.
    if (!data) throw new HTTPException(404, { message: "No such product" });

    c.get("log")?.info({ id, fields: Object.keys(patch) }, "catalog.product_updated");
    return c.json({ id }, 200);
  })

  .openapi(createVariant, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = c.get("caller").db;

    // The FK would refuse a bad product_id anyway, but as a 23503 that
    // reads like a server fault. Checking first makes it the 404 it is.
    const parent = await db.from("products").select("id").eq("id", id).maybeSingle();
    throwOnDbError(parent.error);
    if (!parent.data) throw new HTTPException(404, { message: "No such product" });

    const { data, error } = await db
      .from("product_variants")
      .insert({ ...defined(body), product_id: id })
      .select("id")
      .single();
    throwOnDbError(error);

    c.get("log")?.info(
      { productId: id, variantId: (data as { id: string }).id },
      "catalog.variant_created",
    );
    return c.json({ id: (data as { id: string }).id }, 201);
  })

  .openapi(updateVariant, async (c) => {
    const { id } = c.req.valid("param");
    const patch = defined(c.req.valid("json"));

    const { data, error } = await c
      .get("caller")
      .db.from("product_variants")
      .update(patch)
      .eq("id", id)
      .select("id")
      .maybeSingle();
    throwOnDbError(error);
    if (!data) throw new HTTPException(404, { message: "No such variant" });

    c.get("log")?.info({ id, fields: Object.keys(patch) }, "catalog.variant_updated");
    return c.json({ id }, 200);
  })

  .openapi(createOption, async (c) => {
    const { id } = c.req.valid("param");
    const { name, position, values } = c.req.valid("json");
    const db = c.get("caller").db;

    const parent = await db.from("products").select("id").eq("id", id).maybeSingle();
    throwOnDbError(parent.error);
    if (!parent.data) throw new HTTPException(404, { message: "No such product" });

    const option = await db
      .from("product_options")
      .insert({ product_id: id, name, position })
      .select("id")
      .single();
    throwOnDbError(option.error);
    const optionId = (option.data as { id: string }).id;

    // One statement. product_id is denormalized onto the value so the
    // composite FK can pin it, and the FK itself refuses a product_id
    // that disagrees with the option's -- so passing it here cannot
    // introduce the inconsistency it looks like it might.
    const created = await db
      .from("product_option_values")
      .insert(
        values.map((value, i) => ({
          option_id: optionId,
          product_id: id,
          value,
          position: i,
        })),
      )
      .select("id, value");
    throwOnDbError(created.error);

    c.get("log")?.info({ productId: id, optionId, values: values.length }, "catalog.option_created");
    return c.json(
      {
        id: optionId,
        name,
        values: (created.data ?? []) as unknown as { id: string; value: string }[],
      },
      201,
    );
  })

  .openapi(setVariantOptions, async (c) => {
    const { id } = c.req.valid("param");
    const { option_value_ids } = c.req.valid("json");
    const db = c.get("caller").db;

    const variant = await db
      .from("product_variants")
      .select("id, product_id")
      .eq("id", id)
      .maybeSingle();
    throwOnDbError(variant.error);
    if (!variant.data) throw new HTTPException(404, { message: "No such variant" });
    const productId = (variant.data as { product_id: string }).product_id;

    // Clear then set, each in one statement. The delete drops the
    // signature to null and the insert recomputes it once, so there is
    // no intermediate value to collide with another variant's.
    const cleared = await db.from("variant_option_values").delete().eq("variant_id", id);
    throwOnDbError(cleared.error);

    if (option_value_ids.length > 0) {
      const attached = await db.from("variant_option_values").insert(
        option_value_ids.map((option_value_id) => ({
          variant_id: id,
          option_value_id,
          // Both composite FKs resolve through this. A value belonging to
          // another product fails the second one rather than attaching.
          product_id: productId,
        })),
      );
      throwOnDbError(attached.error);
    }

    const after = await db
      .from("product_variants")
      .select("options_signature")
      .eq("id", id)
      .single();
    throwOnDbError(after.error);

    c.get("log")?.info({ id, count: option_value_ids.length }, "catalog.variant_options_set");
    return c.json(
      {
        variantId: id,
        optionValueIds: option_value_ids,
        optionsSignature: (after.data as { options_signature: string | null }).options_signature,
      },
      200,
    );
  });

/* ---------- images ---------- */

/**
 * Product images, the last thing in the catalog that was still SQL.
 *
 * The bytes go to Cloudflare R2 through Supabase Storage; see
 * ../storage.ts for why the write path and the read path are different.
 * What lands in the database is a URL, which is all `product_images.url`
 * has ever been -- the schema never cared where the file lived, so none
 * of this needed a migration.
 */

const Image = z
  .object({
    id: z.string().uuid(),
    productId: z.string().uuid(),
    variantId: z.string().uuid().nullable(),
    url: z.string(),
    altText: z.string().nullable(),
    position: z.number().int(),
  })
  .openapi("AdminImage");

interface ImageRow {
  id: string;
  product_id: string;
  variant_id: string | null;
  url: string;
  alt_text: string | null;
  position: number;
}

const shapeImage = (r: ImageRow) => ({
  id: r.id,
  productId: r.product_id,
  variantId: r.variant_id,
  url: r.url,
  altText: r.alt_text,
  position: r.position,
});

const uploadImageRoute = createRoute({
  method: "post",
  path: "/admin/products/{id}/images",
  tags: ["admin", "catalog"],
  summary: "Upload a product image",
  description:
    "multipart/form-data with a `file` part. `altText`, `position` and `variantId` are optional parts alongside it.\n\nThe file type is decided by reading the first bytes, not by the declared Content-Type: JPEG, PNG, WebP and AVIF are accepted and anything else is a 415, whatever the header claims. The stored key is a uuid this service generates — an uploaded filename is an attacker's string, and a repeated one would overwrite somebody else's photograph.\n\n`variantId` must belong to this product; the composite foreign key refuses otherwise.\n\n503 when no bucket is configured, which is a deployment that has not set STORAGE_BUCKET rather than a request that did anything wrong.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            file: z.any().openapi({ type: "string", format: "binary" }),
            altText: z.string().max(200).optional(),
            position: z.string().optional(),
            variantId: z.string().uuid().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Stored",
      content: { "application/json": { schema: Image } },
    },
    400: jsonError("No file part, or it was empty"),
    401: jsonError("Missing or invalid token"),
    403: jsonError("Not staff"),
    404: jsonError("No such product"),
    413: jsonError("Larger than MAX_IMAGE_KB"),
    415: jsonError("Not a JPEG, PNG, WebP or AVIF"),
    503: jsonError("No image storage is configured"),
  },
});

const patchImage = createRoute({
  method: "patch",
  path: "/admin/images/{id}",
  tags: ["admin", "catalog"],
  summary: "Re-caption, reorder or reassign an image",
  description:
    "The metadata only. Replacing the picture is an upload and a delete, because a key that never changes is what lets the CDN cache it for a year.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              altText: z.string().max(200).nullable().optional(),
              position: z.number().int().nonnegative().optional(),
              variantId: z.string().uuid().nullable().optional(),
            })
            .refine((b) => Object.keys(b).length > 0, "Nothing to change"),
        },
      },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: Image } } },
    400: jsonError("Invalid body"),
    401: jsonError("Missing or invalid token"),
    403: jsonError("Not staff"),
    404: jsonError("No such image"),
    422: jsonError("That variant belongs to a different product"),
  },
});

const deleteImage = createRoute({
  method: "delete",
  path: "/admin/images/{id}",
  tags: ["admin", "catalog"],
  summary: "Remove an image",
  description:
    "The row goes first and the object after. An object with no row costs a fraction of a cent and is invisible; a row with no object is a broken image on a product page, so if only one of the two can succeed it must be that order.\n\n204 either way. A storage delete that failed is logged, not returned — the caller asked for the image to stop appearing, and it has.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    204: { description: "Gone" },
    401: jsonError("Missing or invalid token"),
    403: jsonError("Not staff"),
    404: jsonError("No such image"),
  },
});

export const adminImagesRoute = new OpenAPIHono({ defaultHook: validationHook })
  .openapi(uploadImageRoute, async (c) => {
    const { id } = c.req.valid("param");
    const caller = c.get("caller");
    if (!storageConfigured()) {
      throw new HTTPException(503, {
        message: "Image storage is not configured on this deployment.",
        cause: { code: "storage_unconfigured" },
      });
    }

    // Before spending an upload on it. RLS would let staff insert a row
    // against a product that does not exist only to fail on the foreign
    // key -- after the bytes are already in the bucket, orphaned.
    const product = await caller.db.from("products").select("id").eq("id", id).maybeSingle();
    throwOnDbError(product.error);
    if (!product.data) {
      throw new HTTPException(404, {
        message: "No such product",
        cause: { code: "not_found" },
      });
    }

    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      throw new HTTPException(400, {
        message: "Attach an image as the `file` part.",
        cause: { code: "no_file" },
      });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = sniffImageType(bytes);
    if (!kind) {
      // Reading the bytes, not the header. A .heic renamed to .jpg is
      // the common honest case; an HTML file announced as image/png is
      // the other one.
      throw new HTTPException(415, {
        message: "That is not a JPEG, PNG, WebP or AVIF.",
        cause: { code: "unsupported_image" },
      });
    }

    const { url } = await uploadImage(id, bytes, kind);

    const variantId = form.get("variantId");
    const position = Number(form.get("position") ?? 0);
    const altText = form.get("altText");

    const { data, error } = await caller.db
      .from("product_images")
      .insert({
        product_id: id,
        variant_id: typeof variantId === "string" && variantId ? variantId : null,
        url,
        alt_text: typeof altText === "string" && altText ? altText : null,
        position: Number.isFinite(position) ? position : 0,
      })
      .select("id, product_id, variant_id, url, alt_text, position")
      .single();
    throwOnDbError(error);

    c.get("log")?.info({ productId: id, url }, "catalog.image_uploaded");
    return c.json(shapeImage(data as unknown as ImageRow), 201);
  })

  .openapi(patchImage, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const caller = c.get("caller");

    const patch: Record<string, unknown> = {};
    if (body.altText !== undefined) patch.alt_text = body.altText;
    if (body.position !== undefined) patch.position = body.position;
    if (body.variantId !== undefined) patch.variant_id = body.variantId;

    const { data, error } = await caller.db
      .from("product_images")
      .update(patch)
      .eq("id", id)
      .select("id, product_id, variant_id, url, alt_text, position")
      .maybeSingle();
    throwOnDbError(error);
    if (!data) {
      throw new HTTPException(404, {
        message: "No such image",
        cause: { code: "not_found" },
      });
    }
    return c.json(shapeImage(data as unknown as ImageRow), 200);
  })

  .openapi(deleteImage, async (c) => {
    const { id } = c.req.valid("param");
    const caller = c.get("caller");

    // Read the URL before deleting the row -- afterwards there is
    // nothing left to say which object this was.
    const found = await caller.db
      .from("product_images")
      .select("url")
      .eq("id", id)
      .maybeSingle();
    throwOnDbError(found.error);
    if (!found.data) {
      throw new HTTPException(404, {
        message: "No such image",
        cause: { code: "not_found" },
      });
    }

    const { error } = await caller.db.from("product_images").delete().eq("id", id);
    throwOnDbError(error);

    const path = pathFromUrl((found.data as { url: string }).url);
    if (path && !(await deleteObject(path))) {
      // Not an error for the caller: the image has stopped appearing,
      // which is what they asked for. The object is now costing a
      // fraction of a cent until somebody sweeps the bucket.
      c.get("log")?.warn({ imageId: id, path }, "storage.orphaned_object");
    }

    return c.body(null, 204);
  });
