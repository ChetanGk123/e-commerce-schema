import { defaultShouldDehydrateQuery, isServer, QueryClient } from "@tanstack/react-query";

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Data prefetched on the server arrives fresh. Without a staleTime the client
        // refetches every hydrated query the moment it mounts.
        staleTime: 60 * 1000,
      },
      dehydrate: {
        // Also ship queries that are still in flight, so a Server Component can kick off
        // a fetch without awaiting it and let the streamed HTML deliver the result.
        shouldDehydrateQuery: (query) => defaultShouldDehydrateQuery(query) || query.state.status === "pending",
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

/**
 * A fresh client per request on the server, one shared client in the browser.
 * This module has no `"use client"` directive so Server Components can call it to prefetch.
 */
export function getQueryClient() {
  if (isServer) return makeQueryClient();

  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}
