import type { ReactNode } from "react";

import Link from "next/link";

import { Command } from "lucide-react";

import { APP_CONFIG } from "@/config/app-config";

// Shared chrome for every page in the (auth) group, so the individual pages only
// describe their own card.
export default function AuthLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-muted/50 p-6">
      <Link prefetch={false} href="/" className="flex items-center gap-2 font-semibold">
        <Command className="size-5" />
        {APP_CONFIG.name}
      </Link>
      <main className="w-full max-w-sm">{children}</main>
    </div>
  );
}
