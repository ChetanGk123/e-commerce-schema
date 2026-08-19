import { env } from "./env";
import { logger as log } from "./logger";
import { type Message, mailerConfigured, send } from "./mailer";
import { type RazorpayEvent, processEvent } from "./routes/webhooks";
import { serviceClient } from "./supabase";

/**
 * The scheduled work the API does for itself.
 *
 * Two jobs, and they are here for different reasons.
 *
 * THE OUTBOX DRAIN has to live in the API: pg_cron cannot make an HTTP
 * call to a mail provider. Every order confirmation checkout() has ever
 * queued waits on this.
 *
 * THE SWEEPER FALLBACK does not, and should not, if pg_cron is running
 * them. It exists because api-plan B11 asked for it, and its trade-off
 * is worth stating plainly: sweepers that live in the API stop when the
 * API stops, which is exactly what choosing pg_cron was meant to avoid.
 * So it is checked once at boot and stays off when pg_cron has the job.
 */
interface DrainResult {
  claimed: number;
  sent: number;
  requeued: number;
  failed: number;
  skipped?: string;
}

/**
 * One pass. Claim a batch, send each, record each outcome.
 *
 * Nothing is claimed when there is no provider. Claiming would move the
 * rows to 'sending' and burn an attempt against a send that was never
 * going to happen -- five passes later they would be 'failed', for the
 * crime of the store not having wired up mail yet.
 */
export async function drainOutbox(limit = 20): Promise<DrainResult> {
  if (!mailerConfigured()) {
    return { claimed: 0, sent: 0, requeued: 0, failed: 0, skipped: "mailer not configured" };
  }

  const db = serviceClient();

  // Anything a previous drainer left in 'sending' comes back first --
  // otherwise it is invisible to the claim below forever.
  const rescued = await db.rpc("requeue_stalled_messages", {
    p_older_than: "10 minutes",
  });
  if (rescued.error) {
    log.error({ err: rescued.error.message }, "jobs.requeue_failed");
  } else if ((rescued.data as unknown as number) > 0) {
    log.warn({ count: rescued.data }, "jobs.requeued_stalled");
  }

  const claimed = await db.rpc("claim_outbox", { p_limit: limit });
  if (claimed.error) {
    log.error({ err: claimed.error.message }, "jobs.claim_failed");
    return { claimed: 0, sent: 0, requeued: 0, failed: 0, skipped: "claim failed" };
  }

  const batch = (claimed.data ?? []) as unknown as Message[];
  const result: DrainResult = { claimed: batch.length, sent: 0, requeued: 0, failed: 0 };

  for (const m of batch) {
    const outcome = await send(m);

    const settled = await db.rpc("settle_message", {
      p_id: m.id,
      p_sent: outcome.sent,
      p_provider: outcome.sent ? "resend" : null,
      p_provider_ref: outcome.providerRef ?? null,
      p_error: outcome.error ?? null,
    });

    if (settled.error) {
      // The row stays 'sending' and requeue_stalled_messages() will
      // rescue it. Losing the settle is survivable; losing the message
      // would not be.
      log.error({ err: settled.error.message, messageId: m.id }, "jobs.settle_failed");
      continue;
    }

    const status = settled.data as unknown as string;
    if (status === "sent") result.sent += 1;
    else if (status === "failed") result.failed += 1;
    else result.requeued += 1;
  }

  if (result.claimed > 0) log.info(result, "jobs.drained");
  return result;
}

/**
 * Deliveries that were recorded but never applied.
 *
 * routes/webhooks.ts answers 200 to a delivery whose processing failed,
 * and it is right to: the delivery is safely in webhook_events either
 * way, and making Razorpay retry for days does not fix a capture that
 * broke on our side. That is only a sound trade if something comes back
 * for those rows afterwards. Nothing did. This is it.
 *
 * Without this, a `payment.captured` that failed on a transient database
 * error leaves the customer charged and the order unpaid, permanently,
 * with the reason sitting in a column nobody reads.
 *
 * `processed_at is null` is already the queue -- mark_webhook_processed
 * leaves it null when handed an error, and idx_webhook_unprocessed
 * indexes exactly that predicate. There was nothing to add to the schema.
 *
 * NO LOCK, deliberately. Two instances redriving one row both reach
 * capture_payment, which refuses a repeat three separate ways: a
 * non-pending order changes nothing, uniq_payment_provider_ref rejects
 * the second payment row, and the reservation index rejects a double
 * release. A lock here would buy nothing the database does not already
 * guarantee, and would be one more thing to hold during an outage.
 */
interface RedriveResult {
  /** Rows picked up this pass. */
  claimed: number;
  processed: number;
  failed: number;
  /** Finished by someone else between the select and the claim. */
  raced: number;
}

/**
 * When to stop trying and start telling a person.
 *
 * `attempts` counts tries, not deliveries -- record_webhook increments it
 * whether the caller is Razorpay redelivering or this job retrying, so a
 * gateway that gives up early does not leave us retrying forever, and an
 * outage that stops us from trying at all does not burn the budget.
 *
 * At a 60-second tick, twenty attempts means a genuinely broken delivery
 * goes quiet within twenty minutes and shows up in GET /admin/webhooks
 * instead. The failures worth retrying (a deadlock, a blip, a restart)
 * resolve in the first two.
 */
export const REDRIVE_MAX_ATTEMPTS = 20;

export async function redriveWebhooks(limit = 10): Promise<RedriveResult> {
  const db = serviceClient();
  const result: RedriveResult = { claimed: 0, processed: 0, failed: 0, raced: 0 };

  const { data, error } = await db
    .from("webhook_events")
    .select("id, provider, event_id, event_type, payload, attempts")
    // Unverified deliveries are never recorded in the first place. The
    // filter is here so that stays true if another provider ever records
    // one: replaying an unauthenticated payload is how a forged capture
    // gets in through the back door.
    .eq("signature_verified", true)
    // processEvent understands Razorpay. Courier and messaging callbacks
    // (api-plan B6) would otherwise be picked up and "retried" into a
    // no-op twenty times each.
    .eq("provider", "razorpay")
    .is("processed_at", null)
    .lt("attempts", REDRIVE_MAX_ATTEMPTS)
    .order("received_at", { ascending: true })
    .limit(limit);

  if (error) {
    log.error({ err: error.message }, "jobs.redrive_select_failed");
    return result;
  }

  const rows = (data ?? []) as unknown as {
    id: string;
    provider: string;
    event_id: string;
    event_type: string | null;
    payload: RazorpayEvent;
    attempts: number;
  }[];
  result.claimed = rows.length;

  for (const row of rows) {
    // Re-recording is what counts the attempt: same insert, same ON
    // CONFLICT bump, and it answers whether a concurrent delivery from
    // Razorpay finished the row while this pass was reading it.
    const claim = await db.rpc("record_webhook", {
      p_provider: row.provider,
      p_event_id: row.event_id,
      p_event_type: row.event_type,
      p_payload: row.payload,
      p_verified: true,
    });
    if (claim.error) {
      log.error({ err: claim.error.message, id: row.id }, "jobs.redrive_claim_failed");
      continue;
    }
    if ((claim.data as unknown as { already_processed: boolean }[])[0]?.already_processed) {
      result.raced += 1;
      continue;
    }

    const event = row.payload;
    try {
      await processEvent(db, event, event.payload?.payment?.entity);
      const done = await db.rpc("mark_webhook_processed", { p_id: row.id });
      if (done.error) throw new Error(done.error.message);
      result.processed += 1;
      log.info(
        { id: row.id, type: event.event, attempts: row.attempts + 1 },
        "jobs.redrive_processed",
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      result.failed += 1;
      // One attempt short of the cap is the last thing anyone will hear
      // about this row from the log, so say so there rather than leaving
      // the silence to be discovered.
      const exhausted = row.attempts + 1 >= REDRIVE_MAX_ATTEMPTS;
      log[exhausted ? "error" : "warn"](
        { id: row.id, type: event.event, attempts: row.attempts + 1, err: detail, exhausted },
        exhausted ? "jobs.redrive_exhausted" : "jobs.redrive_failed",
      );
      await db.rpc("mark_webhook_processed", { p_id: row.id, p_error: detail });
    }
  }

  if (result.claimed > 0) log.info(result, "jobs.redrove");
  return result;
}

/**
 * Are the database sweepers already being run by something that outlives
 * this process? Asked once, at boot.
 */
async function pgCronOwnsTheSweepers(): Promise<boolean> {
  const { data, error } = await serviceClient().rpc("inventory_health");
  if (error) {
    log.warn({ err: error.message }, "jobs.sweeper_check_failed");
    return true; // assume yes: running them twice is worse than not at all
  }
  return Boolean((data as { sweeper_scheduled?: boolean })?.sweeper_scheduled);
}

/** The pg_cron fallback, for a deployment where the extension is absent. */
async function runSweepers(): Promise<void> {
  const db = serviceClient();
  for (const fn of [
    "release_expired_reservations",
    "sweep_idempotency_keys",
  ]) {
    const { data, error } = await db.rpc(fn);
    if (error) log.error({ err: error.message, fn }, "jobs.sweeper_failed");
    else if ((data as unknown as number) > 0) log.info({ fn, rows: data }, "jobs.swept");
  }
}

let timer: ReturnType<typeof setInterval> | undefined;

/**
 * Starts the loop. Called from server.ts, never from app.ts -- a test
 * that imports the app must not start draining the real outbox.
 */
export async function startJobs(): Promise<void> {
  if (env.JOBS_INTERVAL_SECONDS === 0) {
    log.info("jobs.disabled");
    return;
  }

  const cronOwns = await pgCronOwnsTheSweepers();
  log.info(
    {
      everySeconds: env.JOBS_INTERVAL_SECONDS,
      mailer: mailerConfigured() ? "configured" : "absent",
      sweepers: cronOwns ? "pg_cron" : "in-process fallback",
    },
    "jobs.started",
  );

  const tick = async () => {
    try {
      await drainOutbox();
      await redriveWebhooks();
      if (!cronOwns) await runSweepers();
    } catch (err) {
      // A throwing tick must not kill the interval, or the outbox stops
      // draining and nothing says why.
      log.error({ err }, "jobs.tick_failed");
    }
  };

  timer = setInterval(tick, env.JOBS_INTERVAL_SECONDS * 1000);
  // Do not hold the process open for the sake of the timer.
  timer.unref?.();
  void tick();
}

export function stopJobs(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
