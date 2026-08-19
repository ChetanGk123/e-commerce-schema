import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { requireAuth, requireStaff } from "../auth";
import { idempotent } from "../idempotency";
import { throwOnDbError } from "../errors";
import { jsonError, pageQuery, validationHook } from "../schemas";

/**
 * Store credit and gift cards.
 *
 * Both are ledgers with a view on top, and neither has a balance the API
 * is allowed to compute. credit_ledger is append-only -- there is no
 * balance column to correct, which is the point: a wrong entry is fixed
 * by a compensating entry and both stay visible. The balance comes from
 * customer_credit_balances, never from summing rows here.
 *
 * A gift card's code exists in plaintext for exactly one response, at
 * issue. Only digest(code,'sha256') is stored, so redemption is a
 * server-side lookup by hash -- a customer cannot read gift_cards by
 * code, and own_gift_cards shows them only the ones they bought.
 */
const CreditEntry = z
  .object({
    id: z.string().uuid(),
    delta: z.number(),
    reason: z.string(),
    note: z.string().nullable(),
    orderId: z.string().uuid().nullable(),
    returnId: z.string().uuid().nullable(),
    expiresAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("CreditEntry");

const CreditBalance = z
  .object({
    /** From customer_credit_balances, which excludes expired entries. */
    balance: z.number(),
    currency: z.string(),
    entries: z.array(CreditEntry),
  })
  .openapi("CreditBalance");

const IssuedGiftCard = z
  .object({
    giftCardId: z.string().uuid(),
    /**
     * Shown ONCE. Only its sha256 is stored, so if this response is lost
     * the card has to be reissued -- the same bargain as a password, and
     * for the same reason: a leaked backup must not be a wallet.
     */
    code: z.string(),
    last4: z.string(),
    balance: z.number(),
    expiresAt: z.string().nullable(),
  })
  .openapi("IssuedGiftCard");

const Redemption = z
  .object({
    redeemed: z.number(),
    last4: z.string(),
    creditBalance: z.number(),
  })
  .openapi("GiftCardRedemption");

interface CreditRow {
  id: string;
  delta: number;
  reason: string;
  note: string | null;
  order_id: string | null;
  return_id: string | null;
  expires_at: string | null;
  created_at: string;
}

const authErrors = {
  401: jsonError("Missing or invalid token"),
  403: jsonError("Not allowed"),
};

const CREDIT_SELECT =
  "id, delta, reason, note, order_id, return_id, expires_at, created_at";

const shapeEntry = (r: CreditRow) => ({
  id: r.id,
  delta: Number(r.delta),
  reason: r.reason,
  note: r.note,
  orderId: r.order_id,
  returnId: r.return_id,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
});

const myCredit = createRoute({
  method: "get",
  path: "/credit",
  tags: ["wallet"],
  summary: "My store credit",
  description:
    "The balance comes from customer_credit_balances, which already drops expired entries. It is never the sum of the entries below -- those include expired ones, deliberately, so a customer can see credit that lapsed rather than watching it vanish.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  responses: {
    200: {
      description: "Balance and history",
      content: { "application/json": { schema: CreditBalance } },
    },
    ...authErrors,
  },
});

const redeem = createRoute({
  method: "post",
  path: "/gift-cards/redeem",
  tags: ["wallet"],
  summary: "Turn a gift card into store credit",
  description:
    "Redeems the whole remaining balance. Partial redemption is not offered: a card with a balance and a customer with a balance are two places money can be, and reconciling them is work nobody asked for -- the credit ledger already handles spending a bit at a time.\n\nEvery failure says the same thing. Distinguishing 'expired' from 'unknown' would tell someone guessing codes that they guessed one.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ code: z.string().trim().min(8).max(40) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Redeemed",
      content: { "application/json": { schema: Redemption } },
    },
    400: jsonError("Invalid body"),
    422: jsonError("That card cannot be redeemed"),
    ...authErrors,
  },
});

const grant = createRoute({
  method: "post",
  path: "/admin/customers/{id}/credit",
  tags: ["admin", "wallet"],
  summary: "Grant or claw back store credit",
  description:
    "`return_credit` and `gift_card_redemption` are not grantable here -- those are written by the flows that earn them, and granting one by hand would invent a return or a card that does not exist. The note is mandatory.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff, idempotent("credit_grant")] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            delta: z.number().refine((n) => n !== 0, "Use a non-zero amount"),
            reason: z.enum(["goodwill", "promotion", "adjustment", "expiry"]),
            note: z.string().trim().min(3).max(500),
            expires_at: z.string().datetime().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Posted",
      content: {
        "application/json": {
          schema: z.object({ customerId: z.string().uuid(), balance: z.number() }),
        },
      },
    },
    400: jsonError("Invalid body"),
    409: jsonError("That would take the balance below zero"),
    422: jsonError("Reason not grantable, or no note"),
    ...authErrors,
  },
});

const customerCredit = createRoute({
  method: "get",
  path: "/admin/customers/{id}/credit",
  tags: ["admin", "wallet"],
  summary: "A customer's credit ledger",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: { params: z.object({ id: z.string().uuid() }), query: z.object(pageQuery) },
  responses: {
    200: {
      description: "Balance and history",
      content: { "application/json": { schema: CreditBalance } },
    },
    ...authErrors,
  },
});

const issue = createRoute({
  method: "post",
  path: "/admin/gift-cards",
  tags: ["admin", "wallet"],
  summary: "Issue a gift card",
  description:
    "**The code is returned once and never again.** Only its sha256 is stored, so there is no endpoint that can tell you what it was -- if this response is lost, the card must be reissued and the old one disabled.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff, idempotent("gift_card_issue", true)] as const,
  request: {
    headers: z.object({
      "idempotency-key": z
        .string()
        .min(8)
        .max(255)
        .openapi({ description: "Required. A gift card is money; a double-submit must not mint two." }),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            amount: z.number().positive().max(1_000_000),
            recipient_email: z.string().email().max(254).optional(),
            message: z.string().max(500).optional(),
            expires_at: z.string().datetime().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Issued -- keep the code, it is not shown again",
      content: { "application/json": { schema: IssuedGiftCard } },
    },
    400: jsonError("Invalid body"),
    422: jsonError("A gift card has to be worth something"),
    ...authErrors,
  },
});

async function creditFor(
  db: ReturnType<typeof import("../supabase").serviceClient>,
  customerId: string,
  limit: number,
  offset: number,
) {
  const [balance, entries] = await Promise.all([
    db
      .from("customer_credit_balances")
      .select("balance")
      .eq("customer_id", customerId)
      .maybeSingle(),
    db
      .from("credit_ledger")
      .select(CREDIT_SELECT)
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1),
  ]);
  throwOnDbError(balance.error);
  throwOnDbError(entries.error);

  return {
    // No rows means no ledger entries at all, which is a zero balance --
    // not a missing one.
    balance: Number((balance.data as { balance: number } | null)?.balance ?? 0),
    currency: "INR",
    entries: ((entries.data ?? []) as unknown as CreditRow[]).map(shapeEntry),
  };
}

export const walletRoute = new OpenAPIHono({ defaultHook: validationHook })
  .openapi(myCredit, async (c) => {
    const caller = c.get("caller");
    return c.json(await creditFor(caller.db, caller.userId, 50, 0), 200);
  })

  .openapi(redeem, async (c) => {
    const { code } = c.req.valid("json");
    // Never logged, at any level: a code in a log line is money in a log
    // line, and log lines outlive the request in every backup.
    const { data, error } = await c
      .get("caller")
      .db.rpc("redeem_gift_card", { p_code: code });
    throwOnDbError(error);

    const r = data as unknown as {
      redeemed: number;
      last4: string;
      credit_balance: number;
    };
    c.get("log")?.info({ last4: r.last4 }, "wallet.gift_card_redeemed");

    return c.json(
      {
        redeemed: Number(r.redeemed),
        last4: r.last4,
        creditBalance: Number(r.credit_balance),
      },
      200,
    );
  })

  .openapi(grant, async (c) => {
    const { id } = c.req.valid("param");
    const { delta, reason, note, expires_at } = c.req.valid("json");

    const { data, error } = await c.get("caller").db.rpc("admin_grant_credit", {
      p_customer_id: id,
      p_delta: delta,
      p_reason: reason,
      p_note: note,
      p_expires_at: expires_at ?? null,
    });
    throwOnDbError(error);

    c.get("log")?.info({ customerId: id, reason }, "wallet.credit_granted");
    return c.json({ customerId: id, balance: Number(data) }, 201);
  })

  .openapi(customerCredit, async (c) => {
    const { id } = c.req.valid("param");
    const { limit, offset } = c.req.valid("query");
    return c.json(await creditFor(c.get("caller").db, id, limit, offset), 200);
  })

  .openapi(issue, async (c) => {
    const body = c.req.valid("json");
    const { data, error } = await c.get("caller").db.rpc("admin_issue_gift_card", {
      p_amount: body.amount,
      p_recipient_email: body.recipient_email ?? null,
      p_message: body.message ?? null,
      p_expires_at: body.expires_at ?? null,
    });
    throwOnDbError(error);

    const g = data as unknown as {
      gift_card_id: string;
      code: string;
      last4: string;
      balance: number;
      expires_at: string | null;
    };
    // last4 only. The code goes to the caller and nowhere else.
    c.get("log")?.info(
      { giftCardId: g.gift_card_id, last4: g.last4 },
      "wallet.gift_card_issued",
    );

    return c.json(
      {
        giftCardId: g.gift_card_id,
        code: g.code,
        last4: g.last4,
        balance: Number(g.balance),
        expiresAt: g.expires_at,
      },
      201,
    );
  });
