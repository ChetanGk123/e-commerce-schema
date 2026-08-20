"use client";

// sidebarItems carries lucide icon components, which cannot be serialized across
// the server/client boundary into NavMain.

import Link from "next/link";

import { CirclePlus, Command, Mail } from "lucide-react";

import type { StaffRole } from "@ecom/schema/enums";

import { ROUTES } from "@/constants";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { APP_CONFIG } from "@/config/app-config";
import { sidebarItems, sidebarSecondaryItems } from "@/constants";
import { rootUser } from "@/data/users";
import { useCloseMobileSidebar } from "@/hooks/use-close-mobile-sidebar";
import { filterNavByRole } from "@/lib/nav";

import { NavMain } from "./nav-main";
import { NavSecondary } from "./nav-secondary";
import { NavUser } from "./nav-user";

// TODO: wire these to your create flow and inbox. They are the primary action
// slot — swap the labels and icons for whatever your app opens with.
function QuickCreate() {
  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem className="flex items-center gap-2">
            <SidebarMenuButton
              tooltip="Quick Create"
              className="min-w-8 bg-primary text-primary-foreground duration-200 ease-linear hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground"
            >
              <CirclePlus />
              <span>Quick Create</span>
            </SidebarMenuButton>
            <Button variant="outline" size="icon" className="size-8 group-data-[collapsible=icon]:hidden">
              <Mail />
              <span className="sr-only">Inbox</span>
            </Button>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  /**
   * The signed-in staff member's role, from the server layout.
   *
   * A plain string on purpose: this is a client component (the nav data
   * carries lucide icon components, which cannot cross the boundary), so the
   * role comes in as a serializable prop and the filtering happens here.
   */
  role: StaffRole;
}

export function AppSidebar({ role, ...props }: AppSidebarProps) {
  const items = filterNavByRole(sidebarItems, role);
  const closeMobileSidebar = useCloseMobileSidebar();

  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <Link prefetch={false} href={ROUTES.DASHBOARD} onClick={closeMobileSidebar}>
                <Command />
                <span className="font-semibold text-base">{APP_CONFIG.name}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <QuickCreate />
        <NavMain items={items} />
        <NavSecondary items={sidebarSecondaryItems} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={rootUser} />
      </SidebarFooter>
    </Sidebar>
  );
}
