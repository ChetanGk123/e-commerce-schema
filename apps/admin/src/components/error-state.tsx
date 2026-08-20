"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The props Next.js hands to every `error.tsx`. */
export type ErrorBoundaryProps = {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
};

/**
 * Shared body for both error boundaries — `app/error.tsx` for the public routes,
 * `app/dashboard/error.tsx` inside the shell. One copy so wiring an error reporter
 * is a one-file change instead of a thing to remember twice.
 *
 * `global-error.tsx` deliberately does not use this: it replaces the root layout, so
 * `globals.css` never loads and no theme token resolves there.
 */
export function ErrorState({ error, reset, className }: ErrorBoundaryProps & { readonly className?: string }) {
  useEffect(() => {
    // TODO: forward to your error reporter (Sentry, Axiom, …).
    console.error(error);
  }, [error]);

  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 text-center", className)}>
      <h1 className="font-semibold text-2xl">Something went wrong.</h1>
      <p className="text-muted-foreground">An unexpected error occurred while rendering this page.</p>
      {error.digest && <p className="font-mono text-muted-foreground text-xs">Digest: {error.digest}</p>}
      <Button variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
