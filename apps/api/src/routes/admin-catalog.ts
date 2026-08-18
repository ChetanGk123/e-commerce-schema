import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { requireAuth, requireStaff } from "../auth";
import { throwOnDbError } from "../errors";
import { PAGE_MAX, jsonError, pageQuery, validationHook } from "../schemas";

/**
 * Admin catalog reads.
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

/* ---------- routes ---------- */

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
  });
