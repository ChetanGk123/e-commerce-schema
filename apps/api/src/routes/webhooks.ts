import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { throwOnDbError } from "../errors";
import { webhookIsAuthentic } from "../razorpay";
import { jsonError, validationHook } from "../schemas";
import { serviceClient } from "../supabase";

/**
 * Incoming gateway callbacks.
 *
 * Three rules, in order, and the order is the whole design:
 *
 *   1. VERIFY. The signature is the only authentication a webhook has.
 *      Anyone can POST here; without this, anyone can mark any order paid.
 *
 *   2. RECORD. webhook_events first, business logic second. If the process
 *      dies in between, the delivery is still written down and the retry
 *      has something to be idempotent against. The other order captures
 *      twice.
 *
 *   3. ACT, then mark processed. `processed_at` -- not the unique index --
 *      is the gate, because a duplicate whose first attempt FAILED still
 *      needs processing.
 *
 * ACKNOWLEDGEMENT MEANS RECORDED, NOT ACTED ON. Once the delivery is
 * safely in webhook_events this answers 200 even if processing failed,
 * and the failure goes to webhook_events.error. Answering non-2xx would
 * make Razorpay retry for days over something a retry cannot fix -- a
 * captured payment for stock that is gone needs a person, not another
 * delivery. Re-driving unprocessed rows is our job (api-plan B11).
 *
 * A 5xx is reserved for the one case a retry does fix: we could not write
 * the delivery down at all.
 */
interface RecordResult {
  id: string;
  is_new: boolean;
  already_processed: boolean;
  attempts: number;
}

/** Only what we read. Razorpay sends a great deal more. */
interface PaymentEntity {
  id?: string;
  /** The GATEWAY order id, which is what we stored in payments.provider_ref. */
  order_id?: string;
  /** Paise. */
  amount?: number;
  error_description?: string;
  error_reason?: string;
}

interface RazorpayEvent {
  event?: string;
  payload?: { payment?: { entity?: PaymentEntity } };
}

const Ack = z
  .object({
    received: z.literal(true),
    /** False when this delivery had already been processed. */
    processed: z.boolean(),
    /** Set when processing failed; the delivery is still recorded. */
    error: z.string().nullable(),
  })
  .openapi("WebhookAck");

const razorpayHook = createRoute({
  method: "post",
  path: "/webhooks/razorpay",
  tags: ["webhooks"],
  summary: "Razorpay payment callbacks",
  description:
    "Verifies X-Razorpay-Signature against the raw body, records the delivery, then acts. Handles payment.captured and payment.failed; anything else is recorded and acknowledged so it is not retried forever.\n\nNot authenticated with a bearer token -- the signature is the authentication.",
  responses: {
    200: {
      description: "Delivery recorded (and processed, unless it already was)",
      content: { "application/json": { schema: Ack } },
    },
    401: jsonError("Missing or invalid signature"),
    500: jsonError("The delivery could not be recorded -- please retry"),
  },
});

export const webhooksRoute = new OpenAPIHono({
  defaultHook: validationHook,
}).openapi(razorpayHook, async (c) => {
  const log = c.get("log");

  // The RAW bytes. c.req.json() would reparse and any re-serialisation
  // changes whitespace and key order -- the HMAC is over bytes, so every
  // signature would fail in a way that reads like a wrong secret.
  const raw = await c.req.text();
  const signature = c.req.header("X-Razorpay-Signature") ?? "";

  if (!webhookIsAuthentic(raw, signature)) {
    // Not recorded, deliberately: writing down unverified deliveries would
    // let anyone fill webhook_events by posting garbage. The rejection is
    // in the log instead, which is where an operator looks after a
    // rotated secret.
    log?.warn({ hasSignature: signature.length > 0 }, "webhook.rejected");
    return c.json(
      {
        error: {
          code: "invalid_signature",
          message: "Signature verification failed.",
          requestId: c.get("reqId"),
        },
      },
      401,
    );
  }

  let event: RazorpayEvent;
  try {
    event = JSON.parse(raw) as RazorpayEvent;
  } catch {
    // Signed but unparseable: our problem or theirs, either way a retry of
    // the same bytes will not help.
    log?.error("webhook.unparseable");
    return c.json(
      {
        error: {
          code: "invalid_payload",
          message: "Body is not JSON.",
          requestId: c.get("reqId"),
        },
      },
      401,
    );
  }

  const db = serviceClient();
  const entity = event.payload?.payment?.entity;

  // Razorpay's own delivery id. It is what their documentation says to
  // deduplicate on; the payment id is the fallback because a redelivery
  // of the same event carries the same one.
  const eventId =
    c.req.header("X-Razorpay-Event-Id") ??
    `${event.event ?? "unknown"}:${entity?.id ?? crypto.randomUUID()}`;

  const recorded = await db.rpc("record_webhook", {
    p_provider: "razorpay",
    p_event_id: eventId,
    p_event_type: event.event ?? null,
    p_payload: event,
    p_verified: true,
  });
  // The one failure worth a 5xx: nothing was written down, so a retry is
  // the only thing that can save this delivery.
  throwOnDbError(recorded.error);

  const row = (recorded.data as unknown as RecordResult[])[0]!;

  if (row.already_processed) {
    log?.info({ eventId, attempts: row.attempts }, "webhook.duplicate");
    return c.json({ received: true as const, processed: false, error: null }, 200);
  }

  try {
    await process(db, event, entity);
    const done = await db.rpc("mark_webhook_processed", { p_id: row.id });
    throwOnDbError(done.error);
    log?.info({ eventId, type: event.event }, "webhook.processed");
    return c.json({ received: true as const, processed: true, error: null }, 200);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log?.error({ eventId, type: event.event, err: detail }, "webhook.failed");
    // Recorded, unprocessed, with the reason attached. Still a 200: the
    // delivery is safe, and this is a queue for a person now.
    await db.rpc("mark_webhook_processed", { p_id: row.id, p_error: detail });
    return c.json(
      { received: true as const, processed: false, error: "processing_failed" },
      200,
    );
  }
});

/**
 * Which of our orders a Razorpay payment belongs to.
 *
 * By the gateway order id we stored ourselves, not by `notes` -- notes are
 * echoed back from what we sent, so trusting them means trusting a field
 * an attacker with a signing key could set. provider_ref was written by
 * attach_payment_ref and nothing else.
 */
async function resolveOrder(
  db: ReturnType<typeof serviceClient>,
  gatewayOrderId: string | undefined,
): Promise<string> {
  if (!gatewayOrderId) throw new Error("event carries no gateway order id");

  const { data, error } = await db
    .from("payments")
    .select("order_id")
    .eq("provider", "razorpay")
    .eq("provider_ref", gatewayOrderId)
    .maybeSingle();
  throwOnDbError(error);
  if (!data) throw new Error(`no payment matches gateway order ${gatewayOrderId}`);

  return (data as { order_id: string }).order_id;
}

async function process(
  db: ReturnType<typeof serviceClient>,
  event: RazorpayEvent,
  entity: PaymentEntity | undefined,
): Promise<void> {
  switch (event.event) {
    case "payment.captured": {
      const orderId = await resolveOrder(db, entity?.order_id);
      const { error } = await db.rpc("capture_payment", {
        p_order_id: orderId,
        p_provider: "razorpay",
        p_provider_ref: entity?.order_id ?? null,
        // Back to rupees. capture_payment refuses a mismatch rather than
        // marking an order paid for the wrong amount.
        p_amount: entity?.amount != null ? entity.amount / 100 : null,
        // The gateway PAYMENT id, kept apart from the ORDER id above.
        // Refunds are issued against this one; without it, nothing can
        // be refunded through the gateway at all.
        p_provider_payment_ref: entity?.id ?? null,
      });
      throwOnDbError(error);
      return;
    }

    case "payment.failed": {
      const orderId = await resolveOrder(db, entity?.order_id);
      const { error } = await db.rpc("fail_payment", {
        p_order_id: orderId,
        p_provider: "razorpay",
        p_provider_ref: entity?.order_id ?? null,
        p_reason: entity?.error_description ?? entity?.error_reason ?? null,
      });
      throwOnDbError(error);
      return;
    }

    default:
      // Recorded and acknowledged. Razorpay sends events we have not
      // subscribed to meaning for; treating those as failures would fill
      // webhook_events.error with noise and hide the real ones.
      return;
  }
}
