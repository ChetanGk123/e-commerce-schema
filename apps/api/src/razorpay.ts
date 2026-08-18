import Razorpay from "razorpay";
import { HTTPException } from "hono/http-exception";

import { env } from "./env";

/**
 * The gateway, and the two things we ask of it.
 *
 * The SDK is instantiated lazily. Doing it at import time would make a
 * missing key a startup crash for an API that is perfectly able to serve
 * the catalog, the cart and COD orders without one.
 */
let client: Razorpay | undefined;

export function razorpay(): Razorpay {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new HTTPException(503, {
      message: "Card payments are not configured.",
      cause: { code: "payments_not_configured" },
    });
  }
  client ??= new Razorpay({
    key_id: env.RAZORPAY_KEY_ID,
    key_secret: env.RAZORPAY_KEY_SECRET,
  });
  return client;
}

/** True when the gateway can actually be reached with what we hold. */
export const paymentsConfigured = (): boolean =>
  Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);

/**
 * Is this delivery really from Razorpay?
 *
 * Takes the RAW request body. Re-serialising the parsed JSON changes
 * whitespace and key order, and the HMAC is over bytes -- every signature
 * would fail, in a way that looks like a wrong secret.
 *
 * The SDK does the comparison in constant time via node:crypto's
 * timingSafeEqual, which is why this is not hand-rolled: a naive `===`
 * leaks the signature one byte at a time.
 */
export function webhookIsAuthentic(raw: string, signature: string): boolean {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return false;
  try {
    return Razorpay.validateWebhookSignature(
      raw,
      signature,
      env.RAZORPAY_WEBHOOK_SECRET,
    );
  } catch {
    // A malformed signature header throws rather than returning false.
    return false;
  }
}

/** Money crosses the wire in paise. numeric(12,2) times 100 is exact. */
export const toPaise = (rupees: number): number => Math.round(rupees * 100);
