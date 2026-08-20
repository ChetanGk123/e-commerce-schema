import { swaggerUI } from "@hono/swagger-ui";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { RETAINED_304_HEADERS, etag } from "hono/etag";
import { timeout } from "hono/timeout";
import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { type DbError, mapDatabaseError } from "./errors";
import { env } from "./env";
import { rateLimit } from "./limits";
import { requestLogger } from "./logger";
import { render } from "./metrics";
import { validationHook } from "./schemas";
import { adminCatalogRoute, adminImagesRoute } from "./routes/admin-catalog";
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
// Both image upload paths. Missing one means photographs rejected at
// 256KB with a message about JSON.
const IMAGE_UPLOAD =
  /^\/admin\/(products\/[^/]+\/images|collections\/[^/]+\/image)$/;
const jsonBodyLimit = bodyLimit({ maxSize: env.MAX_BODY_KB * 1024 });
const imageBodyLimit = bodyLimit({ maxSize: env.MAX_IMAGE_KB * 1024 });

// Image upload is the one route where the JSON-sized cap is wrong: 256KB
// rejects every photograph a phone takes. It gets its own, larger cap
// rather than raising the limit everywhere -- MAX_BODY_KB is what stops
// a single request making this process allocate until it dies, and that
// argument does not stop applying just because one route needs more.
app.use("*", (c, next) =>
  c.req.method === "POST" && IMAGE_UPLOAD.test(c.req.path)
    ? imageBodyLimit(c, next)
    : jsonBodyLimit(c, next),
);

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
// An order number and an email is a guessable pair, and order numbers
// come from an ordinary sequence. Cost 12 allows five lookups a minute
// from one address -- enough for a person refreshing, not enough to walk
// the sequence.
app.use("/orders/track", rateLimit(12));
app.use("/cart/*", rateLimit(1));
app.use("/enquiries", rateLimit(6));
app.use("/stock-alerts", rateLimit(4));
app.use("/reviews", rateLimit(6));
app.use("/returns", rateLimit(4));
app.use("/gift-cards/redeem", rateLimit(10));
app.use("/account/erase", rateLimit(20));
app.use("/payments/*", rateLimit(6));

/**
 * Caching, and the default is no-store.
 *
 * That default is the load-bearing half. Every route below except the
 * catalog answers with someone's cart, someone's order or someone's
 * profile, and a response carrying no Cache-Control at all is not a
 * response that will not be cached -- it is one where the decision has
 * been left to whatever sits in front of it. Saying nothing is not the
 * same as saying no.
 */
app.use("*", async (c, next) => {
  await next();
  if (!c.res.headers.has("Cache-Control")) {
    c.res.headers.set("Cache-Control", "no-store");
  }
});

/**
 * The storefront catalog is the exception, and the only one: every route
 * under /catalog goes through anonClient(), so the bytes do not depend on
 * who asked and `public` is the truth rather than a hope.
 *
 * Sixty seconds because these rows carry stock. A stale `inStock` sends a
 * shopper to a checkout that fails at the reservation -- a disappointment,
 * not an oversell, because the thing that actually prevents overselling is
 * the stock >= 0 constraint and it is nowhere near this cache. Long enough
 * to absorb the burst when a listing page fans out into ten product pages;
 * short enough that a sold-out variant does not stay bookable for a whole
 * browsing session.
 *
 * The ETag does not save the query. The handler runs either way and the
 * digest is taken of what it returned; what a 304 saves is the body on the
 * wire, which is the part a phone on a train is paying for.
 */
const CATALOG_MAX_AGE = 60;

app.use(
  "/catalog/*",
  etag({
    // Hono's 304 keeps six headers and drops everything else, and for a
    // cross-origin caller that drops the CORS headers with them: the
    // browser revalidates, gets a 304 with no Access-Control-Allow-Origin,
    // and fails the request it was one header away from serving out of its
    // own cache. An ETag whose 304 does not work is worse than no ETag,
    // because it only breaks for the callers who cached successfully.
    //
    // Vary is appended by the cors middleware after this one unwinds, so
    // it survives on its own.
    retainedHeaders: [
      ...RETAINED_304_HEADERS,
      "access-control-allow-origin",
      "access-control-allow-credentials",
      "access-control-expose-headers",
      "x-request-id",
    ],
  }),
);
app.use("/catalog/*", async (c, next) => {
  await next();
  // Only success. A 404 falls through to no-store -- a product going live
  // should not spend a minute shadowed by a cached "no such product".
  if (c.res.ok) {
    c.res.headers.set("Cache-Control", `public, max-age=${CATALOG_MAX_AGE}`);
  }
});

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
  .route("/", adminImagesRoute)
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
 * Prometheus scrape target.
 *
 * Off unless METRICS_TOKEN is set, and 404 rather than 401 when it is
 * not -- same reasoning as the docs above. /metrics publishes the route
 * table, the traffic shape and the state of the mail queue, which is a
 * free map of this service for anybody who asks for it.
 *
 * Not behind requireStaff: a scraper has no account, and giving it one
 * would put a staff token in a Prometheus config file. A bearer token
 * that grants exactly one read-only endpoint is the smaller thing to
 * leak.
 *
 * Deliberately outside the OpenAPI document. It is not part of the API
 * any client codegen should see, and hc<AppType> has no business
 * knowing it exists.
 */
if (env.METRICS_TOKEN) {
  app.get("/metrics", (c) => {
    if (c.req.header("authorization") !== `Bearer ${env.METRICS_TOKEN}`) {
      // Same answer as no token configured at all, so a wrong token
      // cannot be told apart from an endpoint that was never turned on.
      return c.notFound();
    }
    return c.text(render(), 200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });
  });
}

/**
 * DOCS_PUBLIC=false hides both.
 *
 * Middleware rather than a branch around the routes below, because
 * app.doc() registers its own GET handler and the first match wins --
 * a second handler added afterwards would never run, and the document
 * would stay readable while looking gated.
 *
 * 404, not 401. A 401 confirms there is something there, which is the
 * one fact anybody asking for the route map was after.
 */
if (!env.DOCS_PUBLIC) {
  // async only to satisfy the middleware signature: c.notFound() returns
  // a Response, and a middleware must return a promise of one.
  app.use("/docs", async (c) => c.notFound());
  app.use("/openapi.json", async (c) => c.notFound());
}

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
 * Public by default. The admin surface is protected by requireStaff and RLS,
 * not by being unlisted, and a document nobody can fetch is a client nobody
 * can generate -- so this is a deployment's choice rather than a hardening
 * step, which is why it is DOCS_PUBLIC and not an if (production).
 *
 * Off, both answer 404 in the same envelope as any unknown path. Not 401:
 * a 401 confirms there is something there, which is the one fact somebody
 * who wanted the route map was after.
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
