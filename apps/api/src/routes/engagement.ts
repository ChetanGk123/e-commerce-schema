import { reviewSchema, stockAlertSchema } from "@ecom/schema/validation";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { optionalAuth, requireAuth, requireStaff } from "../auth";
import { throwOnDbError } from "../errors";
import { jsonError, pageQuery, validationHook } from "../schemas";
import { anonClient } from "../supabase";

/**
 * Reviews, wishlists, stock alerts, notifications.
 *
 * `reviews.is_verified` is a GENERATED column -- it is
 * `order_item_id is not null`, computed by Postgres. It cannot be sent,
 * and validate_review_purchase() additionally checks the order item is
 * really the reviewer's and really for that product. So the "verified
 * buyer" badge is not a claim the API trusts; it is arithmetic.
 *
 * `status` is pinned to 'pending' by RLS on insert, which is what stops
 * a customer publishing straight to the product page.
 */
const Review = z
  .object({
    id: z.string().uuid(),
    productId: z.string().uuid(),
    variantId: z.string().uuid().nullable(),
    rating: z.number().int(),
    title: z.string().nullable(),
    body: z.string().nullable(),
    /** Generated from order_item_id. Read only, everywhere. */
    isVerified: z.boolean(),
    status: z.enum(["pending", "approved", "rejected"]),
    createdAt: z.string(),
  })
  .openapi("Review");

const WishlistItem = z
  .object({
    variantId: z.string().uuid(),
    productId: z.string().uuid(),
    sku: z.string(),
    title: z.string().nullable(),
    price: z.number(),
    inStock: z.boolean(),
    addedAt: z.string(),
  })
  .openapi("WishlistItem");

const Notification = z
  .object({
    id: z.string().uuid(),
    kind: z.string(),
    title: z.string(),
    body: z.string().nullable(),
    data: z.record(z.unknown()),
    readAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("Notification");

interface ReviewRow {
  id: string;
  product_id: string;
  variant_id: string | null;
  rating: number;
  title: string | null;
  body: string | null;
  is_verified: boolean;
  status: "pending" | "approved" | "rejected";
  created_at: string;
}

const REVIEW_SELECT =
  "id, product_id, variant_id, rating, title, body, is_verified, status, created_at";

const shapeReview = (r: ReviewRow) => ({
  id: r.id,
  productId: r.product_id,
  variantId: r.variant_id,
  rating: r.rating,
  title: r.title,
  body: r.body,
  isVerified: r.is_verified,
  status: r.status,
  createdAt: r.created_at,
});

const authErrors = {
  401: jsonError("Missing or invalid token"),
  403: jsonError("Not allowed"),
};

const productReviews = createRoute({
  method: "get",
  path: "/catalog/products/{slug}/reviews",
  tags: ["catalog"],
  summary: "Approved reviews for a product",
  description:
    "Public, and approved only -- enforced by `public_read on reviews using (status = 'approved')`, not by this handler.",
  request: {
    params: z.object({ slug: z.string().min(1).max(120) }),
    query: z.object(pageQuery),
  },
  responses: {
    200: {
      description: "Reviews",
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(Review),
            averageRating: z.number().nullable(),
            total: z.number().int().nullable(),
          }),
        },
      },
    },
    404: jsonError("No such product"),
  },
});

const writeReview = createRoute({
  method: "post",
  path: "/reviews",
  tags: ["engagement"],
  summary: "Write a review",
  description:
    "Lands as `pending` and stays there until a moderator approves it -- RLS pins the status on insert, so self-publishing is not possible.\n\nPass `order_item_id` to earn the verified-buyer badge. It is checked against your own orders, and `is_verified` is generated from it rather than sent.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { body: { content: { "application/json": { schema: reviewSchema } } } },
  responses: {
    201: { description: "Submitted for moderation", content: { "application/json": { schema: Review } } },
    400: jsonError("Invalid body"),
    409: jsonError("You have already reviewed this product"),
    422: jsonError("That order item is not yours, or not for this product"),
    401: jsonError("Missing or invalid token"),
  },
});

const moderate = createRoute({
  method: "patch",
  path: "/admin/reviews/{id}",
  tags: ["admin", "engagement"],
  summary: "Approve or reject a review",
  description:
    "Status only. Rating, title and body are the customer's words, and an endpoint that let staff edit them would turn the review section into marketing copy.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ status: z.enum(["approved", "rejected"]) }),
        },
      },
    },
  },
  responses: {
    200: { description: "Moderated", content: { "application/json": { schema: Review } } },
    400: jsonError("Invalid body"),
    404: jsonError("No such review"),
    ...authErrors,
  },
});

const moderationQueue = createRoute({
  method: "get",
  path: "/admin/reviews",
  tags: ["admin", "engagement"],
  summary: "Reviews awaiting moderation",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    query: z.object({
      status: z.enum(["pending", "approved", "rejected"]).default("pending"),
      ...pageQuery,
    }),
  },
  responses: {
    200: {
      description: "A page of reviews",
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(Review),
            total: z.number().int().nullable(),
            limit: z.number().int(),
            offset: z.number().int(),
          }),
        },
      },
    },
    400: jsonError("Invalid query"),
    ...authErrors,
  },
});

const wishlist = createRoute({
  method: "get",
  path: "/wishlist",
  tags: ["engagement"],
  summary: "My wishlist",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  responses: {
    200: {
      description: "Wishlist",
      content: { "application/json": { schema: z.object({ items: z.array(WishlistItem) }) } },
    },
    ...authErrors,
  },
});

const addWish = createRoute({
  method: "put",
  path: "/wishlist/{variantId}",
  tags: ["engagement"],
  summary: "Add to my wishlist",
  description: "Idempotent: the primary key is (customer_id, variant_id), so adding twice is adding once.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { params: z.object({ variantId: z.string().uuid() }) },
  responses: {
    200: {
      description: "Added",
      content: { "application/json": { schema: z.object({ added: z.literal(true) }) } },
    },
    ...authErrors,
  },
});

const removeWish = createRoute({
  method: "delete",
  path: "/wishlist/{variantId}",
  tags: ["engagement"],
  summary: "Remove from my wishlist",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { params: z.object({ variantId: z.string().uuid() }) },
  responses: {
    200: {
      description: "Removed",
      content: { "application/json": { schema: z.object({ removed: z.literal(true) }) } },
    },
    ...authErrors,
  },
});

const notifyMe = createRoute({
  method: "post",
  path: "/stock-alerts",
  tags: ["engagement"],
  summary: "Tell me when this is back",
  description:
    "Guests may subscribe with an email. `notified_at` is pinned null by RLS, so nobody can pre-mark their own alert as sent.",
  security: [{ bearerAuth: [] }],
  middleware: [optionalAuth] as const,
  request: { body: { content: { "application/json": { schema: stockAlertSchema } } } },
  responses: {
    201: {
      description: "Subscribed",
      content: { "application/json": { schema: z.object({ id: z.string().uuid() }) } },
    },
    400: jsonError("Invalid body, or no way to reach you"),
    401: jsonError("A token was sent but is not valid"),
  },
});

const myNotifications = createRoute({
  method: "get",
  path: "/notifications",
  tags: ["engagement"],
  summary: "My notifications",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { query: z.object({ unread: z.coerce.boolean().optional(), ...pageQuery }) },
  responses: {
    200: {
      description: "Newest first",
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(Notification),
            unreadCount: z.number().int(),
          }),
        },
      },
    },
    400: jsonError("Invalid query"),
    ...authErrors,
  },
});

const markRead = createRoute({
  method: "post",
  path: "/notifications/{id}/read",
  tags: ["engagement"],
  summary: "Mark one as read",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: "Marked",
      content: { "application/json": { schema: z.object({ read: z.literal(true) }) } },
    },
    404: jsonError("No such notification"),
    ...authErrors,
  },
});

export const engagementRoute = new OpenAPIHono({ defaultHook: validationHook })
  .openapi(productReviews, async (c) => {
    const { slug } = c.req.valid("param");
    const { limit, offset } = c.req.valid("query");
    const db = anonClient();

    const product = await db.from("products").select("id").eq("slug", slug).maybeSingle();
    throwOnDbError(product.error);
    if (!product.data) {
      throw new HTTPException(404, { message: "No such product", cause: { code: "not_found" } });
    }
    const productId = (product.data as { id: string }).id;

    const { data, error, count } = await db
      .from("reviews")
      .select(REVIEW_SELECT, { count: "exact" })
      .eq("product_id", productId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    throwOnDbError(error);

    const items = ((data ?? []) as unknown as ReviewRow[]).map(shapeReview);
    return c.json(
      {
        items,
        // Of this page, and honest about it: an average over every
        // approved review needs an aggregate the storefront can cache.
        averageRating: items.length
          ? Math.round((items.reduce((s, r) => s + r.rating, 0) / items.length) * 10) / 10
          : null,
        total: count ?? null,
      },
      200,
    );
  })

  .openapi(writeReview, async (c) => {
    const body = c.req.valid("json");
    const caller = c.get("caller");

    // status and is_verified are absent on purpose: RLS pins the first
    // and Postgres generates the second.
    const { data, error } = await caller.db
      .from("reviews")
      .insert({
        product_id: body.product_id,
        customer_id: caller.userId,
        order_item_id: body.order_item_id ?? null,
        rating: body.rating,
        title: body.title ?? null,
        body: body.body ?? null,
      })
      .select(REVIEW_SELECT)
      .single();
    throwOnDbError(error);

    return c.json(shapeReview(data as unknown as ReviewRow), 201);
  })

  .openapi(moderate, async (c) => {
    const { id } = c.req.valid("param");
    const { status } = c.req.valid("json");

    const { data, error } = await c
      .get("caller")
      .db.from("reviews")
      .update({ status })
      .eq("id", id)
      .select(REVIEW_SELECT)
      .maybeSingle();
    throwOnDbError(error);
    if (!data) {
      throw new HTTPException(404, { message: "No such review", cause: { code: "not_found" } });
    }
    c.get("log")?.info({ reviewId: id, status }, "engagement.review_moderated");
    return c.json(shapeReview(data as unknown as ReviewRow), 200);
  })

  .openapi(moderationQueue, async (c) => {
    const { status, limit, offset } = c.req.valid("query");
    const { data, error, count } = await c
      .get("caller")
      .db.from("reviews")
      .select(REVIEW_SELECT, { count: "exact" })
      .eq("status", status)
      .order("created_at", { ascending: true })
      .range(offset, offset + limit - 1);
    throwOnDbError(error);

    return c.json(
      {
        items: ((data ?? []) as unknown as ReviewRow[]).map(shapeReview),
        total: count ?? null,
        limit,
        offset,
      },
      200,
    );
  })

  .openapi(wishlist, async (c) => {
    const caller = c.get("caller");
    const { data, error } = await caller.db
      .from("wishlist_items")
      .select("variant_id, created_at")
      .order("created_at", { ascending: false });
    throwOnDbError(error);

    const rows = (data ?? []) as unknown as { variant_id: string; created_at: string }[];
    if (rows.length === 0) return c.json({ items: [] }, 200);

    // Prices come from the public view, so a wishlist can never leak
    // cost_price and an archived variant simply drops out.
    const variants = await anonClient()
      .from("storefront_variants")
      .select("id, product_id, sku, title, price, is_purchasable")
      .in("id", rows.map((r) => r.variant_id));
    throwOnDbError(variants.error);
    const byId = new Map(
      (
        (variants.data ?? []) as unknown as {
          id: string;
          product_id: string;
          sku: string;
          title: string | null;
          price: number;
          is_purchasable: boolean;
        }[]
      ).map((v) => [v.id, v]),
    );

    return c.json(
      {
        items: rows.flatMap((r) => {
          const v = byId.get(r.variant_id);
          if (!v) return [];
          return [
            {
              variantId: v.id,
              productId: v.product_id,
              sku: v.sku,
              title: v.title,
              price: Number(v.price),
              inStock: v.is_purchasable,
              addedAt: r.created_at,
            },
          ];
        }),
      },
      200,
    );
  })

  .openapi(addWish, async (c) => {
    const { variantId } = c.req.valid("param");
    const caller = c.get("caller");
    const { error } = await caller.db
      .from("wishlist_items")
      .upsert(
        { customer_id: caller.userId, variant_id: variantId },
        { onConflict: "customer_id,variant_id" },
      );
    throwOnDbError(error);
    return c.json({ added: true as const }, 200);
  })

  .openapi(removeWish, async (c) => {
    const { variantId } = c.req.valid("param");
    const caller = c.get("caller");
    const { error } = await caller.db
      .from("wishlist_items")
      .delete()
      .eq("customer_id", caller.userId)
      .eq("variant_id", variantId);
    throwOnDbError(error);
    return c.json({ removed: true as const }, 200);
  })

  .openapi(notifyMe, async (c) => {
    const body = c.req.valid("json");
    const caller = c.get("caller");
    const db = caller?.db ?? anonClient();

    const { data, error } = await db
      .from("stock_alerts")
      .insert({
        variant_id: body.variant_id,
        customer_id: caller?.userId ?? null,
        email: caller ? null : (body.email ?? null),
      })
      .select("id")
      .single();
    throwOnDbError(error);
    return c.json(data as { id: string }, 201);
  })

  .openapi(myNotifications, async (c) => {
    const caller = c.get("caller");
    let query = caller.db
      .from("notifications")
      .select("id, kind, title, body, data, read_at, created_at")
      .eq("recipient_type", "customer")
      .eq("recipient_id", caller.userId);

    const { unread, limit, offset } = c.req.valid("query");
    if (unread) query = query.is("read_at", null);

    const [rows, unreadCount] = await Promise.all([
      query.order("created_at", { ascending: false }).range(offset, offset + limit - 1),
      caller.db
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("recipient_type", "customer")
        .eq("recipient_id", caller.userId)
        .is("read_at", null),
    ]);
    throwOnDbError(rows.error);
    throwOnDbError(unreadCount.error);

    return c.json(
      {
        items: (
          (rows.data ?? []) as unknown as {
            id: string;
            kind: string;
            title: string;
            body: string | null;
            data: Record<string, unknown>;
            read_at: string | null;
            created_at: string;
          }[]
        ).map((n) => ({
          id: n.id,
          kind: n.kind,
          title: n.title,
          body: n.body,
          data: n.data,
          readAt: n.read_at,
          createdAt: n.created_at,
        })),
        unreadCount: unreadCount.count ?? 0,
      },
      200,
    );
  })

  .openapi(markRead, async (c) => {
    const { id } = c.req.valid("param");
    const caller = c.get("caller");
    const { data, error } = await caller.db
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", id)
      .eq("recipient_id", caller.userId)
      .select("id");
    throwOnDbError(error);
    if (!data || (data as unknown[]).length === 0) {
      throw new HTTPException(404, { message: "No such notification", cause: { code: "not_found" } });
    }
    return c.json({ read: true as const }, 200);
  });
