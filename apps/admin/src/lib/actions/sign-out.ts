"use server";

import { redirect } from "next/navigation";

import { api } from "@/lib/api";
import { clearSession, readSession } from "@/lib/session";

/**
 * Sign out.
 *
 * IN lib/, NOT (auth)/_actions/. `_actions` and `_components` mean "private
 * to this route", and this is imported from two dashboard components in a
 * different route group -- reaching across route groups into someone else's
 * private folder is the thing the underscore is there to discourage.
 *
 * signIn stays put on purpose: it has one caller, in its own route group.
 * The house rule is to colocate until a SECOND feature imports it, and
 * moving both for symmetry would pre-create a shared abstraction the rule
 * explicitly warns against.
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
