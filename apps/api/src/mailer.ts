import { env } from "./env";

/**
 * Sending, and what it means when we cannot.
 *
 * There is one provider here (Resend) and it is reached with fetch
 * rather than an SDK -- it is a single POST, and a dependency for that
 * is a dependency to keep up to date for no gain.
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

export const mailerConfigured = (): boolean =>
  Boolean(env.RESEND_API_KEY && env.MAIL_FROM);

/**
 * Turns a queued row into something a person can read.
 *
 * Deliberately plain. A templating engine here would be a second place
 * for copy to live and a second thing to keep in step with the schema;
 * when these need design, they become provider-side templates addressed
 * by `template`, and this function goes away.
 */
function render(m: Message): { subject: string; text: string } {
  const p = (m.payload ?? {}) as Record<string, unknown>;
  const order = typeof p.order_number === "string" ? p.order_number : "your order";
  const total = p.grand_total;

  switch (m.template) {
    case "order_confirmation":
      return {
        subject: `Order ${order} confirmed`,
        text: `Thanks for your order.\n\nOrder: ${order}${
          total != null ? `\nTotal: ${String(total)}` : ""
        }\n\nWe will email again when it ships.`,
      };
    default:
      return {
        subject: `Update on ${order}`,
        text: `There is an update on ${order}.`,
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

  const { subject, text } = render(m);

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [m.recipient],
        subject,
        text,
      }),
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
