"use client";

import { type ErrorBoundaryProps, ErrorState } from "@/components/error-state";

// Covers the routes with no shell of their own — the landing page, the (auth) group,
// and /unauthorized. Errors under /dashboard are caught one level down by
// app/dashboard/error.tsx, which keeps the sidebar and header mounted.
export default function ErrorBoundary({ error, reset }: ErrorBoundaryProps) {
  return <ErrorState error={error} reset={reset} className="min-h-dvh" />;
}
