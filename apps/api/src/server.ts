import { app } from "./app";
import { env } from "./env";
import { startJobs } from "./jobs";
import { logger } from "./logger";

logger.info({ port: env.PORT, env: env.NODE_ENV }, "api listening");

export default {
  port: env.PORT,
  fetch: app.fetch,
};

// Started here rather than in app.ts: a test that imports the app must
// not begin draining the real outbox as a side effect of the import.
void startJobs();
