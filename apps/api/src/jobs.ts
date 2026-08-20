import { env } from "./env";
import { publishOps } from "./metrics";
import { logger as log } from "./logger";
import { type Message, mailerConfigured, send } from "./mailer";
import { type RazorpayEvent, processEvent } from "./routes/webhooks";
import { deleteObject, listObjects, pathFromUrl, storageConfigured } from "./storage";
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
    // Not housekeeping: auth_attempts grows with an attacker's word
    // list, so under a spray this is what keeps the defence from
    // becoming the resource exhaustion.
    "sweep_auth_attempts",
  ]) {
    const { data, error } = await db.rpc(fn);
    if (error) log.error({ err: error.message, fn }, "jobs.sweeper_failed");
    else if ((data as unknown as number) > 0) log.info({ fn, rows: data }, "jobs.swept");
  }
}

/**
 * Collecting images nothing points at (docs/image-management.md T2).
 *
 * The queue is filled by a trigger, because the removal it reacts to
 * happens in the database and the API never sees it -- a cascade from a
 * deleted product takes twelve image rows with it and no handler runs.
 * See migration 0029.
 *
 * Failures are not loud here. An object that will not go costs a
 * fraction of a cent and stays in the queue with its error; T4 is what
 * turns a backlog into an alert. What must not happen is the queue
 * quietly emptying itself on failure, which is why settle only drops the
 * row once the object is actually gone.
 */
const GC_GIVE_UP = 20;

async function sweepStorage(): Promise<void> {
  // No bucket configured means nothing to collect, and every claimed row
  // would fail against a URL this deployment cannot resolve.
  if (!storageConfigured()) return;

  const db = serviceClient();
  const claimed = await db.rpc("claim_storage_gc", {
    p_limit: 50,
    p_give_up: GC_GIVE_UP,
  });
  if (claimed.error) {
    log.error({ err: claimed.error.message }, "jobs.storage_claim_failed");
    return;
  }

  const rows = (claimed.data ?? []) as { id: string; url: string; attempts: number }[];
  if (rows.length === 0) return;

  const settle = (id: string, gone: boolean, error: string | null) =>
    db.rpc("settle_storage_gc", { p_id: id, p_gone: gone, p_error: error });

  let collected = 0;
  let failed = 0;

  for (const row of rows) {
    const path = pathFromUrl(row.url);

    // Not one of ours -- an image added by hand pointing at another
    // host, or one left over from a migration. There is nothing to
    // collect, and keeping the row would retry twenty times against a
    // URL we were never entitled to touch.
    if (!path) {
      await settle(row.id, true, null);
      continue;
    }

    try {
      const res = await deleteObject(path);
      await settle(row.id, res.gone, res.gone ? null : res.detail);
      if (res.gone) collected += 1;
      else failed += 1;
    } catch (err) {
      // deleteObject throws when storage is unreachable at all. That is
      // a whole-batch condition rather than a bad row, but it is settled
      // per row so the reason lands somewhere readable.
      await settle(row.id, false, (err as Error).message);
      failed += 1;
    }
  }

  if (collected > 0) log.info({ collected }, "jobs.storage_collected");
  if (failed > 0) log.warn({ failed }, "jobs.storage_collect_failed");
}

/**
 * The reconciler (docs/image-management.md T7).
 *
 * The sweeper above collects objects whose rows were removed. This finds
 * the ones no row ever recorded -- a crash between upload and insert, a
 * multipart upload storage never finalised -- by listing the bucket and
 * subtracting what the database still points at.
 *
 * It is also the only thing here capable of deleting every photograph in
 * the store, running unattended against a bucket with no backup. Six
 * rails, and the tests for them matter more than this code does.
 */
export interface StorageSurvey {
  bucketObjects: number;
  referenced: number;
  /** Old enough to be considered at all -- rail 2. */
  candidates: number;
  /** Unreferenced, before the confirmation window is applied. */
  orphans: string[];
  /** Rows pointing at objects that are not in the bucket: broken images. */
  brokenReferences: string[];
  /** Non-null when a rail refused the pass. Nothing is removed. */
  refused: string | null;
}

async function survey(db: ReturnType<typeof serviceClient>): Promise<StorageSurvey> {
  const empty = (refused: string): StorageSurvey => ({
    bucketObjects: 0,
    referenced: 0,
    candidates: 0,
    orphans: [],
    brokenReferences: [],
    refused,
  });

  const refs = await db.rpc("referenced_objects");
  if (refs.error) return empty(`reference query failed: ${refs.error.message}`);

  const urls = ((refs.data ?? []) as { url: string }[]).map((r) => r.url);

  // RAIL 4. Zero references is a broken query, not an empty catalog --
  // and it is the single input that would mark every object in the
  // bucket collectable. Refusing here is why the rest can be trusted.
  if (urls.length === 0) {
    return empty("referenced_objects() returned nothing, which is a broken query, not an empty catalog");
  }

  const referencedPaths = new Set(
    urls.map((u) => pathFromUrl(u)).filter((p): p is string => p !== null),
  );

  const objects = await listObjects();
  const inBucket = new Set(objects.map((o) => o.path));

  // RAIL 2. An object uploaded seconds ago may not have a committed row
  // yet. Considering it would mean racing the request that created it.
  const cutoff = Date.now() - env.GC_MIN_AGE_HOURS * 3_600_000;
  const candidates = objects.filter(
    (o) => !o.createdAt || Date.parse(o.createdAt) < cutoff,
  );

  return {
    bucketObjects: objects.length,
    referenced: referencedPaths.size,
    candidates: candidates.length,
    orphans: candidates.filter((o) => !referencedPaths.has(o.path)).map((o) => o.path),
    // Reported, never acted on. A row pointing at a missing object is a
    // broken image on a live page -- more visible than an orphan and not
    // fixable by deleting anything.
    brokenReferences: [...referencedPaths].filter((p) => !inBucket.has(p)),
    refused: null,
  };
}

/** The report. Reads only -- no sighting is recorded by looking. */
export async function surveyStorage(): Promise<StorageSurvey & { confirmed: string[] }> {
  if (!storageConfigured()) {
    return {
      bucketObjects: 0,
      referenced: 0,
      candidates: 0,
      orphans: [],
      brokenReferences: [],
      refused: "no bucket configured",
      confirmed: [],
    };
  }
  const db = serviceClient();
  const found = await survey(db);
  const seen = await db
    .from("storage_orphan_sightings")
    .select("path")
    .lt("first_seen_at", new Date(Date.now() - env.GC_CONFIRM_DAYS * 86_400_000).toISOString());

  return {
    ...found,
    confirmed: ((seen.data ?? []) as { path: string }[]).map((s) => s.path),
  };
}

/**
 * One pass. Records what it sees; removes only what has been seen before.
 */
export async function reconcileStorage(
  apply: boolean,
  /**
   * Overrides for the two rails whose defaults are measured in days and
   * hundreds. Not a feature -- a rail that cannot be exercised is a rail
   * somebody deletes as dead code, and these two are exactly the ones
   * that would otherwise need a week and a real catalog to trip.
   * Production passes nothing.
   */
  opts: { maxDelete?: number; confirmDays?: number } = {},
): Promise<StorageSurvey & { confirmed: string[]; collected: number; applied: boolean }> {
  const maxDelete = opts.maxDelete ?? env.GC_MAX_DELETE;
  const confirmDays = opts.confirmDays ?? env.GC_CONFIRM_DAYS;
  const nothing = (s: StorageSurvey) => ({ ...s, confirmed: [], collected: 0, applied: false });

  if (!storageConfigured()) {
    return nothing({
      bucketObjects: 0,
      referenced: 0,
      candidates: 0,
      orphans: [],
      brokenReferences: [],
      refused: "no bucket configured",
    });
  }

  const db = serviceClient();
  const found = await survey(db);
  if (found.refused) {
    log.error({ refused: found.refused }, "ops.storage_reconcile_refused");
    await alert(
      db,
      "ops_storage_reconcile_refused",
      "Image collection refused to run",
      `The pass was abandoned and nothing was removed: ${found.refused}. That is the safe outcome, but it means orphaned images are accumulating until it is fixed.`,
      { refused: found.refused },
    );
    return nothing(found);
  }

  // RAIL 1. Record this pass and get back only what was already looking
  // orphaned a confirmation window ago. Anything this pass did NOT see
  // is forgotten inside the same statement, so a path that came back
  // starts its week again.
  const sighted = await db.rpc("record_orphan_sightings", {
    p_paths: found.orphans,
    p_confirm: `${confirmDays} days`,
  });
  if (sighted.error) {
    log.error({ err: sighted.error.message }, "jobs.storage_sightings_failed");
    return nothing({ ...found, refused: `sightings failed: ${sighted.error.message}` });
  }
  const confirmed = ((sighted.data ?? []) as { path: string }[]).map((s) => s.path);

  // RAIL 3. Refuse the whole pass, not the first hundred of it. A set
  // this large means the reference query is wrong in a way rail 4 did
  // not catch, and collecting "only" a hundred photographs is not a
  // safer version of that.
  if (confirmed.length > maxDelete) {
    const refused = `${confirmed.length} objects confirmed, above GC_MAX_DELETE of ${maxDelete}`;
    log.error({ confirmed: confirmed.length }, "ops.storage_reconcile_refused");
    await alert(
      db,
      "ops_storage_reconcile_refused",
      "Image collection refused: too many at once",
      `${refused}. Nothing was removed. This is what a broken reference query looks like from here -- check referenced_objects() before raising the limit.`,
      { confirmed: confirmed.length, cap: maxDelete },
    );
    return { ...found, confirmed, collected: 0, applied: false, refused };
  }

  if (!apply || confirmed.length === 0) {
    return { ...found, confirmed, collected: 0, applied: false };
  }

  // RAIL 5. Every path, before anything happens to it. With no bucket
  // backup this log line is the only record the object ever existed.
  log.info({ paths: confirmed }, "storage.collecting");

  const removed: string[] = [];
  for (const path of confirmed) {
    try {
      if ((await deleteObject(path)).gone) removed.push(path);
    } catch (err) {
      log.warn({ path, err: (err as Error).message }, "storage.collect_failed");
    }
  }

  // Only what actually went. A failed one keeps its sighting and its
  // original first_seen_at, so it is retried next pass rather than
  // starting its week over.
  if (removed.length > 0) {
    await db.rpc("forget_orphan_sightings", { p_paths: removed });
    log.warn({ collected: removed.length }, "ops.storage_reconciled");
    await alert(
      db,
      "ops_storage_reconciled",
      "Unreferenced images were removed",
      `${removed.length} object(s) that nothing has pointed at for ${confirmDays} days were removed from the bucket. There is no backup, so this is permanent; the paths are in the logs under storage.collecting.`,
      { collected: removed.length },
    );
  }

  return { ...found, confirmed, collected: removed.length, applied: true };
}

/**
 * How often the reconciler runs (T8).
 *
 * Paired with GC_CONFIRM_DAYS on purpose: at seven and seven, an object
 * first seen unreferenced on one pass is collectable by the next. Set
 * the confirmation window longer and it simply takes more passes, which
 * is the safe direction to be wrong in.
 */
const RECONCILE_EVERY = "7 days";

/**
 * Runs a pass if one is due, and removes what it finds (decision 1,
 * 2026-08-20: unattended).
 *
 * The claim is atomic because the alternative is every container
 * starting the weekly pass in the same second, each listing the whole
 * bucket and racing the rest to delete the same objects.
 */
export async function maybeReconcile(): Promise<{ ran: boolean; collected: number }> {
  if (!storageConfigured()) return { ran: false, collected: 0 };

  const db = serviceClient();
  const claim = await db.rpc("claim_job_run", {
    p_job: "storage_reconcile",
    p_every: RECONCILE_EVERY,
  });
  if (claim.error) {
    log.error({ err: claim.error.message }, "jobs.reconcile_claim_failed");
    return { ran: false, collected: 0 };
  }
  if (claim.data !== true) return { ran: false, collected: 0 };

  const result = await reconcileStorage(true);
  return { ran: true, collected: result.collected };
}

/**
 * The two silent failures, said out loud.
 *
 * /admin/outbox and /admin/webhooks compute exactly what is wrong and
 * both wait to be asked. A mail queue that stopped draining and a
 * payment callback that could not be applied are the failures here that
 * are silent, unbounded and expensive -- the first means every order
 * confirmation since is unsent, the second means a customer paid and
 * this database still calls their order pending.
 *
 * So the tick checks them and tells somebody. raise_ops_alert() writes
 * one notification per active owner and admin, with a cooldown, so a
 * condition that persists does not become the outage itself.
 *
 * These also log at error level with stable messages -- ops.outbox_stalled
 * and ops.webhooks_exhausted -- which is the hook for a log shipper that
 * can actually page someone. The notification is where staff already
 * look; the log line is where an alert rule belongs.
 */
async function checkOps(): Promise<void> {
  const db = serviceClient();

  // Collected as we go and published once at the end, so GET /metrics
  // costs a scraper nothing: these are the same numbers the alerts below
  // are decided from, which is the point -- a dashboard disagreeing with
  // the alert that woke you is worse than no dashboard.
  const snapshot = {
    outbox: {} as Record<string, number>,
    outboxStalled: 0,
    webhooksUnprocessed: 0,
    webhooksExhausted: 0,
    authLockouts: 0,
    storageGcQueued: 0,
    storageGcStalled: 0,
  };

  const outbox = await db.rpc("outbox_health");
  if (outbox.error) {
    log.error({ err: outbox.error.message }, "jobs.ops_check_failed");
  } else {
    const h = outbox.data as {
      by_status: Record<string, number>;
      oldest_queued_at: string | null;
      stalled_sending: number;
    };
    const queued = h.by_status?.queued ?? 0;
    snapshot.outbox = h.by_status ?? {};
    snapshot.outboxStalled = h.stalled_sending;

    if (h.stalled_sending > 0) {
      log.error({ stalled: h.stalled_sending }, "ops.outbox_stalled");
      await alert(
        db,
        "ops_outbox_stalled",
        "Mail is stuck part-sent",
        `${h.stalled_sending} message(s) have been claimed by a drainer that never finished. They are rescued automatically after ten minutes; if this keeps recurring the process is dying mid-send.`,
        { stalled: h.stalled_sending },
      );
    } else if (queued > 500 && mailerConfigured()) {
      log.error({ queued }, "ops.outbox_backlog");
      await alert(
        db,
        "ops_outbox_backlog",
        "The mail queue is not draining",
        `${queued} messages are waiting. Order confirmations are among them.`,
        { queued, oldest: h.oldest_queued_at },
      );
    } else if (queued > 0 && !mailerConfigured()) {
      // Not an error: a store whose mail is not wired up yet is a
      // deliberate state. It is worth saying once, because the symptom
      // -- no confirmation emails -- looks like a bug from outside.
      log.warn({ queued }, "ops.mailer_absent");
      await alert(
        db,
        "ops_mailer_absent",
        "No mail provider is configured",
        `${queued} message(s) are queued and nothing will send them until MAIL_PROVIDER and its credentials are set.`,
        { queued },
      );
    }
  }

  // Deliveries that ran out of retries. For a payment event that means
  // the gateway took money this database never recorded.
  const exhausted = await db
    .from("webhook_events")
    .select("id", { count: "exact", head: true })
    .is("processed_at", null)
    .gte("attempts", REDRIVE_MAX_ATTEMPTS);

  if (exhausted.error) {
    log.error({ err: exhausted.error.message }, "jobs.ops_check_failed");
    return;
  }
  const stuck = exhausted.count ?? 0;
  snapshot.webhooksExhausted = stuck;
  if (stuck > 0) {
    log.error({ stuck }, "ops.webhooks_exhausted");
    await alert(
      db,
      "ops_webhooks_exhausted",
      "A payment callback could not be applied",
      `${stuck} delivery(ies) gave up after ${REDRIVE_MAX_ATTEMPTS} attempts. If any is a capture, a customer has been charged for an order still marked pending. See GET /admin/webhooks.`,
      { stuck },
    );
  }

  // Several accounts locked at once is not several people forgetting
  // their passwords. The lockout stops the attack; this is the half that
  // makes it visible, which is what the audit actually complained about.
  const locked = await db
    .from("auth_attempts")
    .select("email", { count: "exact", head: true })
    .gt("locked_until", new Date().toISOString());

  if (locked.error) {
    log.error({ err: locked.error.message }, "jobs.ops_check_failed");
    return;
  }
  const accounts = locked.count ?? 0;
  snapshot.authLockouts = accounts;
  if (accounts >= STUFFING_ACCOUNTS) {
    log.error({ accounts }, "ops.credential_stuffing");
    await alert(
      db,
      "ops_credential_stuffing",
      "Several accounts are locked out at once",
      `${accounts} accounts hit the sign-in lockout. One person forgets their password; this many at once is a credential list being replayed. The accounts are in auth_attempts. Nothing is breached -- the lockout held -- but any customer among them cannot sign in for fifteen minutes and may call about it.`,
      { accounts },
    );
  }

  // Images nobody points at any more. Depth on its own is not a
  // problem -- a queue that is working has depth -- so the alert is on
  // the rows that ran out of attempts, which is a queue that has stopped
  // and objects being billed for indefinitely.
  const gcQueued = await db
    .from("storage_gc_queue")
    .select("id", { count: "exact", head: true });
  const gcStalled = await db
    .from("storage_gc_queue")
    .select("id", { count: "exact", head: true })
    .gte("attempts", GC_GIVE_UP);

  if (gcQueued.error || gcStalled.error) {
    log.error(
      { err: (gcQueued.error ?? gcStalled.error)?.message },
      "jobs.ops_check_failed",
    );
    return;
  }
  snapshot.storageGcQueued = gcQueued.count ?? 0;
  snapshot.storageGcStalled = gcStalled.count ?? 0;

  if (snapshot.storageGcStalled > 0) {
    log.error({ stalled: snapshot.storageGcStalled }, "ops.storage_gc_stalled");
    await alert(
      db,
      "ops_storage_gc_stalled",
      "Images cannot be removed from storage",
      `${snapshot.storageGcStalled} object(s) gave up after ${GC_GIVE_UP} attempts. Each one is a file nothing displays and the bucket still bills for. The rows are in storage_gc_queue with the reason in last_error -- usually credentials or a bucket that no longer exists.`,
      { stalled: snapshot.storageGcStalled },
    );
  }

  // Only on the way out, and only if every query above succeeded. A
  // partial snapshot would publish real outbox numbers next to a zero
  // for a webhook count that failed to load, and a zero on
  // ecom_webhooks_exhausted is the one reading nobody double-checks.
  // Skipping it instead leaves the last good values in place with
  // ecom_ops_snapshot_age_seconds climbing, which says what happened.
  publishOps(snapshot);
}

/**
 * How many simultaneous lockouts stop looking like a bad morning.
 *
 * Low on purpose. The cost of being wrong is one notification; the cost
 * of setting it where only an obvious attack trips it is finding out
 * from a customer.
 */
const STUFFING_ACCOUNTS = 5;

async function alert(
  db: ReturnType<typeof serviceClient>,
  kind: string,
  title: string,
  body: string,
  data: Record<string, unknown>,
): Promise<void> {
  const { data: told, error } = await db.rpc("raise_ops_alert", {
    p_kind: kind,
    p_title: title,
    p_body: body,
    p_data: data,
  });
  if (error) {
    log.error({ err: error.message, kind }, "jobs.alert_failed");
    return;
  }
  if ((told as unknown as number) > 0) {
    log.warn({ kind, recipients: told }, "ops.alert_raised");
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
      // Always, cron or not: these make HTTP calls to storage, which
      // pg_cron cannot do however the retention jobs are scheduled.
      await sweepStorage();
      // Claims its own cadence, so calling it every tick is correct and
      // cheap -- it answers "not due" in one round trip.
      await maybeReconcile();
      // Last, so it reports on the state the pass above just left.
      await checkOps();
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
