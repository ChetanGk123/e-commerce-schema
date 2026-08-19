import { env } from "./env";
import { logger as log } from "./logger";
import { type Message, mailerConfigured, send } from "./mailer";
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
