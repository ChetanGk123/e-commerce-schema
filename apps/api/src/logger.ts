import { createMiddleware } from "hono/factory";
import { routePath } from "hono/route";
import { pino } from "pino";

import { env } from "./env";
import { recordRequest } from "./metrics";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "api" },
  // Human-readable in development, JSON everywhere else so a log shipper can
  // parse it. pino-pretty is a devDependency and is never required in prod.
  //
  // This branch is also why the container sets NODE_ENV=production and not
  // merely as a convention: the transport runs pino-pretty in a worker
  // thread, and a worker cannot resolve its target out of the single file
  // `bun build` emits. The bundled process dies at boot with
  // `DataCloneError: The object can not be cloned`, which names nothing
  // that would lead you here.
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
    const elapsed = performance.now() - start;
    const ms = Math.round(elapsed);
    const status = c.res.status;

    // The registered pattern, not the path: `/orders/:id`, so Prometheus
    // gets one series per route instead of one per order. Unmatched
    // requests come back as the catch-all middleware's own `/*`, which
    // would be a misleading label for a 404, so they are named as what
    // they are. The scrape itself is left out -- counting the observer
    // tells you nothing about the service.
    const matched = routePath(c);
    if (c.req.path !== "/metrics") {
      recordRequest(method, matched === "/*" ? "unmatched" : matched, status, elapsed / 1000);
    }

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
