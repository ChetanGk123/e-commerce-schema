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
