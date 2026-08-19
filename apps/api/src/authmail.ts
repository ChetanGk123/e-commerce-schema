import { env } from "./env";
import { serviceClient } from "./supabase";

/**
 * Auth emails, sent by us rather than by Supabase.
 *
 * GoTrue will happily mail a recovery link itself -- and on this stack it
 * cannot: the template's SMTP points at a `supabase-mail` host that does
 * not exist, so `POST /auth/v1/recover` answers 500 and the reset is
 * silently lost. Two mail paths also means two places for a failure to
 * hide, two sets of copy, and one of them invisible to `message_log`.
 *
 * So GoTrue is asked for the code and told nothing about delivery:
 * `admin/generate_link` mints an OTP and a link WITHOUT sending
 * anything. The code goes into `message_log` and leaves through the same
 * outbox drain as an order confirmation -- one queue, one retry policy,
 * one place a stuck message is visible.
 *
 * We send the OTP, never the `action_link`. That link points at
 * `http://kong:8000`, the internal URL, unreachable from a customer's
 * laptop; rewriting it to the public host would work but would put a
 * Supabase URL in front of shoppers and reopen the browser-to-Supabase
 * path B16 closed. Six digits travel better.
 *
 * SERVICE KEY. Both halves need it -- `generate_link` is an admin
 * endpoint, and `message_log` has no policy for `authenticated`. That
 * makes this the sixth documented service-key path.
 */

export type AuthMailKind = "recovery" | "signup" | "invite" | "email_change";

/**
 * Our name for the flow, GoTrue's name for the link, and the template
 * `mailer.render()` switches on. Kept together so adding a flow is one
 * edit rather than three that can disagree.
 */
const KINDS: Record<AuthMailKind, { linkType: string; template: string }> = {
  recovery: { linkType: "recovery", template: "password_reset" },
  signup: { linkType: "signup", template: "signup_confirmation" },
  invite: { linkType: "invite", template: "staff_invite" },
  // GoTrue splits an address change into a mail to the old address and one
  // to the new. The new address is the one that has to prove it exists.
  email_change: { linkType: "email_change_new", template: "email_change" },
};

export type AuthMailResult =
  | { ok: true }
  | { ok: false; reason: "unknown_user" | "generate_failed" | "queue_failed" };

interface GenerateLinkResponse {
  email_otp?: string;
  hashed_token?: string;
  properties?: { email_otp?: string; hashed_token?: string };
  user?: { id?: string };
  msg?: string;
  error_description?: string;
}

/**
 * Mint a code and queue the email carrying it.
 *
 * Never throws for an unknown address: `/auth/password/forgot` answers
 * the same either way, and a thrown error there would be the enumeration
 * oracle that endpoint exists to avoid. The caller decides what to do
 * with the reason -- usually log it and carry on.
 */
export async function sendAuthCode(
  kind: AuthMailKind,
  email: string,
  opts: { newEmail?: string; password?: string; customerId?: string | null } = {},
): Promise<AuthMailResult> {
  const { linkType, template } = KINDS[kind];

  let res: Response;
  try {
    res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: linkType,
        email,
        ...(opts.newEmail ? { new_email: opts.newEmail } : {}),
        // Only `signup` and `invite` accept one, and only when the user
        // does not exist yet.
        ...(opts.password ? { password: opts.password } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, reason: "generate_failed" };
  }

  const body = (await res.json().catch(() => ({}))) as GenerateLinkResponse;
  const code = body.email_otp ?? body.properties?.email_otp;

  if (!res.ok || !code) {
    // 404/422 here is "no such address", which is not an error worth
    // surfacing anywhere a caller could observe it.
    const missing = res.status === 404 || res.status === 422;
    return { ok: false, reason: missing ? "unknown_user" : "generate_failed" };
  }

  // The recipient is snapshotted on the row: an address change must not
  // retarget a message already queued to the old one.
  const recipient = kind === "email_change" ? (opts.newEmail ?? email) : email;

  const { error } = await serviceClient().from("message_log").insert({
    customer_id: opts.customerId ?? null,
    channel: "email",
    template,
    recipient,
    payload: { code },
  });

  if (error) return { ok: false, reason: "queue_failed" };
  return { ok: true };
}

/**
 * Exchange an emailed code for a session.
 *
 * The same GoTrue endpoint serves every flow; only `type` differs. A
 * wrong, stale or already-spent code is indistinguishable from here, and
 * deliberately so -- the caller turns all of them into one message.
 */
export async function verifyAuthCode(
  kind: AuthMailKind,
  email: string,
  code: string,
): Promise<Record<string, unknown> | null> {
  let res: Response;
  try {
    res = await fetch(`${env.SUPABASE_URL}/auth/v1/verify`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: KINDS[kind].linkType, email, token: code }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }

  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}
