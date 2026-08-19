// `import type`, and it matters. @ecom/api's entry pulls in app.ts, which
// pulls in env.ts, which THROWS at import when SUPABASE_SERVICE_ROLE_KEY
// is absent -- as it always is in a browser. A type-only import is erased
// before the bundler ever sees it; a value import would ship the server
// into the client and fail at boot with a message about a missing
// environment variable, which is a confusing way to learn this.
import type { AppType } from "@ecom/api";
import { hc } from "hono/client";

export type { AppType };

export interface ClientOptions {
  /**
   * Where the API lives. The INTERNAL address for server components
   * (http://api:3001 on the deploy network), the public one for the
   * browser -- mixing them produces failures that read like CORS errors.
   */
  baseUrl: string;
  /**
   * Called before every request. Return the caller's Supabase access
   * token, or null for an anonymous one.
   *
   * A function rather than a string because tokens expire in an hour and
   * a client built once at module scope would hold a stale one for the
   * life of the page.
   */
  getToken?: () => string | null | undefined | Promise<string | null | undefined>;
  /** Guest cart identity. See X-Cart-Session in the API docs. */
  getCartSession?: () => string | null | undefined;
}

/**
 * A typed client for the whole API.
 *
 * Every route, its parameters and its response shape come from the same
 * zod schemas the server validates with, so a route that changes shape
 * breaks the front end at `tsc` rather than at runtime. That is the point
 * of the whole `createRoute` convention in apps/api.
 *
 *   const api = createApiClient({ baseUrl, getToken: () => session?.access_token });
 *   const res = await api.catalog.products.$get({ query: { limit: "12" } });
 *   if (res.ok) { const { items } = await res.json(); }
 */
export function createApiClient(options: ClientOptions) {
  return hc<AppType>(options.baseUrl, {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const headers = new Headers(init?.headers);

      const token = await options.getToken?.();
      if (token) headers.set("Authorization", `Bearer ${token}`);

      const cart = options.getCartSession?.();
      if (cart) headers.set("X-Cart-Session", cart);

      return fetch(input, { ...init, headers });
    },
  });
}

export type ApiClient = ReturnType<typeof createApiClient>;
