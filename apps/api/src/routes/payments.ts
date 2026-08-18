import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { optionalAuth } from "../auth";
import { env } from "../env";
import { throwOnDbError } from "../errors";
import { razorpay, toPaise } from "../razorpay";
import { jsonError, validationHook } from "../schemas";
import { serviceClient } from "../supabase";

/**
 * Opening a payment against an order that already exists.
 *
 * Deliberately not part of /checkout. Checkout is one database
 * transaction; an outbound HTTP call to Razorpay inside it would hold that
 * transaction open across the internet, and a gateway timeout would roll
 * back a perfectly good order. So the order is committed first, and this
 * runs after -- which also makes it retryable when the gateway is down.
 *
 * Idempotent: if a gateway order already exists for this order, it is
 * returned rather than a second one being opened. Two Razorpay orders
 * against one basket is how a customer pays twice.
 */
const PaymentIntent = z
  .object({
    orderNumber: z.string(),
    razorpayOrderId: z.string(),
    /** The PUBLIC key. It is meant to reach the browser; the secret is not. */
    keyId: z.string(),
    amount: z.number().int().openapi({ description: "In paise." }),
    currency: z.string(),
    /** True when this call reused a gateway order opened earlier. */
    reused: z.boolean(),
  })
  .openapi("PaymentIntent");

interface OrderRow {
  id: string;
  order_number: string;
  customer_id: string | null;
  status: string;
  grand_total: number;
  currency: string;
  email: string;
}

const create = createRoute({
  method: "post",
  path: "/payments/razorpay/order",
  tags: ["payments"],
  summary: "Open a Razorpay order for a placed order",
  description:
    "Call this straight after checkout, then hand the result to Razorpay's checkout widget. Calling it again returns the same gateway order rather than opening a second one.",
  security: [{ bearerAuth: [] }],
  middleware: [optionalAuth] as const,
  request: {
    body: {
      content: {
        "application/json": { schema: z.object({ order_id: z.string().uuid() }) },
      },
    },
  },
  responses: {
    200: {
      description: "The gateway order to pay against",
      content: { "application/json": { schema: PaymentIntent } },
    },
    400: jsonError("Invalid body"),
    401: jsonError("A token was sent but is not valid"),
    403: jsonError("That order belongs to someone else"),
    404: jsonError("No such order"),
    409: jsonError("The order is not awaiting payment"),
    502: jsonError("Razorpay refused or could not be reached"),
    503: jsonError("Card payments are not configured on this deployment"),
  },
});

export const paymentsRoute = new OpenAPIHono({
  defaultHook: validationHook,
}).openapi(create, async (c) => {
  const { order_id } = c.req.valid("json");
  const caller = c.get("caller");
  const log = c.get("log");

  // Service key: a guest order has no customer_id, so no RLS policy can
  // reach it. Authorisation is done explicitly below instead.
  const db = serviceClient();

  const { data, error } = await db
    .from("orders")
    .select("id, order_number, customer_id, status, grand_total, currency, email")
    .eq("id", order_id)
    .maybeSingle();
  throwOnDbError(error);
  if (!data) {
    throw new HTTPException(404, {
      message: "No such order",
      cause: { code: "not_found" },
    });
  }
  const order = data as unknown as OrderRow;

  // A member's order is theirs alone. A guest order has nobody to compare
  // against, so knowing its uuid is the credential -- it is only ever
  // returned to whoever placed it. Same bargain as the cart session, and
  // the same reason it must never appear in a log or a URL.
  if (order.customer_id && order.customer_id !== caller?.userId) {
    log?.warn({ orderId: order.id }, "payments.wrong_owner");
    throw new HTTPException(403, {
      message: "That order is not yours",
      cause: { code: "forbidden" },
    });
  }

  if (order.status !== "pending") {
    throw new HTTPException(409, {
      message: `This order is already ${order.status}.`,
      cause: { code: "order_not_payable" },
    });
  }

  const existing = await db
    .from("payments")
    .select("provider_ref")
    .eq("order_id", order.id)
    .eq("provider", "razorpay")
    .not("provider_ref", "is", null)
    .maybeSingle();
  throwOnDbError(existing.error);

  const amount = toPaise(Number(order.grand_total));

  if (existing.data) {
    return c.json(
      {
        orderNumber: order.order_number,
        razorpayOrderId: (existing.data as { provider_ref: string }).provider_ref,
        keyId: env.RAZORPAY_KEY_ID!,
        amount,
        currency: order.currency,
        reused: true,
      },
      200,
    );
  }

  let gatewayOrderId: string;
  try {
    const created = await razorpay().orders.create({
      amount,
      currency: order.currency,
      // Our order number, so a Razorpay dashboard row can be traced back
      // without a database lookup.
      receipt: order.order_number,
      notes: { order_id: order.id },
    });
    gatewayOrderId = created.id;
  } catch (err) {
    if (err instanceof HTTPException) throw err; // 503, not configured
    // The gateway's own words go to the log. They can carry account and
    // key detail, so they do not go to the caller.
    log?.error({ err, orderNumber: order.order_number }, "payments.gateway_failed");
    throw new HTTPException(502, {
      message: "The payment provider could not be reached. Try again.",
      cause: { code: "gateway_unavailable" },
    });
  }

  const attached = await db.rpc("attach_payment_ref", {
    p_order_id: order.id,
    p_provider: "razorpay",
    p_provider_ref: gatewayOrderId,
  });
  throwOnDbError(attached.error);

  log?.info(
    { orderNumber: order.order_number, gatewayOrderId },
    "payments.intent_created",
  );

  return c.json(
    {
      orderNumber: order.order_number,
      razorpayOrderId: gatewayOrderId,
      keyId: env.RAZORPAY_KEY_ID!,
      amount,
      currency: order.currency,
      reused: false,
    },
    200,
  );
});
