import { cookies } from "next/headers";

/**
 * The admin's session cookie.
 *
 * This app holds NO Supabase client — api-plan B16 moved sign-in behind the
 * API, so credentials go to `POST /auth/sign-in` and what comes back is
 * stored here. That is why there is no `NEXT_PUBLIC_SUPABASE_*` anywhere in
 * this app, and why "grep the bundle for a key" is a check that can pass.
 *
 * `sb-admin`, not `sb-access-token`: the storefront will run on a sibling
 * domain against the same Supabase project, and a shared cookie name means
 * signing into one evicts the other.
 */
const COOKIE = "sb-admin";

export interface Session {
  accessToken: string;
  refreshToken: string;
  /** Unix seconds. Null when the API did not say. */
  expiresAt: number | null;
}

export async function readSession(): Promise<Session | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt ?? null,
    };
  } catch {
    // A cookie we cannot parse is a cookie from an older shape. Treat it as
    // signed out rather than throwing on every request until it expires.
    return null;
  }
}

export async function writeSession(session: Session): Promise<void> {
  (await cookies()).set(COOKIE, JSON.stringify(session), {
    // httpOnly is the whole point: script on this page cannot read the
    // token, so an XSS gets a request-forgery rather than a stolen session
    // it can replay from anywhere.
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // lax, not strict: strict drops the cookie on a top-level navigation
    // arriving from anywhere else, which signs you out every time you follow
    // a link into the admin from email or chat.
    sameSite: "lax",
    path: "/",
    // Track the refresh token's life, not the access token's hour. The
    // access token inside is refreshed in place.
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

/**
 * True when the access token is close enough to expiring to be worth
 * swapping before the next call.
 *
 * A 60s skew, not zero: a token that expires while the request is in flight
 * fails, and the whole point is to not make the user find out.
 */
export function isExpiring(session: Session, skewSeconds = 60): boolean {
  if (session.expiresAt === null) return false;
  return session.expiresAt - skewSeconds <= Math.floor(Date.now() / 1000);
}
