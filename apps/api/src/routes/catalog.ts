import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HTTPException } from "hono/http-exception";

import { throwOnDbError } from "../errors";
import { PAGE_MAX, jsonError, pageQuery, validationHook } from "../schemas";
import { anonClient } from "../supabase";

/**
 * Storefront catalog reads.
 *
 * Everything here goes through anonClient(), so RLS is the scoping mechanism
 * rather than a WHERE clause someone can forget. Two consequences worth
 * stating: drafts are invisible because public_read on products says
 * `status = 'active'`, and cost_price is unreachable because product_variants
 * has no public policy at all -- variants come from the storefront_variants
 * view, which does not project that column.
 *
 * The select lists below are therefore belt to RLS's braces. They are exported
 * so a test can assert on them directly.
 */
export const STOREFRONT_PRODUCT_COLUMNS =
  "id, slug, name, brand, description, category_id, gst_rate";

export const STOREFRONT_VARIANT_COLUMNS =
  "id, product_id, sku, title, description, specs, price, compare_at_price, currency, stock, weight_grams, is_default, is_purchasable";

/**
 * Money arrives as a JSON number. numeric(12,2) fits inside float64 exactly,
 * so display is safe -- but no total is ever computed here. Checkout recomputes
 * every amount in SQL (api-plan B5); JS money arithmetic is how a cart and an
 * invoice end up a paisa apart.
 */
interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  title: string | null;
  description: string | null;
  specs: Record<string, unknown>;
  price: number;
  compare_at_price: number | null;
  currency: string;
  stock: number;
  weight_grams: number | null;
  is_default: boolean;
  is_purchasable: boolean;
}

interface ProductRow {
  id: string;
  slug: string;
  name: string;
  brand: string | null;
  description: string | null;
  category_id: string | null;
  gst_rate: number | null;
}

interface ImageRow {
  id: string;
  product_id: string;
  variant_id: string | null;
  url: string;
  alt_text: string | null;
  position: number;
}

/* ---------- response shapes ---------- */

const Image = z
  .object({
    id: z.string().uuid(),
    variantId: z.string().uuid().nullable(),
    url: z.string(),
    altText: z.string().nullable(),
    position: z.number().int(),
  })
  .openapi("CatalogImage");

const ProductSummary = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    brand: z.string().nullable(),
    description: z.string().nullable(),
    categoryId: z.string().uuid().nullable(),
    gstRate: z.number().nullable(),
    image: Image.nullable(),
    priceFrom: z.number().nullable(),
    priceTo: z.number().nullable(),
    currency: z.string().nullable(),
    inStock: z.boolean(),
    defaultVariantId: z.string().uuid().nullable(),
  })
  .openapi("ProductSummary");

const ProductList = z
  .object({
    items: z.array(ProductSummary),
    total: z.number().int().nullable(),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .openapi("ProductList");

const Variant = z
  .object({
    id: z.string().uuid(),
    sku: z.string(),
    title: z.string().nullable(),
    description: z.string().nullable(),
    specs: z.record(z.unknown()),
    price: z.number(),
    compareAtPrice: z.number().nullable(),
    currency: z.string(),
    stock: z.number().int(),
    weightGrams: z.number().int().nullable(),
    isDefault: z.boolean(),
    buyable: z.boolean(),
    optionValueIds: z.array(z.string().uuid()),
  })
  .openapi("CatalogVariant");

const ProductDetail = ProductSummary.extend({
  images: z.array(Image),
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
  variants: z.array(Variant),
}).openapi("ProductDetail");

const Category = z
  .object({
    id: z.string().uuid(),
    parentId: z.string().uuid().nullable(),
    name: z.string(),
    slug: z.string(),
    position: z.number().int(),
  })
  .openapi("Category");

const Collection = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    imageUrl: z.string().nullable(),
    position: z.number().int(),
  })
  .openapi("Collection");

/* ---------- helpers ---------- */

/**
 * Price band, availability and hero image for a page of products.
 *
 * Two queries for the whole page rather than two per product: the alternative
 * is an N+1 that only shows up once the catalog is real.
 */
async function decorate(
  db: SupabaseClient,
  rows: ProductRow[],
): Promise<z.infer<typeof ProductSummary>[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((p) => p.id);

  const [variants, images] = await Promise.all([
    db.from("storefront_variants").select(STOREFRONT_VARIANT_COLUMNS).in("product_id", ids),
    db
      .from("product_images")
      .select("id, product_id, variant_id, url, alt_text, position")
      .in("product_id", ids)
      .order("position", { ascending: true }),
  ]);
  throwOnDbError(variants.error);
  throwOnDbError(images.error);

  const byProduct = new Map<string, VariantRow[]>();
  for (const v of (variants.data ?? []) as unknown as VariantRow[]) {
    const list = byProduct.get(v.product_id);
    if (list) list.push(v);
    else byProduct.set(v.product_id, [v]);
  }

  const heroImage = new Map<string, ImageRow>();
  for (const img of (images.data ?? []) as unknown as ImageRow[]) {
    // Already ordered by position, so the first one seen wins.
    if (!heroImage.has(img.product_id)) heroImage.set(img.product_id, img);
  }

  return rows.map((p) => {
    const vs = byProduct.get(p.id) ?? [];
    const prices = vs.map((v) => v.price);
    const img = heroImage.get(p.id);
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      brand: p.brand,
      description: p.description,
      categoryId: p.category_id,
      gstRate: p.gst_rate,
      image: img
        ? {
            id: img.id,
            variantId: img.variant_id,
            url: img.url,
            altText: img.alt_text,
            position: img.position,
          }
        : null,
      priceFrom: prices.length ? Math.min(...prices) : null,
      priceTo: prices.length ? Math.max(...prices) : null,
      currency: vs[0]?.currency ?? null,
      inStock: vs.some((v) => v.is_purchasable),
      defaultVariantId: vs.find((v) => v.is_default)?.id ?? null,
    };
  });
}

/* ---------- routes ---------- */

const listProducts = createRoute({
  method: "get",
  path: "/catalog/products",
  tags: ["catalog"],
  summary: "Browse or search the storefront catalog",
  description:
    "Active products only, enforced by RLS rather than by this handler. `q` runs the pg_trgm search, which is typo-tolerant: 'iphone chrger' finds 'iPhone charger'. Search results are ordered by match score; everything else is ordered by name.",
  request: {
    query: z.object({
      q: z.string().trim().min(2).max(80).optional(),
      category: z.string().max(120).optional(),
      collection: z.string().max(120).optional(),
      ...pageQuery,
    }),
  },
  responses: {
    200: {
      description: "A page of products",
      content: { "application/json": { schema: ProductList } },
    },
    400: jsonError("Invalid query parameters"),
  },
});

const getProduct = createRoute({
  method: "get",
  path: "/catalog/products/{slug}",
  tags: ["catalog"],
  summary: "One product, with its options and buyable variants",
  request: { params: z.object({ slug: z.string().min(1).max(120) }) },
  responses: {
    200: {
      description: "The product",
      content: { "application/json": { schema: ProductDetail } },
    },
    404: jsonError("No active product with that slug"),
  },
});

const listCategories = createRoute({
  method: "get",
  path: "/catalog/categories",
  tags: ["catalog"],
  summary: "Every category, flat",
  description:
    "Flat with parent_id rather than nested. Nesting is three lines in the caller and a recursive CTE here, and the client needs the flat form anyway to resolve breadcrumbs.",
  responses: {
    200: {
      description: "Categories",
      content: {
        "application/json": { schema: z.object({ items: z.array(Category) }) },
      },
    },
  },
});

const listCollections = createRoute({
  method: "get",
  path: "/catalog/collections",
  tags: ["catalog"],
  summary: "Active merchandising collections",
  responses: {
    200: {
      description: "Collections",
      content: {
        "application/json": { schema: z.object({ items: z.array(Collection) }) },
      },
    },
  },
});

export const catalogRoute = new OpenAPIHono({ defaultHook: validationHook })
  .openapi(listProducts, async (c) => {
    const { q, category, collection, limit, offset } = c.req.valid("query");
    const db = anonClient();

    // Search first: the RPC decides both membership and order, and the
    // filters below narrow it. Doing it the other way round would mean
    // paginating a set the score has not been applied to yet.
    let scores: Map<string, number> | null = null;
    let searchIds: string[] | null = null;
    if (q) {
      const { data, error } = await db.rpc("search_products", {
        p_q: q,
        p_limit: PAGE_MAX,
      });
      throwOnDbError(error);
      const hits = (data ?? []) as unknown as (ProductRow & { score: number })[];
      scores = new Map(hits.map((h) => [h.id, h.score]));
      searchIds = hits.map((h) => h.id);
      if (searchIds.length === 0) {
        return c.json({ items: [], total: 0, limit, offset }, 200);
      }
    }

    if (collection) {
      const { data, error } = await db
        .from("collections")
        .select("id, collection_products(product_id)")
        .eq("slug", collection)
        .maybeSingle();
      throwOnDbError(error);
      const members = (
        (data?.collection_products ?? []) as { product_id: string }[]
      ).map((m) => m.product_id);
      searchIds = searchIds
        ? searchIds.filter((id) => members.includes(id))
        : members;
      if (searchIds.length === 0) {
        return c.json({ items: [], total: 0, limit, offset }, 200);
      }
    }

    let query = db
      .from("products")
      // Exact count: catalogs are thousands of rows, not millions, and a
      // pagination control needs a real last page. Revisit if that changes.
      .select(STOREFRONT_PRODUCT_COLUMNS, { count: "exact" });

    if (searchIds) query = query.in("id", searchIds);
    if (category) {
      const { data, error } = await db
        .from("categories")
        .select("id")
        .eq("slug", category)
        .maybeSingle();
      throwOnDbError(error);
      if (!data) return c.json({ items: [], total: 0, limit, offset }, 200);
      query = query.eq("category_id", (data as { id: string }).id);
    }

    const { data, error, count } = await query
      .order("name", { ascending: true })
      .range(offset, offset + limit - 1);
    throwOnDbError(error);

    const rows = (data ?? []) as unknown as ProductRow[];
    if (scores) {
      rows.sort(
        (a, b) =>
          (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) ||
          a.name.localeCompare(b.name),
      );
    }

    return c.json(
      { items: await decorate(db, rows), total: count ?? null, limit, offset },
      200,
    );
  })

  .openapi(getProduct, async (c) => {
    const { slug } = c.req.valid("param");
    const db = anonClient();

    const product = await db
      .from("products")
      .select(STOREFRONT_PRODUCT_COLUMNS)
      .eq("slug", slug)
      .maybeSingle();
    throwOnDbError(product.error);
    if (!product.data) {
      // A draft product lands here too, and that is the right answer: to the
      // storefront it does not exist, and saying "exists but unpublished"
      // would leak the launch.
      throw new HTTPException(404, {
        message: "No such product",
        cause: { code: "not_found" },
      });
    }
    const row = product.data as unknown as ProductRow;

    const [options, values, variants, vov, images] = await Promise.all([
      db
        .from("product_options")
        .select("id, name, position")
        .eq("product_id", row.id)
        .order("position", { ascending: true }),
      // product_option_values carries a denormalized product_id (it is half of
      // the composite FK that stops cross-product contamination), so this
      // needs no join.
      db
        .from("product_option_values")
        .select("id, option_id, value, position")
        .eq("product_id", row.id)
        .order("position", { ascending: true }),
      db
        .from("storefront_variants")
        .select(STOREFRONT_VARIANT_COLUMNS)
        .eq("product_id", row.id),
      db
        .from("variant_option_values")
        .select("variant_id, option_value_id")
        .eq("product_id", row.id),
      db
        .from("product_images")
        .select("id, product_id, variant_id, url, alt_text, position")
        .eq("product_id", row.id)
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

    // decorate maps 1:1 over its input, so one row in is one summary out.
    // noUncheckedIndexedAccess cannot see that.
    const summary = (await decorate(db, [row]))[0]!;
    const imageRows = (images.data ?? []) as unknown as ImageRow[];

    return c.json(
      {
        ...summary,
        images: imageRows.map((i) => ({
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
            .map(({ id, value, position }) => ({ id, value, position })),
        })),
        variants: ((variants.data ?? []) as unknown as VariantRow[]).map(
          (v) => ({
            id: v.id,
            sku: v.sku,
            title: v.title,
            // The variant's own copy, falling back to the product's -- the
            // same rule docs/schema_guide.md uses.
            description: v.description ?? row.description,
            specs: v.specs,
            price: v.price,
            compareAtPrice: v.compare_at_price,
            currency: v.currency,
            stock: v.stock,
            weightGrams: v.weight_grams,
            isDefault: v.is_default,
            buyable: v.is_purchasable,
            optionValueIds: optionValueIds.get(v.id) ?? [],
          }),
        ),
      },
      200,
    );
  })

  .openapi(listCategories, async (c) => {
    const { data, error } = await anonClient()
      .from("categories")
      .select("id, parent_id, name, slug, position")
      .order("position", { ascending: true })
      .order("name", { ascending: true });
    throwOnDbError(error);

    return c.json(
      {
        items: (
          (data ?? []) as unknown as {
            id: string;
            parent_id: string | null;
            name: string;
            slug: string;
            position: number;
          }[]
        ).map(({ parent_id, ...rest }) => ({ ...rest, parentId: parent_id })),
      },
      200,
    );
  })

  .openapi(listCollections, async (c) => {
    // public_read on collections is `using (is_active)`, so inactive ones are
    // filtered by the database, not by this select.
    const { data, error } = await anonClient()
      .from("collections")
      .select("id, name, slug, description, image_url, position")
      .order("position", { ascending: true });
    throwOnDbError(error);

    return c.json(
      {
        items: (
          (data ?? []) as unknown as {
            id: string;
            name: string;
            slug: string;
            description: string | null;
            image_url: string | null;
            position: number;
          }[]
        ).map(({ image_url, ...rest }) => ({ ...rest, imageUrl: image_url })),
      },
      200,
    );
  });
