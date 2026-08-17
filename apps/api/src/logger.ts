import { createMiddleware } from "hono/factory";
import { pino } from "pino";

import { env } from "./env";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "api" },
});

declare module "hono" {
  interface ContextVariableMap {
    reqId: string;
    log: typeof logger;
  }
}

/**
 * Request logging with a correlation id.
 *
 * Deliberately logs method, path, status and duration only. No headers, no
 * bodies, no query values -- an Authorization header, a gift-card code or a
 * customer's phone number in a log line outlives the request and lands in
 * every backup of the log store.
 */
export const requestLogger = createMiddleware(async (c, next) => {
  const reqId = c.req.header("x-request-id") ?? crypto.randomUUID();
  const log = logger.child({ reqId });

  c.set("reqId", reqId);
  c.set("log", log);
  c.header("x-request-id", reqId);

  const start = performance.now();
  await next();
  const ms = Math.round(performance.now() - start);

  log.info(
    { method: c.req.method, path: c.req.path, status: c.res.status, ms },
    "request",
  );
});
