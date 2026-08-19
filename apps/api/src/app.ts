import { swaggerUI } from "@hono/swagger-ui";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { timeout } from "hono/timeout";
import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { type DbError, mapDatabaseError } from "./errors";
import { env } from "./env";
import { rateLimit } from "./limits";
import { requestLogger } from "./logger";
import { validationHook } from "./schemas";
import { adminCatalogRoute } from "./routes/admin-catalog";
import { cartRoute } from "./routes/cart";
import { accountRoute } from "./routes/account";
import { authRoute } from "./routes/auth";
import { catalogRoute } from "./routes/catalog";
import { checkoutRoute } from "./routes/checkout";
import { discountsRoute } from "./routes/discounts";
import { emailTemplatesRoute } from "./routes/email-templates";
import { engagementRoute } from "./routes/engagement";
import { fulfilmentRoute } from "./routes/fulfilment";
import { healthRoute } from "./routes/health";
import { inventoryRoute } from "./routes/inventory";
import { invoicingRoute } from "./routes/invoicing";
import { jobsRoute } from "./routes/jobs";
import { meRoute } from "./routes/me";
import { ordersRoute } from "./routes/orders";
import { paymentsRoute } from "./routes/payments";
import { returnsRoute } from "./routes/returns";
import { settingsRoute } from "./routes/settings";
import { adminShippingRoute, shippingRoute } from "./routes/shipping";
import { staffRoute } from "./routes/staff";
import { supportRoute } from "./routes/support";
import { taxonomyRoute } from "./routes/taxonomy";
import { walletRoute } from "./routes/wallet";
import { webhooksRoute } from "./routes/webhooks";

/**
 * The app is built here and served in server.ts. Keeping them apart means
 * importing AppType (for hc) or calling app.request() in a test does not bind
 * a port as a side effect of the import.
 */
export const app = new OpenAPIHono({ defaultHook: validationHook });

app.use("*", requestLogger);

/**
 * CORS, closed by default.
 *
 * With CORS_ORIGINS unset no browser origin is allowed, which is the
 * right default for a service holding the service key: a permissive
 * policy on a credentialed API is how a shopper's session gets driven
 * from a page they never opened. Server-to-server callers -- webhooks,
 * cron, curl -- send no Origin and are unaffected either way.
 */
app.use(
  "*",
  cors({
    origin: (origin) => (env.CORS_ORIGINS.includes(origin) ? origin : null),
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "X-Cart-Session",
      "X-Cart-Id",
      "X-Request-Id",
    ],
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    // The cart session and the rate-limit budget both need to survive a
    // browser round trip, so the client has to be able to read them.
    exposeHeaders: [
      "X-Cart-Session",
      "X-Request-Id",
      "RateLimit-Limit",
      "RateLimit-Remaining",
      "RateLimit-Reset",
    ],
    credentials: true,
    maxAge: 600,
  }),
);

/**
 * A ceiling on how long a caller waits, whatever the handler is doing.
 *
 * The per-call deadline in supabase.ts bounds one round trip. It does not
 * bound a handler that makes several, and supabase-js retries a failed
 * call up to four times by itself -- against a black-holed database a 1s
 * per-call deadline still took 11 seconds to answer. Without this, "the
 * database is slow" arrives as "the API never responds", and every
 * request parked waiting is memory this process cannot reuse.
 *
 * The drain is exempt: sending a batch of mail is not an interactive
 * request and legitimately outlasts this.
 */
const requestDeadline = timeout(
  env.REQUEST_TIMEOUT_MS,
  // Hono's default is a bare "Gateway Timeout" with no code. Everything
  // else in this service answers in one envelope, and a client branching
  // on error.code should not have to special-case this one.
  () =>
    new HTTPException(504, {
      message: "That took too long. Try again.",
      cause: { code: "request_timeout" },
    }),
);
app.use("*", (c, next) =>
  c.req.path === "/jobs/drain" ? next() : requestDeadline(c, next),
);

/**
 * A body cap, because every route below parses what it is handed. Without
 * this a single request can make the process allocate until it dies, and
 * no amount of validation downstream helps -- the allocation happens
 * first.
 */
app.use("*", bodyLimit({ maxSize: env.MAX_BODY_KB * 1024 }));

/**
 * Rate limits on the surfaces a stranger can write to.
 *
 * Not a quota system -- see limits.ts for what this does and does not
 * promise. The costs say which requests are expensive: a checkout
 * attempt reserves stock and talks to a gateway, so ten of them should
 * exhaust an allowance that a hundred product views would not.
 */
// Sign-in is where a password list gets pointed. The budget is 60/min,
// so cost 10 allows six attempts a minute from one address; sign-up and
// the reset mail cost more because each one has a side effect elsewhere.
app.use("/auth/sign-in", rateLimit(10));
app.use("/auth/sign-up", rateLimit(15));
app.use("/auth/password/forgot", rateLimit(20));
app.use("/auth/password/change", rateLimit(10));
app.use("/checkout", rateLimit(6));
app.use("/cart/*", rateLimit(1));
app.use("/enquiries", rateLimit(6));
app.use("/stock-alerts", rateLimit(4));
app.use("/reviews", rateLimit(6));
app.use("/returns", rateLimit(4));
app.use("/gift-cards/redeem", rateLimit(10));
app.use("/account/erase", rateLimit(20));
app.use("/payments/*", rateLimit(6));

// Every route mounts here. The chained .route() calls are what extend
// AppType, so hc<AppType> in the front ends knows about each one.
const routes = app
  .route("/", healthRoute)
  .route("/", authRoute)
  .route("/", meRoute)
  .route("/", staffRoute)
  .route("/", emailTemplatesRoute)
  .route("/", catalogRoute)
  .route("/", adminCatalogRoute)
  .route("/", taxonomyRoute)
  .route("/", shippingRoute)
  .route("/", adminShippingRoute)
  .route("/", discountsRoute)
  .route("/", settingsRoute)
  .route("/", cartRoute)
  .route("/", checkoutRoute)
  .route("/", ordersRoute)
  .route("/", paymentsRoute)
  .route("/", webhooksRoute)
  .route("/", inventoryRoute)
  .route("/", fulfilmentRoute)
  .route("/", returnsRoute)
  .route("/", walletRoute)
  .route("/", invoicingRoute)
  .route("/", accountRoute)
  .route("/", supportRoute)
  .route("/", engagementRoute)
  .route("/", jobsRoute);

/**
 * Declaring the scheme is what puts the Authorize button in Swagger UI. Routes
 * opt in with `security: [{ bearerAuth: [] }]`; without that a protected route
 * renders with no way to send a token and looks broken rather than guarded.
 *
 * It documents the requirement. It does not enforce it -- requireAuth does.
 */
app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
  description:
    "An access token from POST /auth/sign-in. Paste the accessToken here, without the word Bearer. Browsers do not talk to Supabase Auth directly any more -- this service owns the whole auth surface, so it is the one place rate limiting and audit see a sign-in.",
});

app.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "E-commerce API",
    version: "0.0.0",
    description:
      "Shared backend for the admin console and storefront. Request schemas come from @ecom/schema, so validation, types, this document and the hc client all derive from one source.",
  },
});

/**
 * Browsable docs at /docs, and the same document Postman imports.
 *
 * Both are public, as they already were. The admin surface is protected by
 * requireStaff and RLS, not by being unlisted -- but if you would rather not
 * publish the route map, this is the line to wrap in an env check.
 *
 * Swagger UI itself loads from a CDN, so /docs needs internet. /openapi.json
 * does not, and it is the one Postman and codegen actually consume.
 */
app.get("/docs", swaggerUI({ url: "/openapi.json" }));

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
