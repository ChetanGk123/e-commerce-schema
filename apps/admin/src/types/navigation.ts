import type { StaffRole } from "@ecom/schema/enums";
import type { LucideIcon } from "lucide-react";

export type NavBadge = "new" | "soon";

export interface NavSubItem {
  id: string;
  title: string;
  url: string;
  /**
   * Who may see this. Absent means every staff role.
   *
   * Hiding a link is NOT access control -- the page still calls requireRole
   * and the API still enforces it. This only avoids showing someone a door
   * that will not open.
   */
  roles?: readonly StaffRole[];
  icon?: LucideIcon;
  badge?: NavBadge;
  disabled?: boolean;
  newTab?: boolean;
}

interface NavItemBase {
  id: string;
  title: string;
  /** See NavSubItem.roles. Absent means every staff role. */
  roles?: readonly StaffRole[];
  icon?: LucideIcon;
  badge?: NavBadge;
  disabled?: boolean;
  newTab?: boolean;
}

export interface NavMainLinkItem extends NavItemBase {
  url: string;
  subItems?: never;
}

export interface NavMainParentItem extends NavItemBase {
  subItems: NavSubItem[];
}

export type NavMainItem = NavMainLinkItem | NavMainParentItem;

export interface NavGroup {
  id: number;
  label?: string;
  items: NavMainItem[];
}
