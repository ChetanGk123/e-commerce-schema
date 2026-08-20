"use server";

import { redirect } from "next/navigation";

import { anonApi } from "@/lib/api";
import { writeSession } from "@/lib/session";

export interface SignInResult {
  error: string;
}

/**
 * Sign in, entirely on the server.
 *
 * A Server Action rather than a fetch from the form: the password is posted
 * to this process and never becomes a request the browser's own JS composed,
 * and the session cookie is set httpOnly in the same round trip. A client
 * fetch would have to hand the token back to script to store, which is the
 * thing httpOnly exists to prevent.
 *
 * Returns on failure, redirects on success — a Server Action cannot do both,
 * and `redirect()` throws to unwind, so it must be outside the try.
 */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  const res = await anonApi().auth["sign-in"].$post({
    json: { email, password },
  });

  if (!res.ok) {
    // The API's envelope, not our own wording. It owns the constraint→copy
    // mapping and this app must not reinvent it. Credentials are never
    // echoed back, and nothing here is logged.
    const body = (await res.json()) as { error?: { message?: string } };
    return { error: body.error?.message ?? "Could not sign you in. Try again." };
  }

  const session = await res.json();
  await writeSession({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.expiresAt,
  });

  // Deliberately NOT checking staff-ness here. /dashboard's layout calls
  // requireStaff, so a customer who signs in correctly lands on
  // /unauthorized -- which is the honest answer -- rather than being told
  // their password was wrong.
  redirect("/dashboard");
}
