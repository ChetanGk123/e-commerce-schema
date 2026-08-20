import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireAuth, requireStaff } from "../auth";
import { env } from "../env";
import { throwOnDbError } from "../errors";
import {
  REDRIVE_MAX_ATTEMPTS,
  drainOutbox,
  reconcileStorage,
  redriveWebhooks,
  surveyStorage,
} from "../jobs";
import { mailerConfigured } from "../mailer";
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
    /**
     * The webhook redrive rides along rather than getting its own
     * endpoint: a deployment with JOBS_INTERVAL_SECONDS=0 has one cron
     * entry pointed here, and a second endpoint it did not know to call
     * is a fix that never reaches the deployment that needs it most.
     */
    webhooks: z
      .object({
        claimed: z.number().int(),
        processed: z.number().int(),
        failed: z.number().int(),
        raced: z.number().int(),
      })
      .openapi("RedriveResult"),
  })
  .openapi("DrainResult");

const drain = createRoute({
  method: "post",
  path: "/jobs/drain",
  tags: ["jobs"],
  summary: "Run the queued background work now",
  description:
    "Drains the mail outbox and redrives webhook deliveries that were recorded but never applied. Requires the `X-Jobs-Secret` header to match JOBS_SECRET. Safe to call concurrently with the in-process loop: the mail claim uses FOR UPDATE SKIP LOCKED, so two drainers split the queue rather than sending the same message twice, and a webhook applied twice is refused by the database.\n\nWith no mail provider configured it claims no messages and says so, leaving every message queued. The redrive runs either way.",
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

/**
 * The queue nobody was watching.
 *
 * `unprocessed` shrinks on its own -- the redrive is trying those. What
 * needs a person is `exhausted`: deliveries that ran out of attempts, and
 * for a payment event that means money moved at the gateway and did not
 * move here.
 */
const webhookHealth = createRoute({
  method: "get",
  path: "/admin/webhooks",
  tags: ["admin", "jobs"],
  summary: "Deliveries that never finished",
  description:
    "`exhausted` should be zero. Each one is a callback the gateway sent, that we recorded, and that we could not apply after " +
    `${REDRIVE_MAX_ATTEMPTS} attempts` +
    " -- for `payment.captured` that is a customer who has been charged for an order this database still calls pending. The `error` on each row is the last reason it failed.\n\nUnprocessed-but-not-exhausted rows are still being retried and usually need nothing.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  responses: {
    200: {
      description: "Queue state",
      content: {
        "application/json": {
          schema: z.object({
            unprocessed: z.number().int(),
            exhausted: z.number().int(),
            maxAttempts: z.number().int(),
            oldestReceivedAt: z.string().nullable(),
            stuck: z.array(
              z.object({
                id: z.string(),
                provider: z.string(),
                eventType: z.string().nullable(),
                attempts: z.number().int(),
                receivedAt: z.string(),
                error: z.string().nullable(),
              }),
            ),
            warning: z.string().nullable(),
          }),
        },
      },
    },
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
  },
});

/**
 * The reconciler's report, and its trigger.
 *
 * Split because one is safe and the other is not. The report reads and
 * nothing else -- looking at it records no sighting, so refreshing the
 * page cannot hurry an object towards being collected. The pass is a
 * POST because it changes what the next pass will do, even with
 * `apply: false`.
 */
const SurveyShape = {
  bucketObjects: z.number().int(),
  referenced: z.number().int(),
  candidates: z.number().int(),
  orphans: z.array(z.string()),
  confirmed: z.array(z.string()),
  brokenReferences: z.array(z.string()),
  refused: z.string().nullable(),
};

const orphanReport = createRoute({
  method: "get",
  path: "/admin/storage/orphans",
  tags: ["admin", "jobs"],
  summary: "Objects in the bucket that nothing points at",
  description:
    "Reads only. Looking does not record a sighting, so this cannot be used to hurry an object towards collection.\n\n`orphans` is everything unreferenced and old enough to consider; `confirmed` is the subset that has already been unreferenced for GC_CONFIRM_DAYS and would be removed by the next applied pass.\n\n`brokenReferences` is the other direction and the more visible failure: rows pointing at objects that are not in the bucket, i.e. broken images on live product pages. Nothing here fixes those -- they are reported so somebody knows.\n\n`refused` non-null means a rail stopped the survey, and no number beside it should be trusted.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  responses: {
    200: {
      description: "What a pass would find",
      content: { "application/json": { schema: z.object(SurveyShape) } },
    },
    401: jsonError("Missing or invalid token"),
    403: jsonError("Authenticated, but not active staff"),
  },
});

const runGc = createRoute({
  method: "post",
  path: "/admin/storage/gc",
  tags: ["admin", "jobs"],
  summary: "Run a collection pass",
  description:
    "Records what looks unreferenced now, forgets anything that has stopped looking unreferenced, and -- with `apply: true` -- removes what has been unreferenced for GC_CONFIRM_DAYS.\n\n**There is no backup of the bucket.** Removal is permanent, which is why an object must be seen unreferenced twice a confirmation window apart, and why a set larger than GC_MAX_DELETE refuses the whole pass rather than doing the first hundred of it.\n\n`apply: false` still records sightings. It is a real pass, just one that removes nothing.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ apply: z.boolean().default(false) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "What the pass did",
      content: {
        "application/json": {
          schema: z.object({
            ...SurveyShape,
            collected: z.number().int(),
            applied: z.boolean(),
          }),
        },
      },
    },
    400: jsonError("Invalid body"),
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
    const limit = c.req.valid("query").limit;
    // Sequential on purpose. Both talk to the same database on the same
    // service key, and a drain that starves the redrive of connections
    // would be a strange way to fix a webhook that never got applied.
    const mail = await drainOutbox(limit);
    const webhooks = await redriveWebhooks();
    return c.json({ ...mail, webhooks }, 200);
  })

  .openapi(health, async (c) => {
    const { data, error } = await c.get("caller").db.rpc("outbox_health");
    throwOnDbError(error);
    const h = data as {
      by_status: Record<string, number>;
      oldest_queued_at: string | null;
      stalled_sending: number;
    };

    // The one the drain actually consults. This read RESEND_API_KEY
    // directly and so reported an SMTP deployment as having no provider
    // at all -- a false alarm that also swallowed the real ones, since
    // the ladder below stops at the first branch that matches.
    const mailer = mailerConfigured();
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
  })
  .openapi(webhookHealth, async (c) => {
    const db = c.get("caller").db;

    // Two queries rather than one: the exhausted count has to be exact
    // -- it is the number a person acts on -- and deriving it from a
    // capped sample would under-report it exactly when there are too
    // many to fit.
    const [listed, exhausted] = await Promise.all([
      db
        .from("webhook_events")
        .select("id, provider, event_type, attempts, received_at, error", { count: "exact" })
        .is("processed_at", null)
        .order("received_at", { ascending: true })
        .limit(20),
      db
        .from("webhook_events")
        .select("id", { count: "exact", head: true })
        .is("processed_at", null)
        .gte("attempts", REDRIVE_MAX_ATTEMPTS),
    ]);
    throwOnDbError(listed.error);
    throwOnDbError(exhausted.error);

    const rows = (listed.data ?? []) as unknown as {
      id: string;
      provider: string;
      event_type: string | null;
      attempts: number;
      received_at: string;
      error: string | null;
    }[];
    const unprocessed = listed.count ?? rows.length;
    const stale = exhausted.count ?? 0;

    const warning =
      stale > 0
        ? `${stale} delivery(ies) gave up after ${REDRIVE_MAX_ATTEMPTS} attempts. A payment event among them means a customer was charged for an order still marked pending -- this needs a person.`
        : unprocessed > 50
          ? `${unprocessed} deliveries are waiting on the redrive; it is not keeping up.`
          : null;

    if (warning) c.get("log")?.warn({ warning }, "jobs.webhook_health");

    return c.json(
      {
        unprocessed,
        exhausted: stale,
        maxAttempts: REDRIVE_MAX_ATTEMPTS,
        oldestReceivedAt: rows[0]?.received_at ?? null,
        stuck: rows.map((r) => ({
          id: r.id,
          provider: r.provider,
          eventType: r.event_type,
          attempts: r.attempts,
          receivedAt: r.received_at,
          error: r.error,
        })),
        warning,
      },
      200,
    );
  })

  .openapi(orphanReport, async (c) => {
    const found = await surveyStorage();
    c.get("log")?.info(
      { orphans: found.orphans.length, broken: found.brokenReferences.length },
      "storage.surveyed",
    );
    return c.json(found, 200);
  })

  .openapi(runGc, async (c) => {
    const { apply } = c.req.valid("json");
    const result = await reconcileStorage(apply);
    return c.json(result, 200);
  });
