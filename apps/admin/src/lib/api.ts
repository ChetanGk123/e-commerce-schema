import { createApiClient } from "@ecom/client";

import { env } from "@/lib/env";
import { readSession } from "@/lib/session";

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

/** Reads the cookie itself. The common case. */
export async function api() {
  const session = await readSession();
  return apiForSession(session?.accessToken);
}

/** No token at all — sign-in, password reset, anything pre-session. */
export function anonApi() {
  return apiForSession(null);
}
