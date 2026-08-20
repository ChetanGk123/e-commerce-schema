"use client";

import { useSidebar } from "@/components/ui/sidebar";

/**
 * The mobile sidebar is a sheet, and it stays open when a link inside it
 * navigates. Call this from anything in the sidebar that routes.
 *
 * Safe on desktop: `openMobile` is already false there, and React bails out of
 * a state update that does not change the value.
 */
export function useCloseMobileSidebar() {
  const { setOpenMobile } = useSidebar();

  return () => setOpenMobile(false);
}
