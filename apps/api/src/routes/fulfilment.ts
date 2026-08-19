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

/**
 * Everything after dispatch, which until now did not exist.
 *
 * Six of the seven values shipments.status allows were unreachable:
 * admin_ship_order() wrote 'label_created' and nothing could move one
 * afterwards, so delivered_at stayed null forever and orders.status
 * could never become 'delivered'. Every order this store fulfilled
 * stayed "shipped".
 */
const updateShipment = createRoute({
  method: "patch",
  path: "/admin/shipments/{id}",
  tags: ["admin", "fulfilment"],
  summary: "Advance a shipment",
  description:
    "Moves a parcel through `picked_up`, `in_transit`, `out_for_delivery`, `delivered`, or ends it at `rto` or `lost`.\n\n**The order follows the last parcel, not this one.** An order can be fulfilled in parts, so marking one shipment delivered while another is in transit does not tell the customer their order arrived -- the order becomes `delivered` only when nothing on it is still outstanding. The response says what the order's status is now.\n\n`rto` and `lost` deliberately leave the order alone: a returned or lost parcel needs a person to choose between a refund, a reship and a carrier claim.\n\nRepeating a status already set is a no-op rather than an error, so a courier webhook redelivering `delivered` is harmless.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            status: z.enum([
              "label_created",
              "picked_up",
              "in_transit",
              "out_for_delivery",
              "delivered",
              "rto",
              "lost",
            ]),
            /** Defaults to now. Useful when the courier's timestamp is authoritative. */
            at: z.string().datetime().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated, with the order's resulting status",
      content: {
        "application/json": {
          schema: z.object({
            shipment: Shipment,
            orderStatus: z.string(),
          }),
        },
      },
    },
    400: jsonError("Unknown status"),
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
    404: jsonError("No such shipment"),
    409: jsonError("The order is cancelled or refunded"),
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
  })

  .openapi(updateShipment, async (c) => {
    const { id } = c.req.valid("param");
    const { status, at } = c.req.valid("json");
    const db = c.get("caller").db;

    // The RPC, not two UPDATEs: it touches the shipment, the order and
    // the timeline, and a half-moved order is worse than an unmoved one.
    const { data: orderStatus, error } = await db.rpc("admin_update_shipment", {
      p_shipment_id: id,
      p_status: status,
      p_at: at ?? null,
    });
    throwOnDbError(error);

    const after = await db.from("shipments").select(SHIPMENT_SELECT).eq("id", id).single();
    throwOnDbError(after.error);

    c.get("log")?.info({ id, status, orderStatus }, "fulfilment.shipment_updated");
    return c.json(
      {
        shipment: shape(after.data as unknown as ShipmentRow),
        orderStatus: orderStatus as unknown as string,
      },
      200,
    );
  });
