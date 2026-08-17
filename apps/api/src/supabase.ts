import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { env } from "./env";

/**
 * A client acting AS the caller.
 *
 * apikey stays the anon key while Authorization carries the caller's JWT, so
 * PostgREST runs the request as that user: RLS applies and auth.uid() is
 * populated.
 *
 * That second part is the whole reason this exists. audit_row() writes
 * audit_logs.staff_id from auth.uid(); run staff writes on the service key
 * instead and every price edit, discount change and gift-card action is
 * recorded anonymously. The staff_all policy already grants active staff full
 * access, so forwarding the JWT costs nothing in capability.
 */
export function callerClient(accessToken: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Bypasses RLS entirely, and auth.uid() is null under it.
 *
 * Allowed callers, per docs/api-plan.md, and nothing else:
 *   - checkout (reads prices the client must not choose)
 *   - payment capture
 *   - webhook handlers
 *   - creating staff auth users
 *
 * Anything a staff member does on their own behalf uses callerClient(), or the
 * audit trail loses its attribution.
 */
let cached: SupabaseClient | undefined;

export function serviceClient(): SupabaseClient {
  cached ??= createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
