import type { StaffRole } from "@ecom/schema/enums";
import type { SupabaseClient } from "@supabase/supabase-js";
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
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;

  if (!token) {
    throw new HTTPException(401, { message: "Missing bearer token" });
  }

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

  await next();
});

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
  if (!data) {
    log?.warn({ userId: caller.userId }, "auth.not_staff");
    throw new HTTPException(403, { message: "Staff access required" });
  }
  if (!data.is_active) {
    log?.warn({ userId: caller.userId }, "auth.staff_inactive");
    throw new HTTPException(403, { message: "This staff account is disabled" });
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
 * ACCEPTED RISK, stated so nobody mistakes this for a security boundary: RLS
 * grants every active staff member full read/write on all 51 tables regardless
 * of staff_users.role. A warehouse account can reach the same rows through
 * PostgREST directly. This shapes the product surface; it does not contain
 * anyone. The fix is a role matrix in RLS (api-plan B11 / README).
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
