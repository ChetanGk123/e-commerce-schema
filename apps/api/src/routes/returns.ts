import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { requireAuth, requireStaff } from "../auth";
import { throwOnDbError } from "../errors";
import { paymentsConfigured, refundPayment, toPaise } from "../razorpay";
import { jsonError, pageQuery, validationHook } from "../schemas";
import { serviceClient } from "../supabase";

/**
 * Returns and refunds -- the direction money is hardest to take back.
 *
 * The customer half runs on the caller's own client, because RLS already
 * says the right thing: own_returns_i pins status to 'requested' and
 * requires the order to be theirs, own_return_items_i pins condition to
 * null so nobody grades their own goods. A service-key route here would
 * throw all of that away and have to reimplement it worse.
 */
const ReturnLine = z.object({
  orderItemId: z.string().uuid(),
  quantity: z.number().int(),
  condition: z.string().nullable(),
  sku: z.string().nullable(),
  productName: z.string().nullable(),
});

const ReturnRequest = z
  .object({
    id: z.string().uuid(),
    orderId: z.string().uuid(),
    orderNumber: z.string().nullable(),
    customerId: z.string().uuid().nullable(),
    reason: z.string(),
    status: z.string(),
    resolution: z.string().nullable(),
    note: z.string().nullable(),
    createdAt: z.string(),
    resolvedAt: z.string().nullable(),
    items: z.array(ReturnLine),
  })
  .openapi("ReturnRequest");

const Refund = z
  .object({
    id: z.string().uuid(),
    orderId: z.string().uuid(),
    returnId: z.string().uuid().nullable(),
    amount: z.number(),
    status: z.enum(["initiated", "processed", "failed"]),
    providerRef: z.string().nullable(),
    refundedToDate: z.number(),
    orderTotal: z.number(),
    fullyRefunded: z.boolean(),
    /** Set when the gateway could not be reached; the refund is still recorded. */
    gatewayError: z.string().nullable(),
  })
  .openapi("Refund");

interface ReturnRow {
  id: string;
  order_id: string;
  customer_id: string | null;
  reason: string;
  status: string;
  resolution: string | null;
  note: string | null;
  created_at: string;
  resolved_at: string | null;
  orders: { order_number: string } | null;
  return_items: {
    order_item_id: string;
    quantity: number;
    condition: string | null;
    order_items: { sku: string; product_name: string } | null;
  }[];
}

interface RefundIntent {
  refund_id: string;
  payment_id: string;
  provider: string;
  provider_payment_ref: string | null;
  amount: number;
  refunded_to_date: number;
  order_total: number;
  fully_refunded: boolean;
}

const RETURN_SELECT =
  "id, order_id, customer_id, reason, status, resolution, note, created_at, resolved_at, orders(order_number), return_items(order_item_id, quantity, condition, order_items(sku, product_name))";

const shape = (r: ReturnRow) => ({
  id: r.id,
  orderId: r.order_id,
  orderNumber: r.orders?.order_number ?? null,
  customerId: r.customer_id,
  reason: r.reason,
  status: r.status,
  resolution: r.resolution,
  note: r.note,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
  items: (r.return_items ?? []).map((i) => ({
    orderItemId: i.order_item_id,
    quantity: i.quantity,
    condition: i.condition,
    sku: i.order_items?.sku ?? null,
    productName: i.order_items?.product_name ?? null,
  })),
});

const authErrors = {
  401: jsonError("Missing or invalid token"),
  403: jsonError("Not allowed"),
};

/* ---------- customer ---------- */

const open = createRoute({
  method: "post",
  path: "/returns",
  tags: ["returns"],
  summary: "Ask to return part of an order",
  description:
    "The request and its lines are written together, so a return never exists without the items it is for. Returning more of a line than was bought -- counting every earlier return of it -- is refused by the database.\n\nGuest orders cannot be returned here: there is no account to check ownership against, so those go through support.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            order_id: z.string().uuid(),
            reason: z.string().trim().min(3).max(300),
            items: z
              .array(
                z.object({
                  order_item_id: z.string().uuid(),
                  quantity: z.number().int().positive(),
                }),
              )
              .min(1, "Choose at least one item"),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Opened",
      content: { "application/json": { schema: ReturnRequest } },
    },
    400: jsonError("Invalid body"),
    403: jsonError("That order is not yours"),
    409: jsonError("More than was bought, counting earlier returns"),
    422: jsonError("Nothing to return, or no reason given"),
    401: jsonError("Missing or invalid token"),
  },
});

const mine = createRoute({
  method: "get",
  path: "/returns",
  tags: ["returns"],
  summary: "My returns",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  responses: {
    200: {
      description: "Returns, newest first",
      content: {
        "application/json": { schema: z.object({ items: z.array(ReturnRequest) }) },
      },
    },
    ...authErrors,
  },
});

/* ---------- staff ---------- */

const queue = createRoute({
  method: "get",
  path: "/admin/returns",
  tags: ["admin", "returns"],
  summary: "The returns queue",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    query: z.object({
      status: z
        .enum(["requested", "approved", "rejected", "pickup_scheduled", "received", "refunded", "closed"])
        .optional(),
      ...pageQuery,
    }),
  },
  responses: {
    200: {
      description: "A page of returns",
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(ReturnRequest),
            total: z.number().int().nullable(),
            limit: z.number().int(),
            offset: z.number().int(),
          }),
        },
      },
    },
    ...authErrors,
  },
});

const review = createRoute({
  method: "post",
  path: "/admin/returns/{id}/review",
  tags: ["admin", "returns"],
  summary: "Approve, reject or schedule a pickup",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            decision: z.enum(["approved", "rejected", "pickup_scheduled"]),
            note: z.string().max(500).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Decided",
      content: { "application/json": { schema: ReturnRequest } },
    },
    400: jsonError("Invalid body"),
    404: jsonError("No such return"),
    409: jsonError("Already settled"),
    ...authErrors,
  },
});

const receive = createRoute({
  method: "post",
  path: "/admin/returns/{id}/receive",
  tags: ["admin", "returns"],
  summary: "Book the goods back in",
  description:
    "Resalable units go back to stock as a `return` movement; anything else is recorded as `damage`, so the ledger explains where they went. A store_credit resolution posts the credit in the same transaction.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            resolution: z.enum(["refund", "replacement", "store_credit"]),
            items: z
              .array(
                z.object({
                  order_item_id: z.string().uuid(),
                  quantity: z.number().int().positive(),
                  variant_id: z.string().uuid().nullable().optional(),
                  condition: z.enum(["resalable", "damaged"]).default("resalable"),
                }),
              )
              .min(1),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Booked in",
      content: { "application/json": { schema: ReturnRequest } },
    },
    400: jsonError("Invalid body"),
    404: jsonError("No such return"),
    409: jsonError("Already received or settled"),
    ...authErrors,
  },
});

const refund = createRoute({
  method: "post",
  path: "/admin/orders/{id}/refunds",
  tags: ["admin", "returns"],
  summary: "Send money back",
  description:
    "Records the refund first, then asks the gateway. If the gateway cannot be reached the refund stays `initiated` -- visible and retryable through the settle endpoint -- rather than disappearing.\n\nRefunding more than was captured, counting every earlier refund, is refused. Only a full refund moves the order to `refunded`; a partial one leaves it alone, because `refunded` tells the warehouse to stop shipping goods the customer is still owed.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            amount: z.number().positive().max(10_000_000),
            return_id: z.string().uuid().optional(),
            note: z.string().max(500).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Recorded, and settled if the gateway answered",
      content: { "application/json": { schema: Refund } },
    },
    400: jsonError("Invalid body"),
    404: jsonError("No such order"),
    409: jsonError("Over-refund, or nothing captured to refund against"),
    422: jsonError("Invalid amount"),
    ...authErrors,
  },
});

const settle = createRoute({
  method: "post",
  path: "/admin/refunds/{id}/settle",
  tags: ["admin", "returns"],
  summary: "Record how a refund ended",
  description:
    "For refunds the gateway could not settle inline, and for COD orders, where the money goes back by bank transfer and a human is the only one who knows it happened.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            status: z.enum(["processed", "failed"]),
            provider_ref: z.string().max(120).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Settled",
      content: {
        "application/json": {
          schema: z.object({ id: z.string().uuid(), status: z.string() }),
        },
      },
    },
    400: jsonError("Invalid body"),
    404: jsonError("No such refund"),
    ...authErrors,
  },
});

export const returnsRoute = new OpenAPIHono({ defaultHook: validationHook })
  .openapi(open, async (c) => {
    const body = c.req.valid("json");
    const db = c.get("caller").db;

    const { data, error } = await db.rpc("request_return", {
      p_order_id: body.order_id,
      p_items: body.items,
      p_reason: body.reason,
    });
    // RLS refuses a return on somebody else's order, which arrives as a
    // row-level security violation and maps to 403.
    throwOnDbError(error);

    const created = await db
      .from("return_requests")
      .select(RETURN_SELECT)
      .eq("id", data as unknown as string)
      .single();
    throwOnDbError(created.error);

    return c.json(shape(created.data as unknown as ReturnRow), 201);
  })

  .openapi(mine, async (c) => {
    const { data, error } = await c
      .get("caller")
      .db.from("return_requests")
      .select(RETURN_SELECT)
      .order("created_at", { ascending: false });
    throwOnDbError(error);
    return c.json(
      { items: ((data ?? []) as unknown as ReturnRow[]).map(shape) },
      200,
    );
  })

  .openapi(queue, async (c) => {
    const { status, limit, offset } = c.req.valid("query");
    let query = c
      .get("caller")
      .db.from("return_requests")
      .select(RETURN_SELECT, { count: "exact" });
    if (status) query = query.eq("status", status);

    const { data, error, count } = await query
      .order("created_at", { ascending: true })
      .range(offset, offset + limit - 1);
    throwOnDbError(error);

    return c.json(
      {
        items: ((data ?? []) as unknown as ReturnRow[]).map(shape),
        total: count ?? null,
        limit,
        offset,
      },
      200,
    );
  })

  .openapi(review, async (c) => {
    const { id } = c.req.valid("param");
    const { decision, note } = c.req.valid("json");
    const db = c.get("caller").db;

    const { error } = await db.rpc("admin_review_return", {
      p_return_id: id,
      p_decision: decision,
      p_note: note ?? null,
    });
    throwOnDbError(error);

    const after = await db.from("return_requests").select(RETURN_SELECT).eq("id", id).single();
    throwOnDbError(after.error);
    c.get("log")?.info({ returnId: id, decision }, "returns.reviewed");
    return c.json(shape(after.data as unknown as ReturnRow), 200);
  })

  .openapi(receive, async (c) => {
    const { id } = c.req.valid("param");
    const { resolution, items } = c.req.valid("json");
    const db = c.get("caller").db;

    const { error } = await db.rpc("admin_receive_return", {
      p_return_id: id,
      p_items: items,
      p_resolution: resolution,
    });
    throwOnDbError(error);

    const after = await db.from("return_requests").select(RETURN_SELECT).eq("id", id).single();
    throwOnDbError(after.error);
    c.get("log")?.info({ returnId: id, resolution }, "returns.received");
    return c.json(shape(after.data as unknown as ReturnRow), 200);
  })

  .openapi(refund, async (c) => {
    const { id } = c.req.valid("param");
    const { amount, return_id, note } = c.req.valid("json");
    const db = c.get("caller").db;
    const log = c.get("log");

    // Recorded before the gateway is asked. The reverse order loses the
    // refund entirely if the process dies mid-call, and the customer has
    // already been told it is on its way.
    const { data, error } = await db.rpc("admin_refund", {
      p_order_id: id,
      p_amount: amount,
      p_return_id: return_id ?? null,
      p_note: note ?? null,
    });
    throwOnDbError(error);
    const intent = data as unknown as RefundIntent;

    let status: "initiated" | "processed" = "initiated";
    let providerRef: string | null = null;
    let gatewayError: string | null = null;

    if (
      intent.provider === "razorpay" &&
      intent.provider_payment_ref &&
      paymentsConfigured()
    ) {
      try {
        providerRef = await refundPayment(
          intent.provider_payment_ref,
          toPaise(Number(intent.amount)),
        );
        // settle_refund runs on the service key: it moves the order to
        // 'refunded' and closes the return, which is system work rather
        // than something attributable to the staff member who clicked.
        const settled = await serviceClient().rpc("settle_refund", {
          p_refund_id: intent.refund_id,
          p_status: "processed",
          p_provider_ref: providerRef,
        });
        throwOnDbError(settled.error);
        status = "processed";
      } catch (err) {
        // The refund row survives as 'initiated'. That is the point.
        gatewayError = "gateway_unreachable";
        log?.error(
          { err, refundId: intent.refund_id },
          "returns.gateway_refund_failed",
        );
      }
    } else {
      // COD, store credit, or a deployment with no gateway keys: a human
      // moves the money and settles it through /admin/refunds/{id}/settle.
      gatewayError = null;
    }

    log?.info(
      { refundId: intent.refund_id, orderId: id, status },
      "returns.refund",
    );

    return c.json(
      {
        id: intent.refund_id,
        orderId: id,
        returnId: return_id ?? null,
        amount: Number(intent.amount),
        status,
        providerRef,
        refundedToDate: Number(intent.refunded_to_date),
        orderTotal: Number(intent.order_total),
        fullyRefunded: intent.fully_refunded,
        gatewayError,
      },
      201,
    );
  })

  .openapi(settle, async (c) => {
    const { id } = c.req.valid("param");
    const { status, provider_ref } = c.req.valid("json");

    const { error } = await serviceClient().rpc("settle_refund", {
      p_refund_id: id,
      p_status: status,
      p_provider_ref: provider_ref ?? null,
    });
    throwOnDbError(error);

    const after = await c
      .get("caller")
      .db.from("refunds")
      .select("id, status")
      .eq("id", id)
      .maybeSingle();
    throwOnDbError(after.error);
    if (!after.data) {
      throw new HTTPException(404, {
        message: "No such refund",
        cause: { code: "not_found" },
      });
    }

    c.get("log")?.info({ refundId: id, status }, "returns.refund_settled");
    return c.json(after.data as { id: string; status: string }, 200);
  });
