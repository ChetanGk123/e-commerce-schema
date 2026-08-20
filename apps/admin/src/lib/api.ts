import { createApiClient } from "@ecom/client";

import { env } from "@/lib/env";
import { isExpiring, readSession, writeSession } from "@/lib/session";

/**
 * The typed API client, bound to the signed-in staff member.
 *
 * Every route, its parameters and its response shape come from the same zod
 * schemas apps/api validates with, so a route that changes breaks this app at
 * `tsc` rather than in a browser.
 *
 * Server-side only. `env.API_URL` is `http://api:3001` inside the compose
 * network, which means nothing to a browser — that is deliberate, and why
 * the variable is not `NEXT_PUBLIC_`.
 */
export function apiForSession(accessToken?: string | null) {
  return createApiClient({
    baseUrl: env.API_URL,
    getToken: () => accessToken ?? null,
  });
}

/** Reads the cookie itself, refreshing first if the token is about to go. */
export async function api() {
  return apiForSession(await refreshed());
}

/** No token at all — sign-in, password reset, anything pre-session. */
export function anonApi() {
  return apiForSession(null);
}

/**
 * Swap a nearly-expired access token for a fresh one, in place.
 *
 * Called before building the client rather than on a 401, deliberately.
 * Retrying after a 401 means re-sending the original request, and some of
 * them are not safe to send twice -- a refund, a capture, a stock movement.
 * Refreshing first makes the expiry a non-event instead of something every
 * mutation has to be idempotent about.
 *
 * A refresh that fails is not an error to surface: the refresh token has
 * expired or been revoked, which is just "signed out". The next call gets a
 * 401, /me returns null, and requireStaff redirects.
 */
async function refreshed(): Promise<string | null> {
  const session = await readSession();
  if (!session) return null;
  if (!isExpiring(session)) return session.accessToken;

  const res = await anonApi().auth.refresh.$post({
    json: { refresh_token: session.refreshToken },
  });
  if (!res.ok) return null;

  const next = await res.json();
  await writeSession({
    accessToken: next.accessToken,
    // Supabase rotates the refresh token on use. Storing the OLD one here
    // would work exactly once more and then sign everyone out an hour later.
    refreshToken: next.refreshToken,
    expiresAt: next.expiresAt,
  });
  return next.accessToken;
}
