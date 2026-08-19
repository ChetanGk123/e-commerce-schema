import { app } from "./app";
import { env } from "./env";
import { startJobs, stopJobs } from "./jobs";
import { logger } from "./logger";
import { beginShutdown } from "./routes/health";

const server = Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
});

logger.info({ port: server.port, env: env.NODE_ENV }, "api listening");

// Started here rather than in app.ts: a test that imports the app must
// not begin draining the real outbox as a side effect of the import.
void startJobs();

/**
 * How long to keep serving after being told to stop.
 *
 * Whatever routes traffic here finds out this instance is going away by
 * watching /health/ready, and it does not watch continuously -- there is
 * a poll interval between the flip and the last request it sends. Closing
 * the socket before that window passes turns an orderly drain into
 * connection errors for real customers, which is the failure this whole
 * handler exists to avoid. Five seconds covers a typical two-second probe
 * interval twice over.
 */
const DRAIN_GRACE_MS = 5_000;

/**
 * And how long to wait for what is already in flight.
 *
 * REQUEST_TIMEOUT_MS is the ceiling on one request, so this has to exceed
 * it or a checkout that was going to succeed gets killed at the very end.
 * Orchestrators typically SIGKILL ten seconds after that, which is the
 * real budget being spent here.
 */
const DRAIN_LIMIT_MS = env.REQUEST_TIMEOUT_MS + DRAIN_GRACE_MS;

let stopping = false;

/**
 * Stop in an order that does not lose anything.
 *
 * Without this, a redeploy killed whatever was in flight: a checkout
 * mid-transaction, a drain mid-send. The database survives both -- an
 * uncommitted transaction rolls back and requeue_stalled_messages()
 * rescues a claimed message ten minutes later -- but the customer sees a
 * failed request for an order that may or may not exist, which is the
 * worst answer available.
 */
async function shutdown(signal: string): Promise<void> {
  // A second Ctrl-C, or SIGTERM followed by SIGINT, must not restart the
  // sequence half way through.
  if (stopping) {
    logger.warn({ signal }, "shutdown.already_in_progress");
    return;
  }
  stopping = true;

  logger.info({ signal }, "shutdown.begin");

  // 1. Fail readiness, so nothing new is routed here. Liveness stays green
  //    on purpose -- failing it now would have the orchestrator kill this
  //    process mid-drain.
  beginShutdown();

  // 2. Stop scheduling background work. A drain already running is left to
  //    finish; the outbox is built to survive losing one either way.
  stopJobs();

  // 3. Keep serving while the news travels.
  await Bun.sleep(DRAIN_GRACE_MS);

  // 4. Refuse new connections and wait for in-flight ones. Without the
  //    argument Bun waits rather than cutting them off, which is the whole
  //    point; the race is the backstop for a request that never ends.
  const drained = await Promise.race([
    server.stop().then(() => true),
    Bun.sleep(DRAIN_LIMIT_MS).then(() => false),
  ]);

  if (!drained) {
    logger.warn({ limitMs: DRAIN_LIMIT_MS }, "shutdown.drain_timed_out");
    await server.stop(true);
  }

  logger.info({ signal, drained }, "shutdown.done");
  process.exit(0);
}

// SIGTERM is what an orchestrator sends on a redeploy; SIGINT is Ctrl-C.
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
