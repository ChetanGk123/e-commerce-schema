"use client";

import { type ErrorBoundaryProps, ErrorState } from "@/components/error-state";

// An error.tsx wraps the segments *below* it, never the layout beside it. Without this
// file a failing dashboard page bubbles to app/error.tsx, which sits above
// dashboard/layout.tsx and takes the sidebar and header down with it.
export default function DashboardError({ error, reset }: ErrorBoundaryProps) {
  return <ErrorState error={error} reset={reset} className="h-full min-h-[50vh]" />;
}
