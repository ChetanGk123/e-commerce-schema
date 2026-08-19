import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireAuth, requireStaff } from "../auth";
import { throwOnDbError } from "../errors";
import { jsonError, pageQuery, validationHook } from "../schemas";

/**
 * The stock ledger, for the people who move stock by hand.
 *
 * The one rule this whole file exists to keep: NOTHING here writes
 * product_variants.stock. That column is a cache maintained by
 * apply_inventory_movement() from the rows below, in the same
 * transaction, and CHECK (stock >= 0) is the oversell guard. An UPDATE
 * that set it directly would not be refused by anything -- it would just
 * make the number disagree with its own history, and the ledger is what
 * an auditor reads.
 *
 * Writes go through record_stock_movement(), whose allow-list refuses
 * 'sale', 'reservation' and 'release'. Those belong to checkout and
 * capture: a release row consumes a hold, so an admin endpoint able to
 * write one could invent stock.
 */
const MOVEMENT_REASONS = ["purchase", "adjustment", "damage", "return"] as const;

const Movement = z
  .object({
    id: z.string().uuid(),
    variantId: z.string().uuid(),
    sku: z.string().nullable(),
    productName: z.string().nullable(),
    quantity: z.number().int(),
    reason: z.string(),
    orderId: z.string().uuid().nullable(),
    orderNumber: z.string().nullable(),
    note: z.string().nullable(),
    createdBy: z.string().uuid().nullable(),
    expiresAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("InventoryMovement");

const LowStockRow = z
  .object({
    variantId: z.string().uuid(),
    productId: z.string().uuid(),
    productName: z.string(),
    sku: z.string(),
    title: z.string().nullable(),
    stock: z.number().int(),
    lowStockThreshold: z.number().int(),
  })
  .openapi("LowStockRow");

const Health = z
  .object({
    heldReservations: z.number().int(),
    heldUnits: z.number().int(),
    /** Expired holds nobody released. Zero, in a healthy system. */
    strandedReservations: z.number().int(),
    strandedUnits: z.number().int(),
    oldestStrandedAt: z.string().nullable(),
    lastAutoRelease: z.string().nullable(),
    sweeperInstalled: z.boolean(),
    sweeperScheduled: z.boolean(),
    sweeperSchedule: z.string().nullable(),
    /** Set when the numbers say something needs doing. */
    warning: z.string().nullable(),
  })
  .openapi("InventoryHealth");

interface MovementRow {
  id: string;
  variant_id: string;
  quantity: number;
  reason: string;
  order_id: string | null;
  note: string | null;
  created_by: string | null;
  expires_at: string | null;
  created_at: string;
  product_variants: { sku: string; products: { name: string } | null } | null;
  orders: { order_number: string } | null;
}

interface HealthRow {
  held_reservations: number;
  held_units: number;
  stranded_reservations: number;
  stranded_units: number;
  oldest_stranded_at: string | null;
  last_auto_release: string | null;
  sweeper_installed: boolean;
  sweeper_scheduled: boolean;
  sweeper_schedule: string | null;
}

const authErrors = {
  401: jsonError("Missing or invalid token"),
  403: jsonError("Authenticated, but not active staff"),
};

const listMovements = createRoute({
  method: "get",
  path: "/admin/inventory/movements",
  tags: ["admin", "inventory"],
  summary: "The stock ledger",
  description:
    "Newest first. Every change to a variant's stock is one row here -- sales, reservations and releases from checkout, and receipts, counts and write-offs from staff.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    query: z.object({
      variant_id: z.string().uuid().optional(),
      order_id: z.string().uuid().optional(),
      reason: z
        .enum(["purchase", "sale", "return", "adjustment", "damage", "reservation", "release"])
        .optional(),
      since: z.string().datetime().optional(),
      ...pageQuery,
    }),
  },
  responses: {
    200: {
      description: "A page of movements",
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(Movement),
            total: z.number().int().nullable(),
            limit: z.number().int(),
            offset: z.number().int(),
          }),
        },
      },
    },
    400: jsonError("Invalid query parameters"),
    ...authErrors,
  },
});

const addMovement = createRoute({
  method: "post",
  path: "/admin/inventory/movements",
  tags: ["admin", "inventory"],
  summary: "Receive, adjust, write off or restock a variant",
  description:
    "The only way to change stock. `sale`, `reservation` and `release` are refused here by design -- they belong to checkout and payment capture, and a release row consumes a stock hold.\n\nThe note is mandatory: an adjustment without a reason is unauditable.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            variant_id: z.string().uuid(),
            quantity: z.number().int().refine((n) => n !== 0, "Use a non-zero quantity"),
            reason: z.enum(MOVEMENT_REASONS),
            note: z.string().trim().min(3).max(500),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Recorded",
      content: {
        "application/json": {
          schema: z.object({ id: z.string().uuid(), stock: z.number().int() }),
        },
      },
    },
    400: jsonError("Invalid body"),
    409: jsonError("The adjustment would take stock below zero"),
    422: jsonError("Wrong sign, missing note, or a reason that is not manual"),
    ...authErrors,
  },
});

const lowStock = createRoute({
  method: "get",
  path: "/admin/inventory/low-stock",
  tags: ["admin", "inventory"],
  summary: "Variants at or under their threshold",
  description:
    "Reads admin_low_stock, which is backed by idx_variants_low_stock -- a partial index on exactly this predicate, so it stays cheap as the catalog grows.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  responses: {
    200: {
      description: "The reorder queue",
      content: {
        "application/json": { schema: z.object({ items: z.array(LowStockRow) }) },
      },
    },
    ...authErrors,
  },
});

const health = createRoute({
  method: "get",
  path: "/admin/inventory/health",
  tags: ["admin", "inventory"],
  summary: "Reservation monitor",
  description:
    "`strandedReservations` is the number that matters: holds that expired and were never released. It should be zero. Anything else means release_expired_reservations() is not running, and that stock is unsellable until someone notices.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  responses: {
    200: {
      description: "Current state of stock holds",
      content: { "application/json": { schema: Health } },
    },
    ...authErrors,
  },
});

export const inventoryRoute = new OpenAPIHono({ defaultHook: validationHook })
  .openapi(listMovements, async (c) => {
    const { variant_id, order_id, reason, since, limit, offset } =
      c.req.valid("query");
    const db = c.get("caller").db;

    let query = db
      .from("inventory_movements")
      .select(
        "id, variant_id, quantity, reason, order_id, note, created_by, expires_at, created_at, product_variants(sku, products(name)), orders(order_number)",
        { count: "exact" },
      );

    if (variant_id) query = query.eq("variant_id", variant_id);
    if (order_id) query = query.eq("order_id", order_id);
    if (reason) query = query.eq("reason", reason);
    if (since) query = query.gte("created_at", since);

    const { data, error, count } = await query
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    throwOnDbError(error);

    return c.json(
      {
        items: ((data ?? []) as unknown as MovementRow[]).map((m) => ({
          id: m.id,
          variantId: m.variant_id,
          sku: m.product_variants?.sku ?? null,
          productName: m.product_variants?.products?.name ?? null,
          quantity: m.quantity,
          reason: m.reason,
          orderId: m.order_id,
          orderNumber: m.orders?.order_number ?? null,
          note: m.note,
          createdBy: m.created_by,
          expiresAt: m.expires_at,
          createdAt: m.created_at,
        })),
        total: count ?? null,
        limit,
        offset,
      },
      200,
    );
  })

  .openapi(addMovement, async (c) => {
    const { variant_id, quantity, reason, note } = c.req.valid("json");
    const db = c.get("caller").db;

    // caller.db, not the service key: record_stock_movement takes
    // created_by from auth.uid(), and the stock update it triggers is
    // audited on product_variants from the same place.
    const { data, error } = await db.rpc("record_stock_movement", {
      p_variant_id: variant_id,
      p_quantity: quantity,
      p_reason: reason,
      p_note: note,
    });
    throwOnDbError(error);

    // Read the cache back so the caller sees the number the ledger
    // produced rather than one this handler computed.
    const after = await db
      .from("product_variants")
      .select("stock")
      .eq("id", variant_id)
      .single();
    throwOnDbError(after.error);

    c.get("log")?.info(
      { variantId: variant_id, quantity, reason },
      "inventory.movement",
    );

    return c.json(
      { id: data as unknown as string, stock: (after.data as { stock: number }).stock },
      201,
    );
  })

  .openapi(lowStock, async (c) => {
    const { data, error } = await c
      .get("caller")
      .db.from("admin_low_stock")
      .select("variant_id, product_id, product_name, sku, title, stock, low_stock_threshold")
      .order("stock", { ascending: true });
    throwOnDbError(error);

    return c.json(
      {
        items: (
          (data ?? []) as unknown as {
            variant_id: string;
            product_id: string;
            product_name: string;
            sku: string;
            title: string | null;
            stock: number;
            low_stock_threshold: number;
          }[]
        ).map((r) => ({
          variantId: r.variant_id,
          productId: r.product_id,
          productName: r.product_name,
          sku: r.sku,
          title: r.title,
          stock: r.stock,
          lowStockThreshold: r.low_stock_threshold,
        })),
      },
      200,
    );
  })

  .openapi(health, async (c) => {
    const { data, error } = await c.get("caller").db.rpc("inventory_health");
    throwOnDbError(error);
    const h = data as unknown as HealthRow;

    // Said in words, because a dashboard number nobody interprets is a
    // number nobody acts on. Order matters: not installed is worse than
    // not scheduled, which is worse than a backlog.
    const warning = !h.sweeper_installed
      ? "release_expired_reservations() does not exist in this database. Expired stock holds are never returned."
      : !h.sweeper_scheduled
        ? "The reservation sweeper is not scheduled. Apply supabase/jobs/retention.sql."
        : h.stranded_reservations > 0
          ? `${h.stranded_units} unit(s) are held by ${h.stranded_reservations} expired reservation(s) the sweeper has not cleared.`
          : null;

    if (warning) c.get("log")?.warn({ warning }, "inventory.health");

    return c.json(
      {
        heldReservations: h.held_reservations,
        heldUnits: h.held_units,
        strandedReservations: h.stranded_reservations,
        strandedUnits: h.stranded_units,
        oldestStrandedAt: h.oldest_stranded_at,
        lastAutoRelease: h.last_auto_release,
        sweeperInstalled: h.sweeper_installed,
        sweeperScheduled: h.sweeper_scheduled,
        sweeperSchedule: h.sweeper_schedule,
        warning,
      },
      200,
    );
  });
