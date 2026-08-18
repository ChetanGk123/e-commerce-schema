import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HTTPException } from "hono/http-exception";

import { optionalAuth } from "../auth";
import { throwOnDbError } from "../errors";
import { jsonError, validationHook } from "../schemas";
import { anonClient, serviceClient } from "../supabase";

/**
 * Carts, for shoppers who have not signed in yet and for those who have.
 *
 * A signed-in cart goes through the caller's own client, so own_carts and
 * own_cart_items decide what they can touch. A guest cart cannot: the schema
 * says so in as many words -- "there is no trustworthy session identity in a
 * JWT-less request" -- so `carts` has no policy for anon at all, and guest
 * carts are handled here on the service key.
 *
 * That makes X-Cart-Session a bearer credential, not an identifier. It is
 * generated here (a v4 uuid, never derived from anything the client sends),
 * and whoever holds it owns that cart. It is worth exactly one anonymous
 * basket, which is why it is acceptable -- but it must never be logged, put
 * in a URL, or accepted as proof of anything beyond the cart.
 */
const SESSION_HEADER = "X-Cart-Session";

interface CartRow {
  id: string;
  customer_id: string | null;
  session_id: string | null;
  status: string;
}

interface ItemRow {
  id: string;
  variant_id: string;
  quantity: number;
}

interface PricedVariant {
  id: string;
  product_id: string;
  sku: string;
  title: string | null;
  price: number;
  currency: string;
  stock: number;
  is_purchasable: boolean;
  weight_grams: number | null;
}

const CartLine = z
  .object({
    variantId: z.string().uuid(),
    productId: z.string().uuid(),
    sku: z.string(),
    title: z.string().nullable(),
    unitPrice: z.number(),
    quantity: z.number().int(),
    lineTotal: z.number(),
    /** False when the variant went out of stock or was archived after it was added. */
    available: z.boolean(),
    stock: z.number().int(),
  })
  .openapi("CartLine");

const Cart = z
  .object({
    id: z.string().uuid().nullable(),
    /** Present only for guest carts. Send it back as X-Cart-Session. */
    sessionId: z.string().uuid().nullable(),
    items: z.array(CartLine),
    subtotal: z.number(),
    currency: z.string().nullable(),
    weightGrams: z.number().int(),
    /** True when every line is still buyable at the quantity requested. */
    checkoutable: z.boolean(),
  })
  .openapi("Cart");

/** Matches cart_items.quantity's CHECK, so a refusal is a 400 not a 500. */
const quantity = z.number().int().min(1).max(10_000);

/* ---------- resolution ---------- */

interface Resolved {
  db: SupabaseClient;
  cart: CartRow | null;
  /** Set when this request created (or carries) a guest session. */
  sessionId: string | null;
}

/**
 * Which cart, on which client. Reading is side-effect free: a shopper with no
 * cart gets an empty one rather than a row in the database, because a GET that
 * writes turns every crawler into a cart.
 */
async function resolve(
  c: { get: (k: "caller") => { userId: string; db: SupabaseClient } | undefined; req: { header: (h: string) => string | undefined } },
  create: boolean,
): Promise<Resolved> {
  const caller = c.get("caller");

  if (caller) {
    const db = caller.db;
    const { data, error } = await db
      .from("carts")
      .select("id, customer_id, session_id, status")
      .eq("customer_id", caller.userId)
      .eq("status", "active")
      .maybeSingle();
    throwOnDbError(error);

    if (data) return { db, cart: data as unknown as CartRow, sessionId: null };
    if (!create) return { db, cart: null, sessionId: null };

    const made = await db
      .from("carts")
      .insert({ customer_id: caller.userId })
      .select("id, customer_id, session_id, status")
      .single();
    throwOnDbError(made.error);
    return { db, cart: made.data as unknown as CartRow, sessionId: null };
  }

  // Guest.
  const db = serviceClient();
  const supplied = c.req.header(SESSION_HEADER);

  if (supplied) {
    const { data, error } = await db
      .from("carts")
      .select("id, customer_id, session_id, status")
      .eq("session_id", supplied)
      .eq("status", "active")
      .maybeSingle();
    throwOnDbError(error);
    if (data) {
      return { db, cart: data as unknown as CartRow, sessionId: supplied };
    }
  }

  if (!create) return { db, cart: null, sessionId: supplied ?? null };

  // A session id the client suggested is never reused as-is -- that would let
  // one shopper claim another's cart id by guessing it.
  const sessionId = crypto.randomUUID();
  const made = await db
    .from("carts")
    .insert({ session_id: sessionId })
    .select("id, customer_id, session_id, status")
    .single();
  throwOnDbError(made.error);
  return { db, cart: made.data as unknown as CartRow, sessionId };
}

/** Prices a cart from the public catalog, so cost_price cannot appear here. */
async function price(
  db: SupabaseClient,
  cart: CartRow | null,
  sessionId: string | null,
): Promise<z.infer<typeof Cart>> {
  const empty = {
    id: cart?.id ?? null,
    sessionId,
    items: [],
    subtotal: 0,
    currency: null,
    weightGrams: 0,
    checkoutable: false,
  };
  if (!cart) return empty;

  const { data, error } = await db
    .from("cart_items")
    .select("id, variant_id, quantity")
    .eq("cart_id", cart.id);
  throwOnDbError(error);
  const items = (data ?? []) as unknown as ItemRow[];
  if (items.length === 0) return { ...empty, id: cart.id };

  const variants = await anonClient()
    .from("storefront_variants")
    .select("id, product_id, sku, title, price, currency, stock, is_purchasable, weight_grams")
    .in(
      "id",
      items.map((i) => i.variant_id),
    );
  throwOnDbError(variants.error);
  const byId = new Map(
    ((variants.data ?? []) as unknown as PricedVariant[]).map((v) => [v.id, v]),
  );

  const lines = items.flatMap((i) => {
    const v = byId.get(i.variant_id);
    // Archived or unpublished since it was added: the view stops returning it.
    if (!v) return [];
    return [
      {
        variantId: v.id,
        productId: v.product_id,
        sku: v.sku,
        title: v.title,
        unitPrice: v.price,
        quantity: i.quantity,
        lineTotal: Math.round(v.price * i.quantity * 100) / 100,
        available: v.is_purchasable && v.stock >= i.quantity,
        stock: v.stock,
      },
    ];
  });

  return {
    id: cart.id,
    sessionId,
    items: lines,
    subtotal: Math.round(lines.reduce((s, l) => s + l.lineTotal, 0) * 100) / 100,
    currency: byId.get(items[0]!.variant_id)?.currency ?? null,
    weightGrams: items.reduce(
      (s, i) => s + (byId.get(i.variant_id)?.weight_grams ?? 0) * i.quantity,
      0,
    ),
    // Dropped lines count against it too: a cart that lost an item is not
    // one the shopper should be allowed to submit without noticing.
    checkoutable:
      lines.length === items.length &&
      lines.length > 0 &&
      lines.every((l) => l.available),
  };
}

/** The session id goes back in a header as well as the body, so a client that
 *  only reads headers still keeps its cart. */
function withSession<T>(
  c: { header: (k: string, v: string) => void },
  sessionId: string | null,
  body: T,
): T {
  if (sessionId) c.header(SESSION_HEADER, sessionId);
  return body;
}

/* ---------- routes ---------- */

const responses = {
  200: { description: "The cart", content: { "application/json": { schema: Cart } } },
  400: jsonError("Invalid request"),
  401: jsonError("A token was sent but is not valid"),
  404: jsonError("No such cart or line"),
};

const getCart = createRoute({
  method: "get",
  path: "/cart",
  tags: ["cart"],
  summary: "The current cart",
  description:
    "Signed in, this is the caller's active cart. Otherwise it is the cart named by X-Cart-Session. Reading never creates one -- an empty cart is returned with a null id, and the first POST is what commits a row.",
  security: [{ bearerAuth: [] }],
  middleware: [optionalAuth] as const,
  responses,
});

const addItem = createRoute({
  method: "post",
  path: "/cart/items",
  tags: ["cart"],
  summary: "Add a variant to the cart",
  description:
    "Adds to the existing quantity rather than replacing it, which is what a second click on 'Add to basket' means. Creates the cart if there is not one yet; a guest gets a new X-Cart-Session in the response.",
  security: [{ bearerAuth: [] }],
  middleware: [optionalAuth] as const,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ variant_id: z.string().uuid(), quantity: quantity.default(1) }),
        },
      },
    },
  },
  responses,
});

const setItem = createRoute({
  method: "patch",
  path: "/cart/items/{variantId}",
  tags: ["cart"],
  summary: "Set the quantity of a line",
  security: [{ bearerAuth: [] }],
  middleware: [optionalAuth] as const,
  request: {
    params: z.object({ variantId: z.string().uuid() }),
    body: { content: { "application/json": { schema: z.object({ quantity }) } } },
  },
  responses,
});

const removeItem = createRoute({
  method: "delete",
  path: "/cart/items/{variantId}",
  tags: ["cart"],
  summary: "Remove a line",
  security: [{ bearerAuth: [] }],
  middleware: [optionalAuth] as const,
  request: { params: z.object({ variantId: z.string().uuid() }) },
  responses,
});

const mergeCart = createRoute({
  method: "post",
  path: "/cart/merge",
  tags: ["cart"],
  summary: "Adopt a guest cart after signing in",
  description:
    "Call this once, immediately after login, with the guest's X-Cart-Session. Quantities are summed into the customer's active cart and the guest cart is marked abandoned. Without it the guest basket is silently orphaned -- uniq_active_cart_per_customer means the account already has its own.",
  security: [{ bearerAuth: [] }],
  middleware: [optionalAuth] as const,
  responses: { ...responses, 401: jsonError("Sign-in required") },
});

export const cartRoute = new OpenAPIHono({ defaultHook: validationHook })
  .openapi(getCart, async (c) => {
    const { db, cart, sessionId } = await resolve(c, false);
    return c.json(withSession(c, sessionId, await price(db, cart, sessionId)), 200);
  })

  .openapi(addItem, async (c) => {
    const { variant_id, quantity: qty } = c.req.valid("json");
    const { db, cart, sessionId } = await resolve(c, true);

    const existing = await db
      .from("cart_items")
      .select("id, quantity")
      .eq("cart_id", cart!.id)
      .eq("variant_id", variant_id)
      .maybeSingle();
    throwOnDbError(existing.error);

    const current = (existing.data as { quantity: number } | null)?.quantity ?? 0;
    // Clamped rather than refused: hitting the cap by adding one more is not
    // an error worth an error page.
    const next = Math.min(current + qty, 10_000);

    const written = await db
      .from("cart_items")
      .upsert({ cart_id: cart!.id, variant_id, quantity: next }, { onConflict: "cart_id,variant_id" });
    throwOnDbError(written.error);

    return c.json(withSession(c, sessionId, await price(db, cart, sessionId)), 200);
  })

  .openapi(setItem, async (c) => {
    const { variantId } = c.req.valid("param");
    const { quantity: qty } = c.req.valid("json");
    const { db, cart, sessionId } = await resolve(c, false);
    if (!cart) throw new HTTPException(404, { message: "No cart", cause: { code: "not_found" } });

    const { error } = await db
      .from("cart_items")
      .update({ quantity: qty })
      .eq("cart_id", cart.id)
      .eq("variant_id", variantId);
    throwOnDbError(error);

    return c.json(withSession(c, sessionId, await price(db, cart, sessionId)), 200);
  })

  .openapi(removeItem, async (c) => {
    const { variantId } = c.req.valid("param");
    const { db, cart, sessionId } = await resolve(c, false);
    if (!cart) throw new HTTPException(404, { message: "No cart", cause: { code: "not_found" } });

    const { error } = await db
      .from("cart_items")
      .delete()
      .eq("cart_id", cart.id)
      .eq("variant_id", variantId);
    throwOnDbError(error);

    return c.json(withSession(c, sessionId, await price(db, cart, sessionId)), 200);
  })

  .openapi(mergeCart, async (c) => {
    const caller = c.get("caller");
    if (!caller) {
      throw new HTTPException(401, { message: "Missing bearer token" });
    }
    const guestSession = c.req.header(SESSION_HEADER);
    if (!guestSession) {
      throw new HTTPException(400, {
        message: `Send the guest cart's ${SESSION_HEADER}`,
        cause: { code: "missing_session" },
      });
    }

    // Service key: the guest cart belongs to nobody, so the caller's own
    // client cannot see it.
    const svc = serviceClient();
    const guest = await svc
      .from("carts")
      .select("id, customer_id, session_id, status")
      .eq("session_id", guestSession)
      .eq("status", "active")
      .maybeSingle();
    throwOnDbError(guest.error);

    const { db, cart } = await resolve(c, true);

    if (guest.data) {
      const guestCart = guest.data as unknown as CartRow;
      const lines = await svc
        .from("cart_items")
        .select("variant_id, quantity")
        .eq("cart_id", guestCart.id);
      throwOnDbError(lines.error);

      for (const line of (lines.data ?? []) as unknown as ItemRow[]) {
        const existing = await db
          .from("cart_items")
          .select("quantity")
          .eq("cart_id", cart!.id)
          .eq("variant_id", line.variant_id)
          .maybeSingle();
        throwOnDbError(existing.error);

        const merged = Math.min(
          ((existing.data as { quantity: number } | null)?.quantity ?? 0) + line.quantity,
          10_000,
        );
        const up = await db
          .from("cart_items")
          .upsert(
            { cart_id: cart!.id, variant_id: line.variant_id, quantity: merged },
            { onConflict: "cart_id,variant_id" },
          );
        throwOnDbError(up.error);
      }

      // Abandoned, not converted: converted requires an order, and
      // carts_converted_has_order would refuse the row.
      const closed = await svc
        .from("carts")
        .update({ status: "abandoned" })
        .eq("id", guestCart.id);
      throwOnDbError(closed.error);
    }

    return c.json(await price(db, cart, null), 200);
  });
