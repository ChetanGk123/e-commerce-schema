import { z } from "zod";

/**
 * Validated at import time so a missing service key is a startup crash naming
 * the variable, not a 500 on the first checkout.
 *
 * SUPABASE_URL is the INTERNAL address (http://kong:8000 on dokploy-network),
 * never the public https://supabase.<domain> the browsers use. Mixing the two
 * produces failures that read like auth errors.
 */
/**
 * An emptied-out variable means "not set", not "set to nothing".
 *
 * Switching providers is done by blanking the old credentials, and
 * `RESEND_API_KEY=` failing `.min(1)` would crash the process on boot
 * during exactly that migration. Treating blank as absent is what makes
 * the swap a one-line edit.
 */
const blankAsUnset = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  /** Bypasses RLS. Only checkout, payment capture, webhooks, staff creation. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  /** Self-hosted GoTrue signs HS256 with this. Confirmed from the template. */
  SUPABASE_JWT_SECRET: z.string().min(1),

  /**
   * Razorpay. Optional, so the catalog, cart and COD checkout all run --
   * and the test suite runs -- on a machine with no gateway credentials.
   * The payment routes answer 503 when they are missing rather than
   * failing at import and taking the whole API down with them.
   *
   * KEY_ID is public: it is handed to the browser to open the checkout
   * widget. KEY_SECRET and WEBHOOK_SECRET never leave this process.
   */
  RAZORPAY_KEY_ID: z.string().min(1).optional(),
  RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),

  /**
   * Outbox delivery. All optional: with no provider the drain claims
   * nothing and every message stays queued, which is the correct
   * behaviour for a store whose mail is not wired up yet -- and exactly
   * what the drain does when the provider is merely down.
   */
  /**
   * Which provider actually sends. Leave unset and it is inferred from
   * whichever credentials are present, so an existing deployment keeps
   * working untouched; set it to pin the choice when both are configured.
   */
  MAIL_PROVIDER: blankAsUnset(z.enum(["resend", "smtp"]).optional()),
  MAIL_FROM: blankAsUnset(z.string().email().optional()),

  // Resend: one HTTP POST, no SDK.
  RESEND_API_KEY: blankAsUnset(z.string().min(1).optional()),

  // SMTP: Gmail, Zoho, Fastmail, SES, Mailgun, Postmark, SendGrid --
  // they all speak it, so one adapter covers every provider worth naming.
  // Gmail wants an App Password, not the account password, and 2FA on.
  SMTP_HOST: blankAsUnset(z.string().min(1).optional()),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  SMTP_USER: blankAsUnset(z.string().min(1).optional()),
  SMTP_PASS: blankAsUnset(z.string().min(1).optional()),
  /**
   * True for implicit TLS on 465. Leave false for 587, where the
   * connection starts plaintext and upgrades with STARTTLS -- which is
   * what Gmail, Zoho and SES expect. False does NOT mean unencrypted.
   */
  SMTP_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Guards POST /jobs/drain. Without it the endpoint refuses everyone. */
  JOBS_SECRET: z.string().min(16).optional(),
  /**
   * Seconds between in-process drains. 0 disables the loop entirely --
   * set that where pg_cron or an external scheduler owns the job, so two
   * schedulers do not both drive it.
   */
  JOBS_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),

  /**
   * Browser origins allowed to call this API, comma separated. Empty means
   * NO browser may call it -- which is the right default for a service that
   * holds the service key: a permissive CORS policy on a credentialed API
   * is how a shopper's session gets driven from a page they did not open.
   *
   *   CORS_ORIGINS=https://admin.example.com,https://shop.example.com
   */
  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((o) => o.trim()).filter(Boolean)),

  /**
   * Deadline on every call this process makes to Supabase -- PostgREST
   * and GoTrue both.
   *
   * Neither supabase-js nor fetch imposes one, so without this a server
   * that accepts the connection and then stops answering holds the
   * request open for as long as the caller waits. Ten seconds is far
   * above any query this service issues; raise it only if a legitimately
   * slow deployment starts answering 504, and look at the query first.
   */
  SUPABASE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),

  /**
   * Ceiling on a whole request, whatever it does inside.
   *
   * SUPABASE_TIMEOUT_MS bounds one call; it does not bound a handler that
   * makes several, and supabase-js retries a failed call up to four times
   * on its own -- measured, against a black-holed address: a 1s per-call
   * deadline still took 11s to answer. This is the number that decides
   * how long a caller actually waits.
   *
   * POST /jobs/drain is exempt: sending a batch of mail legitimately
   * takes longer than any interactive request should.
   */
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),

  /**
   * Whether /docs and /openapi.json answer at all.
   *
   * Public by default, because that is the decision this project already
   * took: the admin surface is guarded by requireStaff and RLS, not by
   * being unlisted, and a document nobody can fetch is a client nobody
   * can generate. Set false where the route map itself should not be
   * published -- both paths then 404 rather than 401, since a 401 admits
   * there is something there to refuse.
   *
   * Turning this off protects nothing on its own. If it feels like it
   * does, the thing to fix is whatever route it is hiding.
   */
  DOCS_PUBLIC: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  /**
   * Bearer token a Prometheus scraper must present at GET /metrics.
   *
   * Unset means the endpoint does not exist -- 404, like any other path
   * this service does not serve. Closed by default for the same reason
   * CORS is: /metrics publishes the route table, the traffic shape and
   * the state of the mail queue, which is a free map of the service for
   * anyone who asks.
   *
   *   scrape_configs:
   *     - job_name: ecom-api
   *       authorization: { credentials: "<this value>" }
   */
  METRICS_TOKEN: blankAsUnset(z.string().min(16).optional()),

  /**
   * Supabase Storage bucket holding product images. Unset means the
   * image routes answer 503 rather than pretending -- a store can be
   * built and run without them, and half-configured storage that fails
   * on upload is worse than storage that says it is not there.
   *
   * The bucket is backed by Cloudflare R2; the credentials live on the
   * storage container, not in this process. See docs/setup.md C5.
   */
  STORAGE_BUCKET: blankAsUnset(z.string().min(1).optional()),

  /**
   * Where a browser fetches those images from -- a custom domain on the
   * R2 bucket, e.g. https://images.example.com.
   *
   * Unset, image URLs fall back to Supabase Storage's own public path,
   * which works and proxies every byte through the storage container.
   * That is your bandwidth and it throws away the one reason to be on
   * R2. Set this before any real traffic.
   */
  STORAGE_PUBLIC_URL: blankAsUnset(z.string().url().optional()),

  /** Largest image accepted, in kilobytes. Separate from MAX_BODY_KB,
   *  which is sized for JSON and would reject every photograph. */
  MAX_IMAGE_KB: z.coerce.number().int().min(64).max(51_200).default(5_120),

  /** Largest request body accepted, in kilobytes. */
  MAX_BODY_KB: z.coerce.number().int().min(1).max(10_240).default(256),

  /**
   * Requests per minute per client IP on the anonymous write surfaces.
   * 0 disables the limiter -- for a deployment sitting behind one that
   * already does this properly, since two limiters disagreeing is worse
   * than one.
   */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).max(100_000).default(60),

  /**
   * Header carrying the real client IP, set by whatever sits in front.
   * Read ONLY when named: trusting X-Forwarded-For unconditionally lets
   * any caller pick their own rate-limit bucket by forging it.
   */
  TRUSTED_PROXY_HEADER: z.string().optional(),
});

/**
 * The two deadlines have to be ordered, or one of them can never be seen.
 *
 * With the request ceiling at or below the per-call deadline, every slow
 * call is cut by the ceiling first and answers `request_timeout` -- so
 * `database_timeout`, the one that says which of the two is actually
 * wrong, never reaches anyone. Caught at boot, naming both values,
 * rather than discovered while reading a confusing incident.
 */
const ordered = schema.refine(
  (e) => e.REQUEST_TIMEOUT_MS > e.SUPABASE_TIMEOUT_MS,
  (e) => ({
    path: ["REQUEST_TIMEOUT_MS"],
    message: `must exceed SUPABASE_TIMEOUT_MS (${e.SUPABASE_TIMEOUT_MS}), or a slow database can only ever report request_timeout`,
  }),
);

const parsed = ordered.safeParse(process.env);

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment:\n${detail}`);
}

export const env = parsed.data;
export type Env = typeof env;
