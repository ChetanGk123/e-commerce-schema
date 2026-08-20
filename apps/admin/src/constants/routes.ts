/**
 * Every path this app navigates to.
 *
 * WHY THESE AND NOT THE API'S. The API is reached through `hc<AppType>`,
 * which navigates by property access -- `api.admin.customers.$get()` -- so
 * there is no endpoint string anywhere in this app to centralise. A const of
 * API paths would be a second copy of what AppType already encodes, unused by
 * the calls it claims to describe and free to drift from them. These are the
 * app's OWN routes, which really are strings, and really were repeated:
 * /dashboard in seven files, /login in five.
 *
 * `satisfies` rather than a bare object, so values stay literal types --
 * `typeof ROUTES.LOGIN` is "/login", not string, which keeps them usable
 * where a literal is required.
 */
export const ROUTES = {
  HOME: "/",

  // Auth. Excluded from the proxy matcher -- a signed-out visitor must be
  // able to reach these.
  LOGIN: "/login",
  REGISTER: "/register",
  FORGOT_PASSWORD: "/forgot-password",

  /**
   * Signed in, but not staff. Not the same answer as LOGIN, and the two must
   * not be merged: bouncing a signed-in customer to the login page invites
   * them to sign in again, which will not help.
   */
  UNAUTHORIZED: "/unauthorized",

  // The console.
  DASHBOARD: "/dashboard",
  CUSTOMERS: "/dashboard/customers",
  USERS: "/dashboard/users",
  SETTINGS: "/dashboard/settings",
} as const satisfies Record<string, `/${string}`>;

export type Route = (typeof ROUTES)[keyof typeof ROUTES];
