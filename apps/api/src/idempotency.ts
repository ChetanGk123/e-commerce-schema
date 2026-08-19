import { createHash } from "node:crypto";

import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

import { serviceClient } from "./supabase";

/**
 * Replay protection for money-moving POSTs that are not checkout.
 *
 * checkout() does this inside its own transaction, and has to: the key
 * must be claimed in the same transaction that reserves the stock, or a
 * retry racing the original claims the key after the order exists. That
 * one stays where it is.
 *
 * Everything else -- issuing a refund, issuing a gift card, granting
 * credit -- is a single call whose whole effect is one function, so the
 * key can be claimed here and the response stored on the way out.
 *
 * WHAT THIS IS NOT: a lock. Two simultaneous requests with the same key
 * both find no stored response and both proceed, and the second gets a
 * 409 only because the first has committed by then. For a human clicking
 * twice -- the case this exists for -- that is enough. For genuine
 * concurrency, the guarantee has to live in the transaction, which is
 * exactly why checkout's does.
 */
const SCOPE_HEADER = "Idempotency-Key";

/**
 * The same body under the same key must be the same request. Keys are
 * sorted so two encodings of one body agree.
 */
async function hashOf(c: Context): Promise<{ hash: string; body: string }> {
  const body = await c.req.raw.clone().text();
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, canonical(val)]),
      );
    }
    return v;
  };
  let normalized = body;
  try {
    normalized = JSON.stringify(canonical(JSON.parse(body || "{}")));
  } catch {
    // Not JSON. Hash the bytes as they came.
  }
  return {
    hash: createHash("sha256").update(normalized).digest("hex"),
    body,
  };
}

/**
 * @param scope  what kind of operation this is, so one key used for a
 *               refund and a gift card is not silently the same request.
 * @param required  true where a caller must supply a key. Left false for
 *               operations a second copy of is annoying rather than
 *               expensive, so an existing client is not broken by the
 *               middleware appearing.
 */
export function idempotent(scope: string, required = false) {
  return createMiddleware(async (c: Context, next: Next) => {
    const key = c.req.header(SCOPE_HEADER);

    if (!key) {
      if (!required) return next();
      throw new HTTPException(400, {
        message: `${SCOPE_HEADER} header is required here.`,
        cause: { code: "idempotency_key_required" },
      });
    }
    if (key.length < 8 || key.length > 255) {
      throw new HTTPException(400, {
        message: `${SCOPE_HEADER} must be 8 to 255 characters.`,
        cause: { code: "idempotency_key_invalid" },
      });
    }

    const db = serviceClient();
    const { hash } = await hashOf(c);
    const caller = c.get("caller");
    // Scoped, so the same key across two different operations is two keys.
    const stored = `${scope}:${key}`;

    const claim = await db
      .from("idempotency_keys")
      .insert({
        key: stored,
        scope,
        request_hash: hash,
        // Null for staff, and not for tidiness: customer_id has a foreign
        // key to customers, and a staff member has no row there. Setting
        // it to their id makes every claim fail on the FK. It is also the
        // honest value -- a refund issued by an agent is a staff action,
        // not a customer's retry.
        customer_id: caller && !caller.staff ? caller.userId : null,
        locked_at: new Date().toISOString(),
      })
      .select("key");

    if (claim.error) {
      // 23505: somebody already claimed it. Which of the three cases it
      // is depends on what they stored.
      if (claim.error.code !== "23505") {
        c.get("log")?.error({ err: claim.error.message }, "idempotency.claim_failed");
        throw new HTTPException(500, {
          message: "Something went wrong. Quote the request id to support.",
          cause: { code: "idempotency_unavailable" },
        });
      }

      const prior = await db
        .from("idempotency_keys")
        .select("request_hash, response_status, response_body, completed_at")
        .eq("key", stored)
        .maybeSingle();

      const row = prior.data as {
        request_hash: string;
        response_status: number | null;
        response_body: unknown;
        completed_at: string | null;
      } | null;

      if (row && row.request_hash !== hash) {
        // Same key, different body. Replaying the first response would
        // hide a client bug by answering for an operation nobody asked
        // for the second time.
        throw new HTTPException(409, {
          message: "This key was already used for a different request.",
          cause: { code: "idempotency_key_conflict" },
        });
      }
      if (row?.completed_at && row.response_status) {
        c.get("log")?.info({ scope }, "idempotency.replayed");
        return c.json(row.response_body as never, row.response_status as 200);
      }
      throw new HTTPException(409, {
        message: "That request is still being processed. Try again in a moment.",
        cause: { code: "request_in_flight" },
      });
    }

    await next();

    // Only a success is worth replaying. Storing a 500 would make a
    // transient failure permanent for that key, and the caller could
    // never retry it.
    const status = c.res.status;
    if (status >= 200 && status < 300) {
      const body = await c.res.clone().json().catch(() => null);
      const done = await db
        .from("idempotency_keys")
        .update({
          response_status: status,
          response_body: body,
          completed_at: new Date().toISOString(),
        })
        .eq("key", stored);
      if (done.error) {
        c.get("log")?.error({ err: done.error.message }, "idempotency.store_failed");
      }
    } else {
      // Release it, so the caller can fix the problem and retry with the
      // same key rather than being told it is in flight forever.
      await db.from("idempotency_keys").delete().eq("key", stored);
    }
  });
}
