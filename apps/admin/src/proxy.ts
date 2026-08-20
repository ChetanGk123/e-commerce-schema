import { ROUTES } from "@/constants";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Next 16 calls this file `proxy.ts`; it was `middleware.ts` before.
 *
 * WHAT THIS IS AND IS NOT. It only checks that a session cookie EXISTS, and
 * bounces to /login when it does not. It does not decode the token, does not
 * ask who you are, and is not access control -- the cookie is httpOnly and
 * opaque here, and anything more would mean an API round trip on every asset
 * request.
 *
 * The real gate is `requireStaff()` in the dashboard layout, which asks the
 * API. This exists so a signed-out visitor gets a login page instead of a
 * layout that renders, calls /me, and redirects a beat later.
 */
const COOKIE = "sb-admin";

export function proxy(request: NextRequest) {
  const hasSession = request.cookies.has(COOKIE);
  const { pathname, search } = request.nextUrl;

  if (!hasSession) {
    const login = new URL(ROUTES.LOGIN, request.url);
    // Where they were going, so sign-in can put them back. Path and query
    // only -- never the whole URL, which would let a crafted ?next= bounce
    // someone to another origin after a successful sign-in.
    if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Everything except the auth pages, Next's own assets and the health probe.
   *
   * `/unauthorized` is excluded deliberately: a signed-in customer has a
   * cookie, so they reach it -- but a signed-OUT visitor must be able to see
   * it too rather than be bounced into a login loop.
   */
  matcher: [
    "/((?!login|register|forgot-password|unauthorized|api/health|_next/static|_next/image|favicon.ico|icon).*)",
  ],
};
