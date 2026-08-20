"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useCloseMobileSidebar } from "@/hooks/use-close-mobile-sidebar";
import type { NavMainLinkItem } from "@/types";

interface NavSecondaryProps {
  readonly items: readonly NavMainLinkItem[];
  readonly className?: string;
}

export function NavSecondary({ items, className }: NavSecondaryProps) {
  const path = usePathname();
  const closeMobileSidebar = useCloseMobileSidebar();

  return (
    <SidebarGroup className={className}>
      <SidebarGroupContent>
        <SidebarMenu className="gap-1">
          {items.map((item) => (
            <SidebarMenuItem key={item.id}>
              <SidebarMenuButton asChild size="sm" tooltip={item.title} isActive={path === item.url}>
                <Link
                  prefetch={false}
                  href={item.url}
                  target={item.newTab ? "_blank" : undefined}
                  rel={item.newTab ? "noreferrer" : undefined}
                  onClick={closeMobileSidebar}
                >
                  {item.icon && <item.icon />}
                  <span>{item.title}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
