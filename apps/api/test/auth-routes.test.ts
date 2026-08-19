import { beforeEach, describe, expect, test } from "bun:test";

import { app } from "../src/app";
import { resetRateLimits } from "../src/limits";

/**
 * The auth surface (src/routes/auth.ts), as distinct from the middleware
 * that verifies a token (src/auth.ts, covered in auth.test.ts).
 *
 * Every handler here forwards to GoTrue, so the happy paths need a live
 * Supabase and are verified against one by hand. What runs in-process is
 * everything that resolves BEFORE the handler's fetch: the rate limiter,
 * requireAuth, and zod. Nothing in this file touches the network -- if a
 * test ever starts doing so it will hang in CI rather than fail, which
 * is why the bodies below are deliberately invalid.
 */
beforeEach(resetRateLimits);

const doc = async () =>
  (await (await app.request("/openapi.json")).json()) as {
    paths: Record<
      string,
      Record<string, { security?: unknown[]; responses: Record<string, unknown> }>
    >;
    components: { schemas: Record<string, unknown> };
  };

const post = (path: string, body: unknown, auth?: string) =>
  app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });

describe("the browser no longer needs Supabase Auth", () => {
  test("every auth endpoint is mounted", async () => {
    const paths = Object.keys((await doc()).paths);
    for (const p of [
      "/auth/sign-up",
      "/auth/sign-in",
      "/auth/refresh",
      "/auth/sign-out",
      "/auth/password/forgot",
      "/auth/password/change",
    ]) {
      expect(paths).toContain(p);
    }
  });

  test("sign-in, sign-up, refresh and forgot are public", async () => {
    // A caller with no session must be able to reach the endpoint that
    // gives them one. Declaring bearerAuth here would be nonsense.
    const paths = (await doc()).paths;
    for (const p of ["/auth/sign-up", "/auth/sign-in", "/auth/refresh", "/auth/password/forgot"]) {
      expect(`${p}: ${JSON.stringify(paths[p]?.post?.security ?? null)}`).toBe(`${p}: null`);
    }
  });

  test("sign-out and password change require a token", async () => {
    const paths = (await doc()).paths;
    for (const p of ["/auth/sign-out", "/auth/password/change"]) {
      expect(paths[p]?.post?.security).toBeTruthy();
    }
    expect((await post("/auth/sign-out", {})).status).toBe(401);
    expect((await post("/auth/password/change", { password: "LongEnough123" })).status).toBe(401);
  });
});

describe("credentials never come back out", () => {
  test("no response schema mentions a password", async () => {
    const { components } = await doc();
    // Session is what sign-in and refresh return. A password field
    // reaching it would put a live credential in every proxy log.
    expect(JSON.stringify(components.schemas.Session)).not.toContain("password");
  });

  test("Session carries a refresh token and an expiry, not a bare JWT", async () => {
    // A client that cannot see expiresIn has to wait for a 401 to learn
    // its token died, which is a request that failed avoidably.
    const session = JSON.stringify((await doc()).components.schemas.Session);
    for (const field of ["accessToken", "refreshToken", "expiresIn"]) {
      expect(session).toContain(field);
    }
  });
});

describe("validation happens before anything reaches GoTrue", () => {
  test.each([
    ["/auth/sign-in", { email: "not-an-email", password: "x" }],
    ["/auth/sign-up", { email: "nope", password: "short" }],
    ["/auth/refresh", { refresh_token: "" }],
    ["/auth/password/forgot", { email: "nope" }],
  ])("%s rejects a bad body with 400", async (path, body) => {
    const res = await post(path, body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    // The same envelope as everything else, so a client branches on code.
    expect(json.error.code).toBe("invalid_request");
  });

  test("sign-up demands a password long enough to be worth hashing", async () => {
    const res = await post("/auth/sign-up", { email: "someone@test.local", password: "1234567" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain("8 characters");
  });
});

describe("sign-in is rate limited", () => {
  test("the budget runs out, and not on the first request", async () => {
    // Cost 10 against a 60/minute budget, so the seventh attempt from one
    // address is refused. This is the endpoint a password list is aimed
    // at, and the limiter is the only thing between it and GoTrue.
    //
    // The body is invalid on purpose: validation answers 400 without the
    // handler ever calling out, so this test needs no network.
    const codes: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      codes.push((await post("/auth/sign-in", { email: "not-an-email", password: "x" })).status);
    }
    expect(codes[0]).not.toBe(429);
    expect(codes).toContain(429);
  });

  test("a refusal says when to come back", async () => {
    let res = await post("/auth/sign-in", { email: "not-an-email", password: "x" });
    for (let i = 0; i < 12 && res.status !== 429; i += 1) {
      res = await post("/auth/sign-in", { email: "not-an-email", password: "x" });
    }
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });
});
