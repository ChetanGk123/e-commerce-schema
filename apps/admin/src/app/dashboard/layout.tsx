import type { ReactNode } from "react";

import { cookies } from "next/headers";

import { AppSidebar } from "@/app/dashboard/_components/sidebar/app-sidebar";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { users } from "@/data/users";
import { requireStaff } from "@/lib/auth";
import { cn } from "@/lib/utils";

import { AccountSwitcher } from "./_components/header/account-switcher";
import { SearchDialog } from "./_components/header/search-dialog";
import { ThemeSwitcher } from "./_components/header/theme-switcher";

export default async function Layout({ children }: Readonly<{ children: ReactNode }>) {
  // THE gate. proxy.ts only checks a cookie exists; this asks the API who the
  // caller actually is, and a customer's perfectly valid token has no
  // staff_users row -- so /me answers 403 and this sends them to
  // /unauthorized. One call per request: getStaff is React-cached, so the
  // sidebar asking again below costs nothing.
  const staff = await requireStaff();

  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get("sidebar_state")?.value !== "false";

  return (
    <SidebarProvider
      defaultOpen={defaultOpen}
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 68)",
        } as React.CSSProperties
      }
    >
      {/* First focusable element in the DOM, so a keyboard user can jump the whole
          sidebar instead of tabbing through every nav item on every navigation.
          Visible only while focused. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:font-medium focus:text-sm focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <AppSidebar variant="inset" collapsible="icon" role={staff.role} />
      <SidebarInset
        className={cn(
          "peer-data-[variant=inset]:border",
          "[--dashboard-header-height:--spacing(12)]",
          "min-w-0 overflow-x-clip",
        )}
      >
        <header className="sticky top-0 z-50 flex h-12 shrink-0 items-center gap-2 overflow-hidden rounded-t-[inherit] border-b bg-background/50 backdrop-blur-md transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
          <div className="flex w-full items-center justify-between px-4 lg:px-6">
            <div className="flex items-center gap-1 lg:gap-2">
              <SidebarTrigger className="-ml-1" />
              <Separator
                orientation="vertical"
                className="mx-2 data-[orientation=vertical]:h-4 data-[orientation=vertical]:self-center"
              />
              <SearchDialog />
            </div>
            <div className="flex items-center gap-2">
              <ThemeSwitcher />
              <AccountSwitcher users={users} />
            </div>
          </div>
        </header>
        {/* Pages can set data-content-padding="false" to render full-bleed app layouts.
            tabIndex={-1} so the skip link above can move focus here, not just scroll. */}
        <main
          id="main-content"
          tabIndex={-1}
          className="min-h-0 min-w-0 flex-1 overflow-x-hidden p-4 focus:outline-none has-data-[content-padding=false]:p-0 md:p-6 md:has-data-[content-padding=false]:p-0"
        >
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
