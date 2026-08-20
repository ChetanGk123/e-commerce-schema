import { LayoutDashboard, Settings, Users } from "lucide-react";

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
