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
/**
 * A client acting as nobody -- role `anon`.
 *
 * The storefront catalog uses this unconditionally, even when the caller
 * happens to be signed in. The point is that /catalog answers the same way for
 * everyone: RLS's public_read policies decide what exists, so a draft product
 * is invisible and product_variants (which carries cost_price) is unreachable
 * no matter what the select list says. Forwarding a staff token here would
 * quietly widen the storefront to unpublished rows.
 */
/**
 * Every call out of this process gets a deadline.
 *
 * supabase-js has no timeout of its own -- it hands the request to fetch
 * and waits, and fetch waits forever. A PostgREST that accepts the
 * connection and then stops answering (a saturated pool, a lock nobody
 * releases, a network that black-holes rather than refuses) holds the
 * Hono request open for as long as the caller is willing to wait, and
 * holds this process's memory with it. Under load that is how one slow
 * query becomes an outage: every worker parks on a socket and the
 * service stops answering things it could have answered.
 *
 * The failure it converts to is honest -- errors.ts maps the abort to a
 * 504 rather than the generic 500, so a caller is told to retry rather
 * than told nothing.
 */
const withDeadline = ((
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> => {
  const deadline = AbortSignal.timeout(env.SUPABASE_TIMEOUT_MS);
  return fetch(input, {
    ...init,
    // supabase-js's own .abortSignal() has to keep working. Whichever
    // fires first wins; replacing the caller's signal would silently
    // disable every cancellation the client asked for.
    signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
  // The cast, and why it is not an Object.assign carrying Bun's
  // `preconnect`: packages/client type-checks this file (it imports
  // AppType) without @types/bun, so naming a Bun-only property here fails
  // its build -- the same way Bun.CryptoHasher did in B12. A wrapper that
  // forwards to fetch is a fetch; the helper it lacks is one nothing calls.
}) as unknown as typeof fetch;

let anon: SupabaseClient | undefined;

export function anonClient(): SupabaseClient {
  anon ??= createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: withDeadline },
  });
  return anon;
}

export function callerClient(accessToken: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` }, fetch: withDeadline },
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
    global: { fetch: withDeadline },
  });
  return cached;
}
