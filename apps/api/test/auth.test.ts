import { describe, expect, test } from "bun:test";
import { SignJWT } from "jose";

import { app } from "../src/app";
import { env } from "../src/env";

const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);

/** A token GoTrue would accept: HS256 over the shared secret, sub = user id. */
function token(sub: string, expiresIn = "1h") {
  return new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);
}

const get = (auth?: string) =>
  app.request("/me", auth ? { headers: { Authorization: auth } } : undefined);

describe("B1 auth — 401 is 'who are you', 403 is 'not you'", () => {
  test("no Authorization header is 401", async () => {
    expect((await get()).status).toBe(401);
  });

  test("a non-Bearer scheme is 401", async () => {
    expect((await get("Basic dXNlcjpwYXNz")).status).toBe(401);
  });

  test("a malformed token is 401", async () => {
    expect((await get("Bearer not.a.jwt")).status).toBe(401);
  });

  test("a token signed with the wrong secret is 401", async () => {
    const forged = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("00000000-0000-4000-8000-000000000001")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("not-the-real-secret"));
    expect((await get(`Bearer ${forged}`)).status).toBe(401);
  });

  test("an expired token is 401", async () => {
    const stale = await token("00000000-0000-4000-8000-000000000001", "-1h");
    expect((await get(`Bearer ${stale}`)).status).toBe(401);
  });

  test("a valid token with no sub claim is 401", async () => {
    const noSub = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(secret);
    expect((await get(`Bearer ${noSub}`)).status).toBe(401);
  });

  test("401 responses never say why", async () => {
    // Distinguishing expired from forged from malformed hands an attacker a
    // free oracle. All of them answer identically.
    const stale = await token("00000000-0000-4000-8000-000000000001", "-1h");
    const messages = await Promise.all(
      ["Bearer not.a.jwt", `Bearer ${stale}`].map(async (h) => {
        const body = (await (await get(h)).json()) as {
          error: { message: string };
        };
        return body.error.message;
      }),
    );
    expect(new Set(messages).size).toBe(1);
  });
});

describe("403 responses never say why either", () => {
  /**
   * requireStaff refuses on two branches: no `staff_users` row, and a row
   * with `is_active = false`. Which one fires is decided by RLS -- today
   * `staff_all` is gated on `is_staff()`, so a deactivated member cannot
   * see their own row and only the first branch is ever reached.
   *
   * That is an accident of the current policy set. B11 replaces it, and
   * the second branch may start firing. This pins the thing that must not
   * change when it does: the caller gets the same sentence either way.
   * Reaching both branches for real needs a database, so the invariant is
   * checked at the source.
   */
  const source = () => Bun.file(new URL("../src/auth.ts", import.meta.url)).text();

  test("both staff refusals throw the same message", async () => {
    const text = await source();
    const messages = [...text.matchAll(/HTTPException\(403,\s*\{\s*message:\s*([^,\n}]+)/g)].map(
      (m) => m[1]!.trim(),
    );
    expect(messages.length).toBeGreaterThanOrEqual(2);
    // A bare string literal creeping back into either branch is exactly
    // the drift this catches.
    expect(messages.filter((m) => m === "STAFF_REFUSED").length).toBe(2);
  });

  test("the is_active guard is still there", async () => {
    // Redundant under today's RLS, load-bearing the moment a role matrix
    // lets a staff member read their own row. Deleting it as dead code
    // would silently let deactivated accounts back in.
    expect(await source()).toContain("!data.is_active");
  });
});
