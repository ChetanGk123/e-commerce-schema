import { ACTOR_TYPES, ORDER_STATUSES, PAYMENT_STATUSES } from "@ecom/schema/enums";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { type Caller, requireAuth, requireStaff } from "../auth";
import { throwOnDbError } from "../errors";
import { serviceClient } from "../supabase";
import { idempotent } from "../idempotency";
import { jsonError, pageQuery, validationHook } from "../schemas";

/**
 * Orders -- the reads, and the two state changes that had none.
 *
 * Everything else in this API could already act on an order: invoice it,
 * ship it, refund it, credit-note it. Nothing could show one. `orders`
 * was read in exactly one place in the whole service (a guest lookup in
 * payments.ts), so "my orders" and the admin order console both had
 * nothing to call.
 *
 * Two shapes rather than one, and the split is the point. A customer's
 * order must not carry `risk_score`, `risk_flags` or the UTM columns --
 * those are our notes about them, not their record of what they bought.
 * A single shape with nullable fields would leak by default the first
 * time somebody forgot to strip them.
 */

const AddressSnapshot = z
  .object({
    label: z.string().optional(),
    line1: z.string(),
    line2: z.string().nullable().optional(),
    city: z.string(),
    state: z.string(),
    postal_code: z.string(),
    country: z.string(),
  })
  // Snapshots are frozen copies written at checkout. One taken a year ago
  // predates whatever addressSchema says today, so describe the keys we
  // rely on and pass the rest through rather than dropping them.
  .passthrough()
  .openapi("AddressSnapshot");

const OrderItem = z
  .object({
    id: z.string().uuid(),
    variantId: z.string().uuid().nullable(),
    productName: z.string(),
    variantTitle: z.string(),
    sku: z.string(),
    unitPrice: z.number(),
    quantity: z.number().int(),
    lineTotal: z.number(),
  })
  .openapi("OrderItem");

const OrderEvent = z
  .object({
    id: z.string().uuid(),
    event: z.string(),
    fromStatus: z.string().nullable(),
    toStatus: z.string().nullable(),
    actorType: z.enum(ACTOR_TYPES),
    createdAt: z.string(),
  })
  .openapi("OrderEvent");

/**
 * `note` is staff-written free text with no `is_internal` flag to check --
 * unlike ticket_messages, order_events never decided the question. A
 * cancellation reason can easily read "suspected fraud, third RTO", so it
 * stays on the admin shape only.
 */
const AdminOrderEvent = OrderEvent.extend({
  note: z.string().nullable(),
  actorId: z.string().uuid().nullable(),
}).openapi("AdminOrderEvent");

/** Named for the order surface: fulfilment.ts already owns `Shipment`. */
const OrderShipment = z
  .object({
    id: z.string().uuid(),
    carrier: z.string().nullable(),
    trackingNumber: z.string().nullable(),
    trackingUrl: z.string().nullable(),
    status: z.string(),
    shippedAt: z.string().nullable(),
    deliveredAt: z.string().nullable(),
  })
  .openapi("OrderShipment");

const OrderPayment = z
  .object({
    id: z.string().uuid(),
    provider: z.string(),
    status: z.enum(PAYMENT_STATUSES),
    amount: z.number(),
    createdAt: z.string(),
  })
  .openapi("OrderPayment");

const money = {
  subtotal: z.number(),
  discountTotal: z.number(),
  shippingTotal: z.number(),
  taxTotal: z.number(),
  grandTotal: z.number(),
  currency: z.string(),
  couponCode: z.string().nullable(),
};

const Order = z
  .object({
    id: z.string().uuid(),
    orderNumber: z.string(),
    status: z.enum(ORDER_STATUSES),
    ...money,
    email: z.string(),
    phone: z.string().nullable(),
    shippingAddress: AddressSnapshot,
    billingAddress: AddressSnapshot.nullable(),
    placedAt: z.string(),
    updatedAt: z.string(),
    items: z.array(OrderItem),
    shipments: z.array(OrderShipment),
    events: z.array(OrderEvent),
  })
  .openapi("Order");

const AdminOrder = Order.extend({
  customerId: z.string().uuid().nullable(),
  riskScore: z.number().int().nullable(),
  riskFlags: z.array(z.string()),
  utmSource: z.string().nullable(),
  utmMedium: z.string().nullable(),
  utmCampaign: z.string().nullable(),
  payments: z.array(OrderPayment),
  // .extend() does not reach inside an array, so the richer event shape
  // has to be restated or the contract understates what staff receive.
  events: z.array(AdminOrderEvent),
}).openapi("AdminOrder");

interface ItemRow {
  id: string;
  variant_id: string | null;
  product_name: string;
  variant_title: string;
  sku: string;
  unit_price: number;
  quantity: number;
  line_total: number;
}

interface EventRow {
  id: string;
  event: string;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  actor_type: (typeof ACTOR_TYPES)[number];
  actor_id: string | null;
  created_at: string;
}

interface ShipmentRow {
  id: string;
  carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  status: string;
  shipped_at: string | null;
  delivered_at: string | null;
}

interface PaymentRow {
  id: string;
  provider: string;
  status: (typeof PAYMENT_STATUSES)[number];
  amount: number;
  created_at: string;
}

interface OrderRow {
  id: string;
  order_number: string;
  customer_id: string | null;
  status: (typeof ORDER_STATUSES)[number];
  subtotal: number;
  discount_total: number;
  shipping_total: number;
  tax_total: number;
  grand_total: number;
  currency: string;
  coupon_code: string | null;
  email: string;
  phone: string | null;
  risk_score: number | null;
  risk_flags: unknown;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  // checkout() snapshots these from a body already validated against
  // addressSchema, so the documented keys are guaranteed at write time
  // even though jsonb itself promises nothing.
  shipping_address: z.infer<typeof AddressSnapshot>;
  billing_address: z.infer<typeof AddressSnapshot> | null;
  placed_at: string;
  updated_at: string;
  order_items: ItemRow[];
  order_events: EventRow[];
  shipments: ShipmentRow[];
  payments: PaymentRow[];
}

const ITEMS =
  "order_items(id, variant_id, product_name, variant_title, sku, unit_price, quantity, line_total)";
const EVENTS =
  "order_events(id, event, from_status, to_status, note, actor_type, actor_id, created_at)";
const SHIPMENTS =
  "shipments(id, carrier, tracking_number, tracking_url, status, shipped_at, delivered_at)";
const PAYMENTS = "payments(id, provider, status, amount, created_at)";

/**
 * Columns a customer may see. risk_*, utm_* and customer_id are absent
 * from the projection itself rather than dropped while shaping, so the
 * database never sends them to a handler that could leak them.
 */
const OWN_COLUMNS =
  "id, order_number, status, subtotal, discount_total, shipping_total, tax_total, grand_total, currency, coupon_code, email, phone, shipping_address, billing_address, placed_at, updated_at";

const ADMIN_COLUMNS = `${OWN_COLUMNS}, customer_id, risk_score, risk_flags, utm_source, utm_medium, utm_campaign`;

const OWN_SELECT = `${OWN_COLUMNS}, ${ITEMS}, ${SHIPMENTS}, ${EVENTS}`;
const ADMIN_SELECT = `${ADMIN_COLUMNS}, ${ITEMS}, ${SHIPMENTS}, ${EVENTS}, ${PAYMENTS}`;

const n = (v: number) => Number(v);
const byOldest = (a: { created_at: string }, b: { created_at: string }) =>
  a.created_at.localeCompare(b.created_at);

const shapeItem = (i: ItemRow) => ({
  id: i.id,
  variantId: i.variant_id,
  productName: i.product_name,
  variantTitle: i.variant_title,
  sku: i.sku,
  unitPrice: n(i.unit_price),
  quantity: i.quantity,
  lineTotal: n(i.line_total),
});

const shapeShipment = (s: ShipmentRow) => ({
  id: s.id,
  carrier: s.carrier,
  trackingNumber: s.tracking_number,
  trackingUrl: s.tracking_url,
  status: s.status,
  shippedAt: s.shipped_at,
  deliveredAt: s.delivered_at,
});

const shapeEvent = (e: EventRow) => ({
  id: e.id,
  event: e.event,
  fromStatus: e.from_status,
  toStatus: e.to_status,
  actorType: e.actor_type,
  createdAt: e.created_at,
});

/** The customer's view. Note the absence of `note` -- see AdminOrderEvent. */
const shape = (o: OrderRow) => ({
  id: o.id,
  orderNumber: o.order_number,
  status: o.status,
  subtotal: n(o.subtotal),
  discountTotal: n(o.discount_total),
  shippingTotal: n(o.shipping_total),
  taxTotal: n(o.tax_total),
  grandTotal: n(o.grand_total),
  currency: o.currency,
  couponCode: o.coupon_code,
  email: o.email,
  phone: o.phone,
  shippingAddress: o.shipping_address,
  billingAddress: o.billing_address,
  placedAt: o.placed_at,
  updatedAt: o.updated_at,
  items: (o.order_items ?? []).map(shapeItem),
  shipments: (o.shipments ?? []).map(shapeShipment),
  // Sorted here rather than in the query: embedded ordering is a separate
  // round of PostgREST syntax for a handful of rows per order.
  events: (o.order_events ?? []).slice().sort(byOldest).map(shapeEvent),
});

const shapeAdmin = (o: OrderRow) => ({
  ...shape(o),
  customerId: o.customer_id,
  riskScore: o.risk_score,
  // jsonb, so the column can hold anything the writer put there.
  riskFlags: Array.isArray(o.risk_flags) ? o.risk_flags.map(String) : [],
  utmSource: o.utm_source,
  utmMedium: o.utm_medium,
  utmCampaign: o.utm_campaign,
  payments: (o.payments ?? []).map((p) => ({
    id: p.id,
    provider: p.provider,
    status: p.status,
    amount: n(p.amount),
    createdAt: p.created_at,
  })),
  events: (o.order_events ?? [])
    .slice()
    .sort(byOldest)
    .map((e) => ({ ...shapeEvent(e), note: e.note, actorId: e.actor_id })),
});

const authErrors = {
  401: jsonError("Missing or invalid token"),
  403: jsonError("Authenticated, but not active staff"),
};

const page = z.object({
  items: z.array(Order),
  total: z.number().int().nullable(),
  limit: z.number().int(),
  offset: z.number().int(),
});

/* ---------- customer ---------- */

const mine = createRoute({
  method: "get",
  path: "/orders",
  tags: ["orders"],
  summary: "My orders",
  description:
    "Scoped to the caller in the query, not left to RLS: `staff_all` grants every active staff member every row, so a handler relying on the policy alone would answer a staff caller with the entire store's orders.\n\nGuest orders are not here and cannot be. They carry no `customer_id`, so there is no account to match them to -- a guest tracks their order from the link in their confirmation email.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { query: z.object({ ...pageQuery }) },
  responses: {
    200: {
      description: "Newest first",
      content: { "application/json": { schema: page } },
    },
    401: jsonError("Missing or invalid token"),
  },
});

const mineOne = createRoute({
  method: "get",
  path: "/orders/{id}",
  tags: ["orders"],
  summary: "One of my orders, with its timeline",
  description:
    "Somebody else's order is a 404 rather than a 403: a 403 would confirm the id exists, which is a free oracle for anyone enumerating them.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: "The order",
      content: { "application/json": { schema: Order } },
    },
    404: jsonError("No such order of yours"),
    401: jsonError("Missing or invalid token"),
  },
});

/* ---------- staff ---------- */

const list = createRoute({
  method: "get",
  path: "/admin/orders",
  tags: ["admin", "orders"],
  summary: "The order console",
  description:
    "Every filter here is backed by an index that existed before this endpoint did: `idx_orders_open` for the open-status queue, `idx_orders_placed` for the default and for date ranges, `idx_orders_email` for the email lookup.\n\nThere is deliberately no payment-provider filter. It needs an inner join on `payments`, which would silently drop every order that has no payment row yet -- exactly the orders someone filtering by payment is usually hunting for. The payments are on each row instead.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    query: z.object({
      status: z.enum(ORDER_STATUSES).optional(),
      email: z.string().max(200).optional().openapi({
        description: "Exact match. Order email is a snapshot, so this finds guest orders too.",
      }),
      q: z.string().max(40).optional().openapi({
        description: "Order-number prefix, e.g. ORD-2026 or a whole number.",
      }),
      placed_from: z.string().datetime().optional(),
      placed_to: z.string().datetime().optional(),
      flagged: z.coerce.boolean().optional().openapi({
        description: "Only orders the checkout risk check put a flag on.",
      }),
      ...pageQuery,
    }),
  },
  responses: {
    200: {
      description: "A page of orders, newest first",
      content: {
        "application/json": {
          schema: page.extend({ items: z.array(AdminOrder) }),
        },
      },
    },
    ...authErrors,
  },
});

const detail = createRoute({
  method: "get",
  path: "/admin/orders/{id}",
  tags: ["admin", "orders"],
  summary: "One order, everything about it",
  description:
    "Items, payments, shipments and the full timeline including staff notes. Invoices and returns are not embedded -- they have their own endpoints and their own paging.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: "The order",
      content: { "application/json": { schema: AdminOrder } },
    },
    404: jsonError("No such order"),
    ...authErrors,
  },
});

const captureCod = createRoute({
  method: "post",
  path: "/admin/orders/{id}/capture-cod",
  tags: ["admin", "orders"],
  summary: "Mark a cash-on-delivery order paid",
  description:
    "The counterpart to the gateway webhook, for the money a courier hands over. Converts every outstanding hold on the order into a `sale`, captures the COD payment row, moves the order to `paid` and writes the timeline event -- one transaction, via admin_capture_cod.\n\nOnly a `pending` order can be captured, so a second attempt is a 409 rather than a second sale. The unique index on `reservation_id` is the backstop: a release cannot be written twice, so this cannot invent stock even if it is called again.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff, idempotent("capture_cod", true)] as const,
  request: {
    headers: z.object({
      "idempotency-key": z
        .string()
        .min(8)
        .max(255)
        .openapi({
          description:
            "Required. One per capture; replaying it returns the first response instead of booking the money twice.",
        }),
    }),
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Captured",
      content: { "application/json": { schema: AdminOrder } },
    },
    400: jsonError("Missing or reused Idempotency-Key"),
    404: jsonError("No such order"),
    409: jsonError("The order is not pending, so there is nothing to capture"),
    ...authErrors,
  },
});

const cancel = createRoute({
  method: "post",
  path: "/admin/orders/{id}/cancel",
  tags: ["admin", "orders"],
  summary: "Cancel an order and put the stock back",
  description:
    "Releases outstanding holds immediately instead of waiting for `release_expired_reservations()` to notice, and returns units that already moved as a `sale` if the order was paid -- otherwise cancelling would quietly lose them.\n\nA shipped, delivered, refunded or already-cancelled order is refused: the goods have left. Cancelling does not refund. Money already captured goes back through `POST /admin/orders/{id}/refunds`, which is a separate decision and a separate record.\n\nNo Idempotency-Key: the status check makes a second cancel a 409, which is the more useful answer than a replayed success.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      required: false,
      content: {
        "application/json": {
          schema: z.object({
            reason: z.string().trim().max(500).optional().openapi({
              description: "Kept on the timeline for staff. Never shown to the customer.",
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Cancelled",
      content: { "application/json": { schema: AdminOrder } },
    },
    400: jsonError("Invalid body"),
    404: jsonError("No such order"),
    409: jsonError("Too far along to cancel"),
    ...authErrors,
  },
});

/** Shared by both admin actions: re-read the order the RPC just changed. */
async function readAdminOrder(
  db: Caller["db"],
  id: string,
): Promise<OrderRow> {
  const { data, error } = await db
    .from("orders")
    .select(ADMIN_SELECT)
    .eq("id", id)
    .maybeSingle();
  throwOnDbError(error);
  if (!data) throw new HTTPException(404, { message: "No such order." });
  return data as unknown as OrderRow;
}

/**
 * How a guest sees the order they placed.
 *
 * Guests are a supported way to buy here -- checkout takes an email and
 * writes no customers row -- and until now that was the end of it. There
 * was no account to sign into and no route that would answer, so a guest
 * order was invisible to the person who placed it the moment the
 * confirmation email was read. The comment on GET /orders has said "a
 * guest tracks their order from the link in their confirmation email"
 * since B14; this is the thing that link points at.
 *
 * The order number alone is not enough. next_order_number() uses an
 * ordinary sequence, so numbers are close to consecutive and guessing
 * the next one is trivial -- the email is the second factor, and both
 * have to match. citext on orders.email makes that comparison
 * case-insensitive, which matters when the address is typed by hand.
 *
 * Wrong email and unknown order answer identically. Distinguishing them
 * would turn this into an oracle for "did this person order here",
 * answerable from an order number and a guess.
 */
const trackOrder = createRoute({
  method: "get",
  path: "/orders/track",
  tags: ["orders"],
  summary: "Look up an order without an account",
  description:
    "For guests, who have no account to sign into. Both the order number and the email address used at checkout must match; either one wrong gives the same 404, so this cannot be used to find out whether an address has ordered here.\n\nWorks for member orders too -- someone who ordered while signed in can still track by number and email.\n\nRate limited more tightly than the rest of the API, because an order number and an email is a guessable pair.",
  request: {
    query: z.object({
      order_number: z.string().min(3).max(40),
      email: z.string().email().max(254),
    }),
  },
  responses: {
    200: {
      description: "The order",
      content: { "application/json": { schema: Order } },
    },
    400: jsonError("Missing or malformed parameters"),
    404: jsonError("No order matches that number and address"),
    429: jsonError("Too many lookups"),
  },
});

/**
 * Cancelling an order you placed and have not paid for.
 *
 * admin_cancel_order() has existed since B3 and requires staff, so the
 * only route to a cancellation was a support ticket -- for something the
 * customer should just be able to do, and while it sits unanswered the
 * reservation holds stock nobody is going to buy.
 *
 * Pending only. The staff version will cancel a paid order and return
 * the sold units; that is the right power for staff and the wrong one to
 * hand a customer, because money has changed hands by then and unwinding
 * it is a refund decision with a person attached.
 */
const cancelOwn = createRoute({
  method: "post",
  path: "/orders/{id}/cancel",
  tags: ["orders"],
  summary: "Cancel my order",
  description:
    "Only while the order is still `pending` -- nothing has been captured, so this releases the stock hold and closes the order. Once it is paid this answers 422 and the route is support, or a return after delivery.\n\nAn order that is not yours answers 404 rather than 403, so this cannot be used to find out which order ids exist.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ reason: z.string().max(500).optional() }),
        },
      },
    },
  },
  responses: {
    200: { description: "Cancelled", content: { "application/json": { schema: Order } } },
    401: jsonError("Missing or invalid token"),
    404: jsonError("No such order of yours"),
    422: jsonError("Already paid, shipped or cancelled"),
  },
});

export const ordersRoute = new OpenAPIHono({ defaultHook: validationHook })
  /**
   * FIRST in the chain, deliberately. `/orders/track` and `/orders/{id}`
   * are both matched by the latter's pattern, and requireAuth on that
   * route runs before its uuid param validation -- so registered second,
   * every guest lookup answered 401 instead of finding the order.
   */
  .openapi(trackOrder, async (c) => {
    const { order_number, email } = c.req.valid("query");

    // The service key, scoped in the query rather than by RLS. A guest
    // order has no customer_id, so there is no policy that could grant
    // it -- which is exactly why the match below has to be exact and
    // has to include the email.
    const { data, error } = await serviceClient()
      .from("orders")
      .select(OWN_SELECT)
      .eq("order_number", order_number)
      .eq("email", email)
      .maybeSingle();
    throwOnDbError(error);

    if (!data) {
      // Deliberately the same answer for "no such order" and "that is not
      // the address on it".
      c.get("log")?.warn({ order_number }, "orders.track_miss");
      throw new HTTPException(404, {
        message: "No order matches that number and address.",
        cause: { code: "order_not_found" },
      });
    }

    return c.json(shape(data as unknown as OrderRow), 200);
  })
  .openapi(mine, async (c) => {
    const { limit, offset } = c.req.valid("query");
    const caller = c.get("caller");

    const { data, error, count } = await caller.db
      .from("orders")
      .select(OWN_SELECT, { count: "exact" })
      .eq("customer_id", caller.userId)
      .order("placed_at", { ascending: false })
      .range(offset, offset + limit - 1);
    throwOnDbError(error);

    return c.json(
      {
        items: ((data ?? []) as unknown as OrderRow[]).map(shape),
        total: count ?? null,
        limit,
        offset,
      },
      200,
    );
  })

  .openapi(mineOne, async (c) => {
    const { id } = c.req.valid("param");
    const caller = c.get("caller");

    const { data, error } = await caller.db
      .from("orders")
      .select(OWN_SELECT)
      .eq("id", id)
      .eq("customer_id", caller.userId)
      .maybeSingle();
    throwOnDbError(error);
    if (!data) throw new HTTPException(404, { message: "No such order." });

    return c.json(shape(data as unknown as OrderRow), 200);
  })

  .openapi(list, async (c) => {
    const { status, email, q, placed_from, placed_to, flagged, limit, offset } =
      c.req.valid("query");

    let query = c
      .get("caller")
      .db.from("orders")
      .select(ADMIN_SELECT, { count: "exact" });

    if (status) query = query.eq("status", status);
    if (email) query = query.eq("email", email);
    // ponytail: prefix scan on order_number -- the unique index is default
    // collation so ilike cannot use it. Fine for an admin console; add a
    // text_pattern_ops index if the table gets large enough to notice.
    if (q) query = query.ilike("order_number", `${q}%`);
    if (placed_from) query = query.gte("placed_at", placed_from);
    if (placed_to) query = query.lte("placed_at", placed_to);
    if (flagged) query = query.neq("risk_flags", "[]");

    const { data, error, count } = await query
      .order("placed_at", { ascending: false })
      .range(offset, offset + limit - 1);
    throwOnDbError(error);

    return c.json(
      {
        items: ((data ?? []) as unknown as OrderRow[]).map(shapeAdmin),
        total: count ?? null,
        limit,
        offset,
      },
      200,
    );
  })

  .openapi(detail, async (c) => {
    const { id } = c.req.valid("param");
    return c.json(shapeAdmin(await readAdminOrder(c.get("caller").db, id)), 200);
  })

  .openapi(captureCod, async (c) => {
    const { id } = c.req.valid("param");
    const db = c.get("caller").db;

    // Caller-bound, not the service key: admin_capture_cod calls
    // require_staff(), which reads auth.uid(), and audit_row() attributes
    // the writes to whoever took the cash.
    const { error } = await db.rpc("admin_capture_cod", { p_order_id: id });
    throwOnDbError(error);

    const order = await readAdminOrder(db, id);
    c.get("log")?.info(
      { orderId: id, orderNumber: order.order_number },
      "orders.cod_captured",
    );
    return c.json(shapeAdmin(order), 200);
  })

  .openapi(cancel, async (c) => {
    const { id } = c.req.valid("param");
    const reason = c.req.valid("json")?.reason;
    const db = c.get("caller").db;

    const { error } = await db.rpc("admin_cancel_order", {
      p_order_id: id,
      p_reason: reason ?? null,
    });
    throwOnDbError(error);

    const order = await readAdminOrder(db, id);
    // The reason is staff free text and stays out of the log with the rest
    // of the request bodies.
    c.get("log")?.info(
      { orderId: id, orderNumber: order.order_number },
      "orders.cancelled",
    );
    return c.json(shapeAdmin(order), 200);
  })

  .openapi(cancelOwn, async (c) => {
    const { id } = c.req.valid("param");
    const caller = c.get("caller");

    // caller.db: cancel_own_order reads auth.uid() to decide whose order
    // this is, so the service key would make it nobody's.
    const { error } = await caller.db.rpc("cancel_own_order", {
      p_order_id: id,
      p_reason: c.req.valid("json").reason ?? null,
    });
    throwOnDbError(error);

    const { data, error: readError } = await caller.db
      .from("orders")
      .select(OWN_SELECT)
      .eq("id", id)
      .single();
    throwOnDbError(readError);

    c.get("log")?.info({ orderId: id }, "orders.cancelled_by_customer");
    return c.json(shape(data as unknown as OrderRow), 200);
  });
