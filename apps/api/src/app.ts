import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { requestLogger } from "./logger";
import { healthRoute } from "./routes/health";
import { meRoute } from "./routes/me";

/**
 * The app is built here and served in server.ts. Keeping them apart means
 * importing AppType (for hc) or calling app.request() in a test does not bind
 * a port as a side effect of the import.
 */
export const app = new OpenAPIHono();

app.use("*", requestLogger);

// Every route mounts here. B2 replaces the generic handler below with the
// constraint-name -> message mapping from docs/schema_guide.md.
const routes = app.route("/", healthRoute).route("/", meRoute);

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
    c.get("log")?.warn({ status: err.status, err: err.message }, "handled");
    return c.json(
      { error: { code: "http_error", message: err.message, requestId } },
      err.status,
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
