import { z } from "zod";

/**
 * Validated at import time so a missing service key is a startup crash naming
 * the variable, not a 500 on the first checkout.
 *
 * SUPABASE_URL is the INTERNAL address (http://kong:8000 on dokploy-network),
 * never the public https://supabase.<domain> the browsers use. Mixing the two
 * produces failures that read like auth errors.
 */
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
  RESEND_API_KEY: z.string().min(1).optional(),
  MAIL_FROM: z.string().email().optional(),
  /** Guards POST /jobs/drain. Without it the endpoint refuses everyone. */
  JOBS_SECRET: z.string().min(16).optional(),
  /**
   * Seconds between in-process drains. 0 disables the loop entirely --
   * set that where pg_cron or an external scheduler owns the job, so two
   * schedulers do not both drive it.
   */
  JOBS_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment:\n${detail}`);
}

export const env = parsed.data;
export type Env = typeof env;
