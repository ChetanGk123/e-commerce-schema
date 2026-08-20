"use client";

// Replaces the root layout when it is the layout itself that throws, so this file
// must render its own <html> and <body>.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-center">
          <h1 className="font-semibold text-2xl">Something went wrong.</h1>
          <p className="text-neutral-500">The application failed to load.</p>
          {error.digest && <p className="font-mono text-neutral-500 text-xs">Digest: {error.digest}</p>}
          <button
            type="button"
            onClick={reset}
            className="rounded-lg border px-3 py-1.5 font-medium text-sm hover:bg-neutral-100"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
