import { Contact, LayoutDashboard, Settings, Users } from "lucide-react";

import type { NavGroup, NavMainLinkItem } from "@/types";

export const sidebarItems: NavGroup[] = [
  {
    id: 1,
    items: [
      {
        id: "dashboard",
        title: "Dashboard",
        url: "/dashboard",
        icon: LayoutDashboard,
      },
      {
        id: "users",
        title: "Users",
        url: "/dashboard/users",
        icon: Users,
      },
      {
        id: "customers",
        title: "Customers",
        url: "/dashboard/customers",
        icon: Contact,
        // warehouse is absent deliberately: that role sees no PII beyond a
        // shipping address, per the role map in docs/admin-plan.md. The page
        // enforces the same list -- this only avoids offering a door that
        // will not open.
        roles: ["owner", "admin", "manager", "support"],
      },
    ],
  },
];

/** Pinned to the bottom of the sidebar, above the user menu. */
export const sidebarSecondaryItems: NavMainLinkItem[] = [
  {
    id: "settings",
    title: "Settings",
    url: "/dashboard/settings",
    icon: Settings,
  },
];
