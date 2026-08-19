import { slug as slugSchema } from "@ecom/schema/validation";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { requireAuth, requireStaff } from "../auth";
import { throwOnDbError } from "../errors";
import { jsonError, validationHook } from "../schemas";

/**
 * Categories and collections -- how a catalog is organised.
 *
 * /catalog/categories and /catalog/collections have answered since B4,
 * from whatever `setup.md` seeded at install. A store that started
 * selling something new could not file it anywhere.
 *
 * The two are not the same thing and the schema keeps them apart: a
 * category is a tree a product sits in one place of (products.category_id),
 * a collection is a flat set a product can be in any number of
 * (collection_products). Merchandising uses collections; navigation uses
 * categories.
 */
const Category = z
  .object({
    id: z.string().uuid(),
    parentId: z.string().uuid().nullable(),
    name: z.string(),
    slug: z.string(),
    position: z.number().int(),
  })
  .openapi("AdminCategory");

const Collection = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    imageUrl: z.string().nullable(),
    isActive: z.boolean(),
    position: z.number().int(),
  })
  .openapi("AdminCollection");

interface CategoryRow {
  id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  position: number;
}

interface CollectionRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  image_url: string | null;
  is_active: boolean;
  position: number;
}

const CATEGORY_COLUMNS = "id, parent_id, name, slug, position";
const COLLECTION_COLUMNS = "id, name, slug, description, image_url, is_active, position";

const asCategory = (r: CategoryRow) => ({
  id: r.id,
  parentId: r.parent_id,
  name: r.name,
  slug: r.slug,
  position: r.position,
});

const asCollection = (r: CollectionRow) => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  description: r.description,
  imageUrl: r.image_url,
  isActive: r.is_active,
  position: r.position,
});

const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

const CategoryBody = z.object({
  name: z.string().min(1).max(80),
  slug: slugSchema,
  parent_id: z.string().uuid().nullable().optional(),
  position: z.number().int().nonnegative().default(0),
});

const CollectionBody = z.object({
  name: z.string().min(1).max(80),
  slug: slugSchema,
  description: z.string().max(2000).optional(),
  image_url: z.string().url().max(500).optional(),
  is_active: z.boolean().default(true),
  position: z.number().int().nonnegative().default(0),
});

const createCategory = createRoute({
  method: "post",
  path: "/admin/categories",
  tags: ["admin", "catalog"],
  summary: "Add a category",
  description:
    "`parent_id` nests it. A category cannot be made its own ancestor -- not just its own parent, but anywhere in the chain above it -- because every breadcrumb and every \"this category and its children\" query walks that chain, and one loop is an infinite one.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: { body: { content: { "application/json": { schema: CategoryBody } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: Category } } },
    400: jsonError("The body does not validate"),
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
    409: jsonError("That slug is already taken"),
    422: jsonError("That parent would create a cycle"),
  },
});

const updateCategory = createRoute({
  method: "patch",
  path: "/admin/categories/{id}",
  tags: ["admin", "catalog"],
  summary: "Rename or re-parent a category",
  description:
    "Partial. Send `parent_id: null` to move it to the top level.\\n\\nDeleting is not offered: `products.category_id` is `on delete set null`, so removing a category would silently unfile every product in it. Move the products first, then the category becomes empty and harmless.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: CategoryBody.partial().refine((b) => Object.keys(b).length > 0, {
            message: "Send at least one field to change",
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: Category } } },
    400: jsonError("The body does not validate, or is empty"),
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
    404: jsonError("No such category"),
    409: jsonError("That slug is already taken"),
    422: jsonError("That parent would create a cycle"),
  },
});

const createCollection = createRoute({
  method: "post",
  path: "/admin/collections",
  tags: ["admin", "catalog"],
  summary: "Add a collection",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: { body: { content: { "application/json": { schema: CollectionBody } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: Collection } } },
    400: jsonError("The body does not validate"),
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
    409: jsonError("That slug is already taken"),
  },
});

const updateCollection = createRoute({
  method: "patch",
  path: "/admin/collections/{id}",
  tags: ["admin", "catalog"],
  summary: "Change or hide a collection",
  description:
    "`is_active: false` hides it from the storefront -- `public_read` on collections is gated on that column, so an inactive collection is invisible without anything being deleted.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: CollectionBody.partial().refine((b) => Object.keys(b).length > 0, {
            message: "Send at least one field to change",
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: Collection } } },
    400: jsonError("The body does not validate, or is empty"),
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
    404: jsonError("No such collection"),
    409: jsonError("That slug is already taken"),
  },
});

const setMembers = createRoute({
  method: "put",
  path: "/admin/collections/{id}/products",
  tags: ["admin", "catalog"],
  summary: "Set what is in a collection",
  description:
    "Replaces the whole membership, in order: the array's index becomes each product's `position`, so this is also how a collection is re-sorted. Send an empty array to empty it.\\n\\nA product listed twice, or one that does not exist, is refused as a whole -- the write is one statement, so a bad entry takes the request down rather than half-applying it.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ product_ids: z.array(z.string().uuid()).max(500) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Set",
      content: {
        "application/json": {
          schema: z.object({ collectionId: z.string().uuid(), productIds: z.array(z.string().uuid()) }),
        },
      },
    },
    400: jsonError("The body does not validate"),
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
    404: jsonError("No such collection"),
    409: jsonError("A product listed twice"),
    422: jsonError("A product that does not exist"),
  },
});

export const taxonomyRoute = new OpenAPIHono({ defaultHook: validationHook })
  .openapi(createCategory, async (c) => {
    const { data, error } = await c
      .get("caller")
      .db.from("categories")
      .insert(defined(c.req.valid("json")))
      .select(CATEGORY_COLUMNS)
      .single();
    throwOnDbError(error);
    return c.json(asCategory(data as unknown as CategoryRow), 201);
  })

  .openapi(updateCategory, async (c) => {
    const { id } = c.req.valid("param");
    // parent_id: null is a meaningful value here -- "move to the top
    // level" -- so it must survive the undefined filter that everything
    // else uses to mean "not sent".
    const body = c.req.valid("json");
    const patch = defined(body);
    if ("parent_id" in body && body.parent_id === null) patch.parent_id = null;

    const { data, error } = await c
      .get("caller")
      .db.from("categories")
      .update(patch)
      .eq("id", id)
      .select(CATEGORY_COLUMNS)
      .maybeSingle();
    throwOnDbError(error);
    if (!data) throw new HTTPException(404, { message: "No such category" });
    return c.json(asCategory(data as unknown as CategoryRow), 200);
  })

  .openapi(createCollection, async (c) => {
    const { data, error } = await c
      .get("caller")
      .db.from("collections")
      .insert(defined(c.req.valid("json")))
      .select(COLLECTION_COLUMNS)
      .single();
    throwOnDbError(error);
    return c.json(asCollection(data as unknown as CollectionRow), 201);
  })

  .openapi(updateCollection, async (c) => {
    const { id } = c.req.valid("param");
    const { data, error } = await c
      .get("caller")
      .db.from("collections")
      .update(defined(c.req.valid("json")))
      .eq("id", id)
      .select(COLLECTION_COLUMNS)
      .maybeSingle();
    throwOnDbError(error);
    if (!data) throw new HTTPException(404, { message: "No such collection" });
    return c.json(asCollection(data as unknown as CollectionRow), 200);
  })

  .openapi(setMembers, async (c) => {
    const { id } = c.req.valid("param");
    const { product_ids } = c.req.valid("json");
    const db = c.get("caller").db;

    const collection = await db.from("collections").select("id").eq("id", id).maybeSingle();
    throwOnDbError(collection.error);
    if (!collection.data) throw new HTTPException(404, { message: "No such collection" });

    const cleared = await db.from("collection_products").delete().eq("collection_id", id);
    throwOnDbError(cleared.error);

    if (product_ids.length > 0) {
      // One statement, so a product that does not exist fails the whole
      // request on its foreign key rather than leaving the collection
      // half-populated with no indication which half.
      const inserted = await db.from("collection_products").insert(
        product_ids.map((product_id, position) => ({
          collection_id: id,
          product_id,
          position,
        })),
      );
      throwOnDbError(inserted.error);
    }

    c.get("log")?.info({ id, count: product_ids.length }, "taxonomy.collection_set");
    return c.json({ collectionId: id, productIds: product_ids }, 200);
  });
