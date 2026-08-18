import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { type DbError, mapDatabaseError } from "./errors";
import { requestLogger } from "./logger";
import { validationHook } from "./schemas";
import { adminCatalogRoute } from "./routes/admin-catalog";
import { catalogRoute } from "./routes/catalog";
import { healthRoute } from "./routes/health";
import { meRoute } from "./routes/me";
import { shippingRoute } from "./routes/shipping";

/**
 * The app is built here and served in server.ts. Keeping them apart means
 * importing AppType (for hc) or calling app.request() in a test does not bind
 * a port as a side effect of the import.
 */
export const app = new OpenAPIHono({ defaultHook: validationHook });

app.use("*", requestLogger);

// Every route mounts here. The chained .route() calls are what extend
// AppType, so hc<AppType> in the front ends knows about each one.
const routes = app
  .route("/", healthRoute)
  .route("/", meRoute)
  .route("/", catalogRoute)
  .route("/", adminCatalogRoute)
  .route("/", shippingRoute);

app.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "E-commerce API",
    version: "0.0.0",
    description:
      "Shared backend for the admin console and storefront. Request schemas come from @ecom/schema, so validation, types, this document and the hc client all derive from one source.",
  },
});

app.onError((err, c) => {
  const requestId = c.get("reqId");

  if (err instanceof HTTPException) {
    // throwOnDbError attaches { code, db } so the caller gets a stable code to
    // branch on while the database's own words stay in the log.
    const cause = err.cause as { code?: string; db?: unknown } | undefined;
    c.get("log")?.warn(
      { status: err.status, code: cause?.code, err: err.message, db: cause?.db },
      "handled",
    );
    return c.json(
      {
        error: {
          code: cause?.code ?? "http_error",
          message: err.message,
          requestId,
        },
      },
      err.status,
    );
  }

  // A database error that escaped without going through throwOnDbError still
  // gets translated rather than leaking.
  const mapped = mapDatabaseError(err as DbError);
  if (mapped) {
    c.get("log")?.warn({ code: mapped.code, err }, "handled.db");
    return c.json(
      { error: { code: mapped.code, message: mapped.message, requestId } },
      mapped.status,
    );
  }

  // Unmapped failures are logged in full and answered with a support code.
  // Returning err.message would hand constraint names, SQL fragments and table
  // structure to whoever provoked the error.
  c.get("log")?.error({ err }, "unhandled");
  return c.json(
    {
      error: {
        code: "internal_error",
        message: "Something went wrong. Quote the request id to support.",
        requestId,
      },
    },
    500,
  );
});

app.notFound((c) =>
  c.json(
    {
      error: {
        code: "not_found",
        message: `No route for ${c.req.method} ${c.req.path}`,
        requestId: c.get("reqId"),
      },
    },
    404,
  ),
);

/** Consumed by `hc<AppType>` in apps/admin and apps/store. */
export type AppType = typeof routes;
