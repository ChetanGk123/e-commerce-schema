import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

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
    "Reports only that the process is up. It deliberately does not check Postgres: a liveness probe that fails when the database blips pulls the API out of rotation for something a retry would have survived. Readiness against Supabase arrives with B1.",
  responses: {
    200: {
      description: "Process is up",
      content: { "application/json": { schema: HealthResponse } },
    },
  },
});

export const healthRoute = new OpenAPIHono().openapi(health, (c) =>
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
);
