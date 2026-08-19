import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { validationHook } from "../schemas";
import { anonClient } from "../supabase";

/**
 * Flipped by server.ts the moment a shutdown signal arrives.
 *
 * Readiness has to start failing BEFORE the server stops accepting, or
 * whatever routes to this instance keeps sending requests into a socket
 * that is closing, and the drain shows up to users as connection errors.
 * Liveness deliberately does not read this: a probe that fails during a
 * drain gets the process killed mid-request, which is the opposite of
 * what the drain is for.
 */
let draining = false;

export function beginShutdown(): void {
  draining = true;
}

/**
 * Probes get their own, much shorter deadline than SUPABASE_TIMEOUT_MS.
 * An orchestrator gives a readiness check a second or two; one that sits
 * for ten is failed by the orchestrator anyway, having told us nothing.
 */
const PROBE_TIMEOUT_MS = 2_000;

const HealthResponse = z
  .object({
    status: z.literal("ok"),
    service: z.literal("api"),
    uptime_s: z.number().int().nonnegative(),
  })
  .openapi("HealthResponse");

const health = createRoute({
  method: "get",
  path: "/health",
  tags: ["meta"],
  summary: "Liveness probe",
  description:
    "Reports only that the process is up, and stays 200 during a shutdown drain. It deliberately does not check Postgres: a liveness probe that fails when the database blips restarts a process that a retry would have carried through. Point your orchestrator's *liveness* check here and its *readiness* check at /health/ready -- swapping them turns a brief database blip into a restart loop.",
  responses: {
    200: {
      description: "Process is up",
      content: { "application/json": { schema: HealthResponse } },
    },
  },
});

const ReadyResponse = z
  .object({
    status: z.enum(["ready", "draining", "degraded"]),
    database: z.enum(["ok", "unreachable"]),
    latency_ms: z.number().int().nonnegative().nullable(),
  })
  .openapi("ReadyResponse");

const ready = createRoute({
  method: "get",
  path: "/health/ready",
  tags: ["meta"],
  summary: "Readiness probe",
  description:
    "Whether this instance can actually serve a request, which liveness deliberately does not answer. It reads one row through the anon client, so it exercises the whole path a real request takes -- Kong, PostgREST, Postgres, RLS -- rather than asserting the process is running.\n\n503 means take this instance out of rotation: either the database is unreachable, or a shutdown has started and the last in-flight requests are being drained.",
  responses: {
    200: {
      description: "Serving",
      content: { "application/json": { schema: ReadyResponse } },
    },
    503: {
      description: "Draining, or the database is unreachable",
      content: { "application/json": { schema: ReadyResponse } },
    },
  },
});

export const healthRoute = new OpenAPIHono({ defaultHook: validationHook }).openapi(health, (c) =>
  // No env values here on purpose: a health endpoint that echoes config is a
  // config leak reachable without auth.
  c.json(
    {
      status: "ok" as const,
      service: "api" as const,
      uptime_s: Math.floor(process.uptime()),
    },
    200,
  ),
)

  .openapi(ready, async (c) => {
    if (draining) {
      // No point asking the database: this instance is going away whatever
      // it answers.
      return c.json(
        { status: "draining" as const, database: "ok" as const, latency_ms: null },
        503,
      );
    }

    const started = performance.now();
    // `categories` has a public_read policy, so the anon role really can
    // read it -- a probe that needed the service key would pass while
    // every storefront request failed.
    const { error } = await anonClient()
      .from("categories")
      .select("id")
      .limit(1)
      // Beats the client-wide deadline: withDeadline in supabase.ts keeps
      // whichever signal fires first, which is what makes this possible.
      .abortSignal(AbortSignal.timeout(PROBE_TIMEOUT_MS));
    const latency_ms = Math.round(performance.now() - started);

    if (error) {
      // The reason goes to the log, not the response: this endpoint is
      // unauthenticated, and "which host we could not reach" is not
      // something to hand a stranger.
      c.get("log")?.error({ err: error.message, latency_ms }, "health.not_ready");
      return c.json(
        { status: "degraded" as const, database: "unreachable" as const, latency_ms },
        503,
      );
    }

    return c.json(
      { status: "ready" as const, database: "ok" as const, latency_ms },
      200,
    );
  });
