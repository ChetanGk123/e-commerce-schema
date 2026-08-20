import type { ReactNode } from "react";

import type { Metadata } from "next";
import { ThemeProvider } from "next-themes";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { APP_CONFIG } from "@/config/app-config";
import { env } from "@/lib/env";
import { fontVars } from "@/lib/fonts";
import { QueryProvider } from "@/providers/query-provider";

import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(env.APP_URL),
  title: {
    default: APP_CONFIG.meta.title,
    // Child segments setting `title: "Users"` render as "Users | Admin". A plain
    // string here would be replaced outright, losing the app name from the tab.
    template: `%s | ${APP_CONFIG.name}`,
  },
  description: APP_CONFIG.meta.description,
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    // fontVars must sit on <html>: globals.css declares `--font-sans: var(--font-geist)`
    // in :root, and that reference only resolves where --font-geist is defined.
    <html lang="en" className={fontVars} suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <QueryProvider>
            <TooltipProvider>
              {children}
              <Toaster />
            </TooltipProvider>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
