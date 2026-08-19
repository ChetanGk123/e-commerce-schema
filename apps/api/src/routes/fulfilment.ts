import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireAuth, requireStaff } from "../auth";
import { throwOnDbError } from "../errors";
import { jsonError, validationHook } from "../schemas";

/**
 * Dispatch.
 *
 * One call, because a shipment is four writes -- the shipment, its lines,
 * the order's status and the timeline event -- and a half-shipped order
 * is one the warehouse has physically sent and the customer cannot see.
 *
 * Note what shipping does NOT do: move stock. The units left the ledger
 * at capture, as a 'sale'. Decrementing again here would count every sale
 * twice, and it is the kind of double-count that only surfaces at a
 * stocktake months later.
 */
const Shipment = z
  .object({
    id: z.string().uuid(),
    orderId: z.string().uuid(),
    carrier: z.string().nullable(),
    trackingNumber: z.string().nullable(),
    trackingUrl: z.string().nullable(),
    status: z.string(),
    shippedAt: z.string().nullable(),
    deliveredAt: z.string().nullable(),
    items: z.array(
      z.object({
        orderItemId: z.string().uuid(),
        quantity: z.number().int(),
        sku: z.string().nullable(),
        productName: z.string().nullable(),
      }),
    ),
  })
  .openapi("Shipment");

interface ShipmentRow {
  id: string;
  order_id: string;
  carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  status: string;
  shipped_at: string | null;
  delivered_at: string | null;
  shipment_items: {
    order_item_id: string;
    quantity: number;
    order_items: { sku: string; product_name: string } | null;
  }[];
}

const authErrors = {
  401: jsonError("Missing or invalid token"),
  403: jsonError("Authenticated, but not active staff"),
};

const SHIPMENT_SELECT =
  "id, order_id, carrier, tracking_number, tracking_url, status, shipped_at, delivered_at, shipment_items(order_item_id, quantity, order_items(sku, product_name))";

const shape = (s: ShipmentRow) => ({
  id: s.id,
  orderId: s.order_id,
  carrier: s.carrier,
  trackingNumber: s.tracking_number,
  trackingUrl: s.tracking_url,
  status: s.status,
  shippedAt: s.shipped_at,
  deliveredAt: s.delivered_at,
  items: (s.shipment_items ?? []).map((i) => ({
    orderItemId: i.order_item_id,
    quantity: i.quantity,
    sku: i.order_items?.sku ?? null,
    productName: i.order_items?.product_name ?? null,
  })),
});

const ship = createRoute({
  method: "post",
  path: "/admin/orders/{id}/shipments",
  tags: ["admin", "fulfilment"],
  summary: "Dispatch some or all of an order",
  description:
    "Creates the shipment, its lines, moves the order to `shipped` and writes the timeline event -- in one transaction, via admin_ship_order.\n\nShipping more of a line than was ordered is refused by the database, counting every earlier shipment of that line. An unpaid order cannot be shipped.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            items: z
              .array(
                z.object({
                  order_item_id: z.string().uuid(),
                  quantity: z.number().int().positive(),
                }),
              )
              .min(1, "Ship at least one line"),
            carrier: z.string().max(60).optional(),
            tracking_number: z.string().max(80).optional(),
            tracking_url: z.string().url().max(500).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Dispatched",
      content: { "application/json": { schema: Shipment } },
    },
    400: jsonError("Invalid body"),
    404: jsonError("No such order"),
    409: jsonError("More than was ordered, or the order is unpaid"),
    ...authErrors,
  },
});

const listShipments = createRoute({
  method: "get",
  path: "/admin/orders/{id}/shipments",
  tags: ["admin", "fulfilment"],
  summary: "Everything dispatched against an order",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: "Shipments, oldest first",
      content: {
        "application/json": { schema: z.object({ items: z.array(Shipment) }) },
      },
    },
    ...authErrors,
  },
});

export const fulfilmentRoute = new OpenAPIHono({ defaultHook: validationHook })
  .openapi(ship, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = c.get("caller").db;

    const { data, error } = await db.rpc("admin_ship_order", {
      p_order_id: id,
      p_items: body.items,
      p_carrier: body.carrier ?? null,
      p_tracking_number: body.tracking_number ?? null,
      p_tracking_url: body.tracking_url ?? null,
    });
    throwOnDbError(error);

    const created = await db
      .from("shipments")
      .select(SHIPMENT_SELECT)
      .eq("id", data as unknown as string)
      .single();
    throwOnDbError(created.error);

    c.get("log")?.info(
      { orderId: id, shipmentId: data, carrier: body.carrier },
      "fulfilment.shipped",
    );

    return c.json(shape(created.data as unknown as ShipmentRow), 201);
  })

  .openapi(listShipments, async (c) => {
    const { id } = c.req.valid("param");
    const { data, error } = await c
      .get("caller")
      .db.from("shipments")
      .select(SHIPMENT_SELECT)
      .eq("order_id", id)
      .order("created_at", { ascending: true });
    throwOnDbError(error);

    return c.json(
      { items: ((data ?? []) as unknown as ShipmentRow[]).map(shape) },
      200,
    );
  });
