import { app } from "./app";
import { env } from "./env";
import { logger } from "./logger";

logger.info({ port: env.PORT, env: env.NODE_ENV }, "api listening");

export default {
  port: env.PORT,
  fetch: app.fetch,
};
