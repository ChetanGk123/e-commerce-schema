import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

import { env } from "./env";

/**
 * Rate limiting for the surfaces anyone can write to without an account.
 *
 * A fixed window in process memory. Two honest limitations, both of which
 * are fine for what this defends against and neither of which should be
 * discovered in production:
 *
 *   PER INSTANCE. Three API containers means three times the limit. This
 *   is a guard against a script hammering /enquiries, not a quota system.
 *
 *   Do NOT answer that by moving it to Traefik and setting
 *   RATE_LIMIT_PER_MINUTE=0. Traefik's rateLimit is a token bucket per
 *   middleware; what this is, is one shared budget per IP that different
 *   surfaces spend at different rates -- and the sharing is the point.
 *   Burn it guessing order numbers and you cannot also spend it on
 *   sign-in. Reproducing that upstream needs a middleware and a router
 *   per surface, and they would be independent buckets: a weaker policy
 *   than this one, kept in a place nobody will look. docs/setup.md C8
 *   has the arrangement that does work -- Traefik for volume, this for
 *   which surface costs what.
 *
 *   PER IP. Anyone behind the same NAT shares a bucket. The limits below
 *   are set high enough that a shared office connection browsing a shop
 *   never reaches them.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Expired buckets are dropped on write rather than on a timer, and the
 * whole map is swept when it grows. Without this an attacker rotating
 * source addresses turns the limiter into a memory leak -- which is a
 * better denial of service than the one it was stopping.
 */
const MAX_TRACKED = 50_000;

function sweep(now: number): void {
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Who is this, for limiting purposes.
 *
 * X-Forwarded-For is only read when TRUSTED_PROXY_HEADER names it. An
 * unconditional read lets any caller send their own value and get a fresh
 * bucket per request, which is a limiter that limits nobody.
 */
function clientKey(c: Context): string {
  const header = env.TRUSTED_PROXY_HEADER;
  if (header) {
    const raw = c.req.header(header);
    // X-Forwarded-For is a list; the client is the first entry.
    if (raw) return raw.split(",")[0]!.trim();
  }
  // Bun exposes the socket address here. Absent in tests, where every
  // request would otherwise share one bucket -- hence the fallback.
  const info = c.env as { requestIP?: (r: Request) => { address?: string } | null } | undefined;
  return info?.requestIP?.(c.req.raw)?.address ?? "unknown";
}

/**
 * `cost` lets an expensive surface spend more of the same budget: a
 * checkout attempt is worth more than a product page, so ten of them
 * should exhaust the allowance sooner.
 */
export function rateLimit(cost = 1) {
  return createMiddleware(async (c: Context, next: Next) => {
    if (env.RATE_LIMIT_PER_MINUTE === 0) return next();

    const now = Date.now();
    if (buckets.size > MAX_TRACKED) sweep(now);

    const key = clientKey(c);
    const existing = buckets.get(key);
    const bucket =
      existing && existing.resetAt > now
        ? existing
        : { count: 0, resetAt: now + 60_000 };

    bucket.count += cost;
    buckets.set(key, bucket);

    const remaining = Math.max(0, env.RATE_LIMIT_PER_MINUTE - bucket.count);
    c.header("RateLimit-Limit", String(env.RATE_LIMIT_PER_MINUTE));
    c.header("RateLimit-Remaining", String(remaining));
    c.header("RateLimit-Reset", String(Math.ceil((bucket.resetAt - now) / 1000)));

    if (bucket.count > env.RATE_LIMIT_PER_MINUTE) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      c.header("Retry-After", String(retryAfter));
      c.get("log")?.warn({ path: c.req.path }, "ratelimit.exceeded");
      throw new HTTPException(429, {
        message: "Too many requests. Try again shortly.",
        cause: { code: "rate_limited" },
      });
    }

    await next();
  });
}

/** Exposed for tests; there is no reason for a route to call this. */
export function resetRateLimits(): void {
  buckets.clear();
}
