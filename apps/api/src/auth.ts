import type { StaffRole } from "@ecom/schema/enums";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { jwtVerify } from "jose";

import { env } from "./env";
import { callerClient } from "./supabase";

/**
 * Self-hosted GoTrue signs HS256 against the shared JWT_SECRET -- confirmed
 * from the Dokploy template's compose (GOTRUE_JWT_SECRET / PGRST_JWT_SECRET).
 * The asymmetric vars exist there but default to empty, so this is not JWKS.
 */
const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);

export interface Staff {
  id: string;
  role: StaffRole;
  fullName: string | null;
}

export interface Caller {
  userId: string;
  token: string;
  /** Acts as the caller: RLS applies and auth.uid() is populated. */
  db: SupabaseClient;
  /** Null when the caller is a customer rather than staff. */
  staff: Staff | null;
}

declare module "hono" {
  interface ContextVariableMap {
    caller: Caller;
  }
}

/**
 * 401: we do not know who you are.
 *
 * Verifies the token and binds a caller-scoped Supabase client. It does NOT
 * decide what you may do -- that is requireStaff / requireRole below.
 */
export const requireAuth = createMiddleware(async (c, next) => {
  const token = bearer(c);

  if (!token) {
    throw new HTTPException(401, { message: "Missing bearer token" });
  }

  await establish(c, token);
  await next();
});

/**
 * Auth if you have it, guest if you do not.
 *
 * For the surfaces a shopper reaches before signing in -- the cart, and
 * checkout itself. A *present but broken* token is still a 401: silently
 * demoting an expired session to a guest would hand the customer someone
 * else's empty cart and place their order against no account.
 */
export const optionalAuth = createMiddleware(async (c, next) => {
  const token = bearer(c);
  if (token) await establish(c, token);
  await next();
});

function bearer(c: Context): string | undefined {
  const header = c.req.header("Authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

async function establish(c: Context, token: string): Promise<void> {
  let userId: string;
  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new Error("token has no subject");
    }
    userId = payload.sub;
  } catch (err) {
    // Reason goes to the log, not to the caller: telling an attacker whether a
    // token is expired, malformed or wrongly signed is free information.
    c.get("log")?.warn({ err: (err as Error).message }, "auth.reject");
    throw new HTTPException(401, { message: "Invalid or expired token" });
  }

  c.set("caller", { userId, token, db: callerClient(token), staff: null });
  c.get("log")?.debug({ userId }, "auth.ok");
}

/**
 * Every staff refusal, whatever the cause. A constant rather than two
 * literals so the two branches below cannot drift apart again.
 */
const STAFF_REFUSED = "Staff access required";

/**
 * 403: we know who you are, and it is not staff.
 *
 * A customer's token is perfectly valid auth -- the missing staff_users row is
 * the only thing standing between them and the admin surface, so this check is
 * load-bearing rather than cosmetic.
 */
export const requireStaff = createMiddleware(async (c, next) => {
  const caller = c.get("caller");
  const log = c.get("log");

  const { data, error } = await caller.db
    .from("staff_users")
    .select("id, role, full_name, is_active")
    .eq("id", caller.userId)
    .maybeSingle();

  if (error) {
    log?.error({ err: error.message }, "auth.staff_lookup_failed");
    throw new HTTPException(500, { message: "Could not resolve staff account" });
  }
  // One message for both refusals, for the same reason every 401 shares
  // one: which of the two fires depends on RLS state rather than on
  // anything the caller should learn, and the log already carries the
  // difference for whoever has to explain it to the person locked out.
  if (!data) {
    log?.warn({ userId: caller.userId }, "auth.not_staff");
    throw new HTTPException(403, { message: STAFF_REFUSED });
  }
  /**
   * Redundant today, and deliberately kept.
   *
   * `staff_all` is the only policy on `staff_users` and it is gated on
   * `is_staff()`, which itself requires `is_active` -- so a deactivated
   * member cannot see their own row, and the lookup above has already
   * returned null. Verified against the live stack: deactivating an
   * account cut off its still-valid JWT on the next request, through the
   * `!data` branch, never this one.
   *
   * It stays because that redundancy is an accident of the current
   * policy set, not a property of the schema. B11 replaces `staff_all`
   * with a per-role matrix, and a matrix that lets a staff member read
   * their own row -- an ordinary thing to want -- would make this check
   * the only thing between a deactivated account and the admin surface.
   * Deleting it as dead code would turn that into a silent privilege
   * grant, and nothing here would fail to say so.
   */
  if (!data.is_active) {
    log?.warn({ userId: caller.userId }, "auth.staff_inactive");
    throw new HTTPException(403, { message: STAFF_REFUSED });
  }

  caller.staff = {
    id: data.id as string,
    role: data.role as StaffRole,
    fullName: (data.full_name as string | null) ?? null,
  };
  log?.debug({ userId: caller.userId, role: caller.staff.role }, "auth.staff");

  await next();
});

/**
 * Role gating. Runs after requireStaff.
 *
 * Since migration 0023 this is no longer the only thing standing between a
 * role and a table it should not touch: RLS enforces the matrix on
 * staff_users, store_settings, discounts, gift_cards, customers and
 * addresses, so a warehouse JWT calling PostgREST directly is refused there
 * too. On those tables this check shapes the product surface and the
 * database backs it.
 *
 * Everywhere else it is still only a product surface. The remaining hole is
 * cost_price on product_variants: every staff member connects as the same
 * `authenticated` database role, and column privileges are per role, so
 * "read the variant but not its cost" cannot be expressed in RLS. See
 * README.md.
 */
export function requireRole(...allowed: StaffRole[]) {
  return createMiddleware(async (c, next) => {
    const staff = c.get("caller").staff;

    if (!staff || !allowed.includes(staff.role)) {
      c.get("log")?.warn(
        { userId: c.get("caller").userId, role: staff?.role, allowed },
        "auth.role_denied",
      );
      throw new HTTPException(403, {
        message: `Requires one of: ${allowed.join(", ")}`,
      });
    }

    await next();
  });
}
