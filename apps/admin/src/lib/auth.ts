import { cache } from "react";

import { redirect } from "next/navigation";

import type { StaffRole } from "@ecom/schema/enums";

import { api } from "@/lib/api";

export interface Staff {
  userId: string;
  role: StaffRole;
  fullName: string | null;
}

/**
 * Who is signed in, or null.
 *
 * `cache()` from React, not a module-level variable: this dedupes within ONE
 * request, so the layout, the sidebar and the page each asking "who is this"
 * costs a single call to the API. A module-level cache would leak one staff
 * member's identity into another's request on a warm server.
 *
 * `/me` answers 403 for a customer's valid token — authenticated, but with no
 * `staff_users` row. That missing row is the only thing keeping shoppers off
 * this surface, so a 403 is a real answer here rather than an error.
 */
export const getStaff = cache(async (): Promise<Staff | null> => {
  const res = await (await api()).me.$get();
  if (!res.ok) return null;

  const me = await res.json();
  if (!me.isStaff || me.role === null) return null;

  return { userId: me.userId, role: me.role, fullName: me.fullName };
});

/**
 * For a page that any staff member may see.
 *
 * Signed out goes to /login; signed in but not staff goes to /unauthorized.
 * They are different answers to different questions and must not be merged:
 * bouncing a signed-in customer to /login invites them to sign in again,
 * which will not help and looks like the login is broken.
 */
export async function requireStaff(): Promise<Staff> {
  const staff = await getStaff();
  if (!staff) redirect("/unauthorized");
  return staff;
}

/**
 * For a page only some roles may see.
 *
 * TESTING NOTE, because it wasted a round here. A redirect from a LAYOUT
 * arrives as an HTTP 307; a redirect from a PAGE usually does not. By the
 * time a page component runs, the shell has begun streaming and the status
 * line is already sent -- so Next embeds a client-side navigation and the
 * response is 200. Asserting on the status code will tell you the gate is
 * broken when it is not. Assert on the BODY: the forbidden data must be
 * absent and /unauthorized present.
 */
export async function requireRole(roles: readonly StaffRole[]): Promise<Staff> {
  const staff = await requireStaff();
  if (!roles.includes(staff.role)) redirect("/unauthorized");
  return staff;
}

/**
 * Non-redirecting, for deciding what to RENDER — nav items, buttons.
 *
 * Hiding a link is not access control. The page it points at still calls
 * requireRole, and the API still enforces the role itself; this only avoids
 * showing someone a door that will not open.
 */
export function hasRole(staff: Staff | null, roles: readonly StaffRole[]): boolean {
  return staff !== null && roles.includes(staff.role);
}
