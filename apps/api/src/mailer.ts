import nodemailer, { type Transporter } from "nodemailer";

import { env } from "./env";
import { serviceClient } from "./supabase";

/**
 * Sending, and what it means when we cannot.
 *
 * Two adapters, and that is enough for every provider worth naming.
 * Resend is one HTTP POST, so it is reached with fetch rather than an
 * SDK. Everything else -- Gmail, Zoho, Fastmail, SES, Mailgun, Postmark,
 * SendGrid -- speaks SMTP, so ONE SMTP adapter covers all of them.
 * Adding "support for Mailgun" is a change to `.env`, not to this file.
 *
 * SMTP goes through nodemailer rather than a hand-rolled client. This is
 * the one place in this service a dependency clearly earns its place:
 * AUTH, STARTTLS, MIME encoding, dot-stuffing and header folding are a
 * lot of ways to be subtly wrong at 3am. Spiked under Bun before it was
 * committed to -- it compiles a correct message and its socket errors
 * are clean.
 *
 * The important property is what happens with no key: `configured()` is
 * false, the drain claims nothing, and every message stays exactly where
 * checkout left it. That is deliberately the same shape as the provider
 * being down, because from the store's side those are the same event.
 */
export interface Message {
  id: string;
  channel: string;
  template: string;
  recipient: string;
  payload: Record<string, unknown> | null;
  attempts: number;
}

export interface SendResult {
  sent: boolean;
  providerRef?: string;
  error?: string;
}

export type MailProvider = "resend" | "smtp" | "none";

/**
 * Which adapter sends. An explicit MAIL_PROVIDER wins; otherwise it is
 * inferred from whichever credentials exist, so a deployment that
 * predates this choice keeps working without touching its environment.
 */
export function mailProvider(): MailProvider {
  if (env.MAIL_PROVIDER === "resend") return env.RESEND_API_KEY ? "resend" : "none";
  if (env.MAIL_PROVIDER === "smtp") return env.SMTP_HOST ? "smtp" : "none";
  if (env.RESEND_API_KEY) return "resend";
  if (env.SMTP_HOST) return "smtp";
  return "none";
}

/**
 * A from-address is required whatever the provider: SMTP servers reject
 * a message without one, and there is no sensible default to invent.
 */
export const mailerConfigured = (): boolean =>
  Boolean(env.MAIL_FROM) && mailProvider() !== "none";

/**
 * One pooled transport for the process. Reconnecting per message would
 * pay the TLS handshake every time, and providers rate-limit on
 * connections as readily as on messages.
 */
let smtp: Transporter | undefined;

function smtpTransport(): Transporter {
  smtp ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // False means STARTTLS on 587, not plaintext -- see env.ts.
    secure: env.SMTP_SECURE,
    auth:
      env.SMTP_USER && env.SMTP_PASS
        ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
        : undefined,
    pool: true,
    maxConnections: 3,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  });
  return smtp;
}

/**
 * Turns a queued row into something a person can read.
 *
 * Deliberately plain. A templating engine here would be a second place
 * for copy to live and a second thing to keep in step with the schema;
 * when these need design, they become provider-side templates addressed
 * by `template`, and this function goes away.
 */
export interface TemplateDef {
  subject: string;
  body: string;
  /** Shown beside the editor, so a key is not just a slug to guess at. */
  description: string;
  /** Without these the message is not worth sending. */
  required: readonly string[];
  /** Everything the payload offers, for the editor's help text. */
  variables: readonly string[];
}

/**
 * The floor.
 *
 * Every key the service can send, with copy that works before anyone has
 * customised anything. `message_templates` overrides these row by row; a
 * missing row means the entry here is used, which is what makes DELETE a
 * working "revert" and a fresh install send correct email out of the box.
 *
 * Built-ins go through the same interpolation as custom templates. If
 * they did not, a customised template would behave differently from the
 * one it replaced, and only in production.
 */
export const BUILT_IN: Record<string, TemplateDef> = {
  password_reset: {
    subject: "Your password reset code",
    body: "Use this code to set a new password:\n\n    {{code}}\n\nIf you did not ask to reset your password, ignore this email -- nothing has changed.",
    description: "Sent by /auth/password/forgot. Without the code it is a dead end.",
    required: ["code"],
    variables: ["code"],
  },
  signup_confirmation: {
    subject: "Confirm your email",
    body: "Welcome. Use this code to confirm your email address:\n\n    {{code}}\n\nIf you did not create an account, ignore this email.",
    description: "Sent on sign-up when the project requires email confirmation.",
    required: ["code"],
    variables: ["code"],
  },
  staff_invite: {
    subject: "You have been given admin access",
    body: "Use this code to finish setting up your account:\n\n    {{code}}\n\nYou will be asked to choose a password. If you were not expecting this, tell whoever runs the store.",
    description: "Sent when an owner creates a staff account by invitation.",
    required: ["code"],
    variables: ["code"],
  },
  email_change: {
    subject: "Confirm your new email address",
    body: "Use this code to confirm this address:\n\n    {{code}}\n\nUntil you do, your account keeps its old address. If you did not ask for this, ignore this email.",
    description: "Sent to the NEW address when someone changes their email.",
    required: ["code"],
    variables: ["code"],
  },
  order_confirmation: {
    subject: "Order {{order_number}} confirmed",
    body: "Thanks for your order.\n\nOrder: {{order_number}}\nTotal: {{grand_total}}\n\nWe will email again when it ships.",
    description: "Queued by checkout() for every order placed.",
    required: ["order_number"],
    variables: ["order_number", "grand_total"],
  },
};

/**
 * `{{ name }}` from the payload. An unknown name renders empty rather
 * than leaving braces in somebody's inbox -- a template referring to a
 * variable that no longer exists should look plain, not broken.
 *
 * Deliberately not a templating engine: no conditionals, no loops, no
 * property access. Staff-editable content evaluated by an engine is a
 * code-execution surface, and none of these emails need one.
 */
export const interpolate = (tpl: string, vars: Record<string, unknown>): string =>
  tpl.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });

const hasAll = (tpl: TemplateDef | Override, required: readonly string[]) =>
  required.every((r) => new RegExp(`\\{\\{\\s*${r}\\s*\\}\\}`).test(tpl.body));

export interface Override {
  subject: string;
  body: string;
}

/**
 * Turns a queued row into something a person can read.
 *
 * An override that has lost a required variable is not used. The API
 * refuses to save one, but `staff_all` lets any staff member write this
 * table straight through PostgREST, so the guard has to be here too --
 * at the point of sending, where the consequence lands. A reset email
 * with no code in it is worse than no email, because the customer cannot
 * tell it was broken rather than late.
 */
export function render(
  m: Message,
  override?: Override | null,
): { subject: string; text: string; usedOverride: boolean } {
  const payload = (m.payload ?? {}) as Record<string, unknown>;
  const def = BUILT_IN[m.template];

  const usable = override && (!def || hasAll(override, def.required)) ? override : null;
  const chosen: Override = usable ?? def ?? {
    subject: "Update on {{order_number}}",
    body: "There is an update on {{order_number}}.",
  };

  return {
    // Stripped again here, though the CHECK constraint already refuses a
    // newline: this is the last line before a header is written, and it
    // must not depend on which path the text arrived by.
    subject: interpolate(chosen.subject, payload).replace(/[\r\n]+/g, " ").trim(),
    text: interpolate(chosen.body, payload),
    usedOverride: usable !== null,
  };
}

/**
 * Overrides, cached briefly.
 *
 * The drain renders a batch at a time, so a per-message query would be
 * ten round trips to send ten emails. Sixty seconds is short enough that
 * an edit shows up while the person who made it is still watching, and
 * long enough that the queue is not the reason the database is busy.
 *
 * ponytail: per-process TTL, so two instances can disagree for up to a
 * minute after an edit. If that ever matters, listen on a NOTIFY instead
 * of shortening the TTL.
 */
let cache: { at: number; rows: Map<string, Override> } | null = null;
const CACHE_MS = 60_000;

export function invalidateTemplateCache(): void {
  cache = null;
}

async function overrides(): Promise<Map<string, Override>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;

  // Service key: the drain runs with no user, and message_templates has
  // no policy for anon.
  const { data, error } = await serviceClient()
    .from("message_templates")
    .select("key, subject, body");

  if (error) {
    // A template lookup must never be the reason an email does not go
    // out. Built-ins are correct copy; carry on with them.
    return cache?.rows ?? new Map();
  }

  const rows = new Map<string, Override>();
  for (const r of (data ?? []) as { key: string; subject: string; body: string }[]) {
    rows.set(r.key, { subject: r.subject, body: r.body });
  }
  cache = { at: Date.now(), rows };
  return rows;
}

async function sendViaResend(
  to: string,
  subject: string,
  text: string,
): Promise<SendResult> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text }),
      // A provider that never answers must not hold a drain worker
      // forever; the row goes back to queued and is tried next pass.
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      // The body can carry account detail, so it goes no further than
      // message_log.error, which is staff-only.
      return { sent: false, error: `resend ${res.status}` };
    }

    const body = (await res.json()) as { id?: string };
    return { sent: true, providerRef: body.id };
  } catch (err) {
    return {
      sent: false,
      error: err instanceof Error ? err.message.slice(0, 200) : "send failed",
    };
  }
}

async function sendViaSmtp(
  to: string,
  subject: string,
  text: string,
): Promise<SendResult> {
  try {
    const info = await smtpTransport().sendMail({
      from: env.MAIL_FROM,
      to,
      subject,
      text,
    });
    // A server that accepted nothing has not sent anything, whatever it
    // said. Reporting success there would lose the message silently.
    if (Array.isArray(info.accepted) && info.accepted.length === 0) {
      return { sent: false, error: "smtp accepted no recipients" };
    }
    return { sent: true, providerRef: info.messageId };
  } catch (err) {
    // Credentials and hostnames turn up in these; staff-only, like Resend's.
    return {
      sent: false,
      error: err instanceof Error ? err.message.slice(0, 200) : "smtp send failed",
    };
  }
}

export async function send(m: Message): Promise<SendResult> {
  if (m.channel !== "email") {
    // SMS and WhatsApp need MSG91 or Gupshup, which are not wired up.
    // Reporting it rather than silently marking it sent is what keeps
    // the queue honest about what has actually been delivered.
    return { sent: false, error: `no provider for channel ${m.channel}` };
  }
  if (!mailerConfigured()) {
    return { sent: false, error: "mailer not configured" };
  }

  const { subject, text } = render(m, (await overrides()).get(m.template));
  const provider = mailProvider();

  return provider === "smtp"
    ? sendViaSmtp(m.recipient, subject, text)
    : sendViaResend(m.recipient, subject, text);
}
