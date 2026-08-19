import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireAuth, requireStaff } from "../auth";
import { env } from "../env";
import { throwOnDbError } from "../errors";
import { drainOutbox } from "../jobs";
import { jsonError, validationHook } from "../schemas";

/**
 * Driving the outbox from outside.
 *
 * The in-process loop is the normal path; this exists for the two cases
 * it does not cover -- an operator who wants the queue moved now, and a
 * deployment that would rather an external scheduler owned the cadence
 * (set JOBS_INTERVAL_SECONDS=0 and call this).
 *
 * Guarded by a shared secret rather than a JWT, because the caller is a
 * cron entry or a person with curl, not a signed-in staff member. With
 * no secret configured it refuses everyone: an unauthenticated endpoint
 * that drains the outbox is one anybody can use to burn the send quota.
 */
const DrainResult = z
  .object({
    claimed: z.number().int(),
    sent: z.number().int(),
    requeued: z.number().int(),
    failed: z.number().int(),
    skipped: z.string().optional(),
  })
  .openapi("DrainResult");

const drain = createRoute({
  method: "post",
  path: "/jobs/drain",
  tags: ["jobs"],
  summary: "Send whatever is queued",
  description:
    "Requires the `X-Jobs-Secret` header to match JOBS_SECRET. Safe to call concurrently with the in-process loop: the claim uses FOR UPDATE SKIP LOCKED, so two drainers split the queue rather than sending the same message twice.\n\nWith no mail provider configured it claims nothing and says so, leaving every message queued.",
  request: {
    headers: z.object({ "x-jobs-secret": z.string().min(16) }),
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(20) }),
  },
  responses: {
    200: { description: "What the pass did", content: { "application/json": { schema: DrainResult } } },
    400: jsonError("Missing or malformed secret header"),
    403: jsonError("Wrong secret, or none configured on this deployment"),
  },
});

const health = createRoute({
  method: "get",
  path: "/admin/outbox",
  tags: ["admin", "jobs"],
  summary: "Outbox health",
  description:
    "`stalledSending` should be zero. Anything else means a drainer died mid-send and the rows are waiting on requeue_stalled_messages().",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  responses: {
    200: {
      description: "Queue state",
      content: {
        "application/json": {
          schema: z.object({
            byStatus: z.record(z.number().int()),
            oldestQueuedAt: z.string().nullable(),
            stalledSending: z.number().int(),
            mailerConfigured: z.boolean(),
            warning: z.string().nullable(),
          }),
        },
      },
    },
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
  },
});

/** Constant time, so a wrong secret cannot be found one byte at a time. */
function secretMatches(given: string): boolean {
  const expected = env.JOBS_SECRET;
  if (!expected) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  // Compare a fixed number of bytes regardless of length, then require
  // the lengths to match too.
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

export const jobsRoute = new OpenAPIHono({ defaultHook: validationHook })
  .openapi(drain, async (c) => {
    if (!secretMatches(c.req.valid("header")["x-jobs-secret"])) {
      c.get("log")?.warn("jobs.drain_rejected");
      return c.json(
        {
          error: {
            code: "forbidden",
            message: "Not allowed.",
            requestId: c.get("reqId"),
          },
        },
        403,
      );
    }
    return c.json(await drainOutbox(c.req.valid("query").limit), 200);
  })

  .openapi(health, async (c) => {
    const { data, error } = await c.get("caller").db.rpc("outbox_health");
    throwOnDbError(error);
    const h = data as {
      by_status: Record<string, number>;
      oldest_queued_at: string | null;
      stalled_sending: number;
    };

    const mailer = Boolean(env.RESEND_API_KEY && env.MAIL_FROM);
    const queued = h.by_status.queued ?? 0;
    const warning = !mailer
      ? "No mail provider is configured, so nothing will ever be sent."
      : h.stalled_sending > 0
        ? `${h.stalled_sending} message(s) are stuck in 'sending' from a drainer that died.`
        : queued > 500
          ? `${queued} messages are queued; the drain is not keeping up.`
          : null;

    if (warning) c.get("log")?.warn({ warning }, "jobs.outbox_health");

    return c.json(
      {
        byStatus: h.by_status,
        oldestQueuedAt: h.oldest_queued_at,
        stalledSending: h.stalled_sending,
        mailerConfigured: mailer,
        warning,
      },
      200,
    );
  });
