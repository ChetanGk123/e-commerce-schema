"use server";

import { redirect } from "next/navigation";

import { api } from "@/lib/api";
import { clearSession, readSession } from "@/lib/session";

/**
 * Sign out.
 *
 * The cookie is cleared whatever the API says. A sign-out that fails because
 * the API is unreachable must still sign you out of this browser -- leaving a
 * usable session behind because a network call failed is the wrong direction
 * to fail in.
 */
export async function signOut(): Promise<void> {
  const session = await readSession();

  if (session) {
    try {
      await (await api()).auth["sign-out"].$post();
    } catch {
      // Best effort: the local cookie is what matters here.
    }
  }

  await clearSession();
  redirect("/login");
}
