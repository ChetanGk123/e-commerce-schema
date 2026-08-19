import { createMiddleware } from "hono/factory";
import { pino } from "pino";

import { env } from "./env";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "api" },
  // Human-readable in development, JSON everywhere else so a log shipper can
  // parse it. pino-pretty is a devDependency and is never required in prod.
  ...(env.NODE_ENV === "development"
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname,service",
            messageFormat: "{msg} {reqId}",
          },
        },
      }
    : {}),
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

  const { method, path } = c.req;
  log.info({ method, path }, "--> request");

  const start = performance.now();
  try {
    await next();
  } finally {
    const ms = Math.round(performance.now() - start);
    const status = c.res.status;

    // Start and finish are separate lines on purpose: a request that hangs or
    // crashes the process still leaves the "-->" behind, so you can see what
    // was in flight. A single completion line shows nothing at all.
    // `finally` is what guarantees the pair even when a route throws.
    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    log[level](
      { method, path, status, ms, userId: c.get("caller")?.userId },
      `<-- ${method} ${path} ${status} ${ms}ms`,
    );
  }
});
