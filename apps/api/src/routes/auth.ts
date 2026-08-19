import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { requireAuth } from "../auth";
import { sendAuthCode, verifyAuthCode } from "../authmail";
import { env } from "../env";
import { jsonError, validationHook } from "../schemas";
import { serviceClient } from "../supabase";

/**
 * The auth surface.
 *
 * `src/auth.ts` is the middleware that verifies a token; this is the
 * surface that issues one. Different jobs, deliberately different files.
 *
 * ARCHITECTURE NOTE. api-plan originally had the browser talk to
 * Supabase Auth directly and reserved this service for everything else.
 * That is now reversed: the browser talks only to this API. The reason
 * the API exists at all -- "one place to rate-limit and audit" -- did
 * not survive an auth path that went around it. A sign-in the browser
 * reaches directly cannot be rate-limited here, cannot be counted
 * towards the per-account lockout below, and answers in a second error
 * envelope no client can branch on.
 *
 * WHAT THIS IS NOT: a reimplementation of GoTrue. Every handler below
 * forwards to Supabase Auth's own REST API and maps the answer into this
 * service's error envelope. GoTrue stays the source of truth for
 * sessions, tokens and password hashing -- rewriting any of that would
 * be strictly worse than the thing it replaced.
 *
 * TOKENS COME BACK IN THE BODY, not as cookies. This service is consumed
 * by browsers and by anything else that speaks HTTP, so it stays
 * stateless and framework-neutral; a browser client puts the session in
 * an httpOnly cookie server-side. Never localStorage.
 */

/** GoTrue, spoken directly. Stateless, so no session leaks between requests. */
async function gotrue(
  path: string,
  init: { method: "POST" | "PUT"; body?: unknown; token?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(`${env.SUPABASE_URL}/auth/v1/${path}`, {
      method: init.method,
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      // GoTrue gets the same deadline as PostgREST. Without it a hung
      // auth service holds every sign-in open indefinitely -- and the
      // catch below already knows what to do with the abort.
      signal: AbortSignal.timeout(env.SUPABASE_TIMEOUT_MS),
    });
  } catch (err) {
    // The auth service being unreachable is our problem, not the caller's.
    throw new HTTPException(502, {
      message: "The auth service could not be reached. Try again.",
      cause: { code: "auth_unavailable", db: (err as Error).message },
    });
  }

  const text = await res.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }
  return { status: res.status, body };
}

/** GoTrue words its failures several ways depending on the endpoint. */
const reasonOf = (b: Record<string, unknown>): string =>
  [b.error_description, b.msg, b.message, b.error].filter((v) => typeof v === "string").join(" ") ||
  "";

const Session = z
  .object({
    accessToken: z.string(),
    tokenType: z.string(),
    /** Seconds until `accessToken` expires. Refresh before it does. */
    expiresIn: z.number().int(),
    expiresAt: z.number().int().nullable(),
    refreshToken: z.string(),
    user: z.object({
      id: z.string().uuid(),
      email: z.string().nullable(),
    }),
  })
  .openapi("Session");

interface GotrueSession {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  expires_at?: number;
  refresh_token?: string;
  user?: { id?: string; email?: string | null };
}

/**
 * Only the fields a client needs. GoTrue's user object also carries
 * app_metadata, identities and confirmation timestamps -- none of it the
 * browser's business, and passing it through would make it part of this
 * API's contract by accident.
 */
function shapeSession(b: Record<string, unknown>): z.infer<typeof Session> | null {
  const s = b as GotrueSession;
  if (!s.access_token || !s.refresh_token || !s.user?.id) return null;
  return {
    accessToken: s.access_token,
    tokenType: s.token_type ?? "bearer",
    expiresIn: s.expires_in ?? 3600,
    expiresAt: s.expires_at ?? null,
    refreshToken: s.refresh_token,
    user: { id: s.user.id, email: s.user.email ?? null },
  };
}

const credentials = {
  email: z.string().email("Enter a valid email address").max(254),
  password: z.string().min(1, "Enter your password").max(72),
};

/**
 * Why GoTrue turned a password down.
 *
 * "Same as the old one" is worth saying plainly: it is the most common
 * refusal on a reset -- somebody typing the password they remember -- and
 * "does not meet the requirements" sends them hunting for a rule that
 * does not exist. Everything else stays generic, since the actual policy
 * is configured at the project and is not ours to describe.
 */
const passwordRejected = (body: Record<string, unknown>) => {
  const reason = reasonOf(body);
  if (/different from the old password|same.*old password/i.test(reason)) {
    return new HTTPException(400, {
      message: "That is already your password. Choose a different one.",
      cause: { code: "password_unchanged" },
    });
  }
  return new HTTPException(400, {
    message: /password/i.test(reason)
      ? "That password does not meet the requirements."
      : "That password could not be set.",
    cause: { code: "password_rejected" },
  });
};

const tooMany = () =>
  new HTTPException(429, {
    message: "Too many attempts. Try again shortly.",
    cause: { code: "rate_limited" },
  });

/**
 * The per-account half of the sign-in defence.
 *
 * The IP limiter in app.ts allows six attempts a minute from one
 * address, which is the right shape for one machine and the wrong shape
 * for the attack this endpoint gets: a credential list replayed a few
 * tries at a time across a thousand addresses, every one of them inside
 * its own budget. Only the account they share can see that.
 *
 * State lives in Postgres rather than in this process -- see
 * 20260801002800_signin_lockout.sql for why a second container must not
 * mean a second counter -- and the failure mode is chosen deliberately:
 * if the check itself errors, the sign-in proceeds. An outage in the
 * lockout must not become an outage in signing in.
 */
async function lockedUntil(email: string): Promise<string | null> {
  const { data, error } = await serviceClient().rpc("auth_lock_check", {
    p_email: email,
  });
  if (error) return null;
  return (data as unknown as string | null) ?? null;
}

const recordFailure = (email: string) =>
  serviceClient().rpc("auth_record_failure", { p_email: email });

/** Called on a successful sign-in, and after a password is reset. */
const clearFailures = (email: string) =>
  serviceClient().rpc("auth_clear_failures", { p_email: email });

const signUp = createRoute({
  method: "post",
  path: "/auth/sign-up",
  tags: ["auth"],
  summary: "Create a shopper account",
  description:
    "Creates the auth user. The `customers` row and its consent defaults come from the `handle_new_user` trigger, not from here -- which is why signing up needs no second call and cannot half-succeed.\n\nIf the project requires email confirmation there is no session to return yet, and the response says so with `confirmationRequired` rather than inventing one.\n\nThis endpoint does tell you when an email is already registered. That is an account-enumeration oracle and it is a deliberate trade: the alternative is a silent fake success, which on a store with no verified mail path (api-plan B11) means a shopper who cannot sign in and is told nothing. Rate limiting is the mitigation.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: credentials.email,
            password: z.string().min(8, "Use at least 8 characters").max(72),
            full_name: z.string().trim().min(1).max(120).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Signed up and signed in",
      content: { "application/json": { schema: Session } },
    },
    202: {
      description: "Created, but a confirmation email must be acted on first",
      content: {
        "application/json": {
          schema: z.object({ confirmationRequired: z.literal(true) }),
        },
      },
    },
    400: jsonError("Invalid body, or the password is too weak for the project's policy"),
    409: jsonError("That email is already registered"),
    429: jsonError("Too many attempts"),
    502: jsonError("The auth service could not be reached"),
  },
});

const signIn = createRoute({
  method: "post",
  path: "/auth/sign-in",
  tags: ["auth"],
  summary: "Exchange a password for a session",
  description:
    "A wrong password and an unknown email answer identically, for the same reason every 401 in this service does: the difference is a free way to find out who has an account here.\n\nRate-limited harder than anything else on the service. This is the endpoint a script points a password list at.\n\nLimited twice over: per IP address, and per email address. Ten failures against one address inside fifteen minutes locks that address for fifteen minutes, whatever addresses the attempts came from -- credential stuffing spreads across IPs and has only the account in common. A successful password reset lifts the lock immediately, which is the way out if somebody else triggered it. A locked address answers 429, identically to an address that has never had an account.",
  request: {
    body: { content: { "application/json": { schema: z.object(credentials) } } },
  },
  responses: {
    200: {
      description: "Signed in",
      content: { "application/json": { schema: Session } },
    },
    400: jsonError("Invalid body"),
    401: jsonError("Email or password is incorrect"),
    429: jsonError("Too many attempts"),
    502: jsonError("The auth service could not be reached"),
  },
});

const refresh = createRoute({
  method: "post",
  path: "/auth/refresh",
  tags: ["auth"],
  summary: "Trade a refresh token for a new session",
  description:
    "Access tokens last an hour. A client refreshes before expiry rather than after a 401, so a request never fails for a reason it could have avoided.\n\nA spent or revoked refresh token is a 401: sign in again.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ refresh_token: z.string().min(1).max(512) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "A fresh session",
      content: { "application/json": { schema: Session } },
    },
    400: jsonError("Invalid body"),
    401: jsonError("That refresh token is not usable"),
    502: jsonError("The auth service could not be reached"),
  },
});

const signOut = createRoute({
  method: "post",
  path: "/auth/sign-out",
  tags: ["auth"],
  summary: "Revoke the caller's session",
  description:
    "Revokes the refresh token at Supabase so it cannot mint another access token. The access token already issued stays valid until it expires -- it is a signed bearer token and nothing can recall it -- so a client must discard its copy too. Short token lifetimes are what bound that window.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  responses: {
    204: { description: "Signed out" },
    401: jsonError("Missing or invalid token"),
    502: jsonError("The auth service could not be reached"),
  },
});

const forgot = createRoute({
  method: "post",
  path: "/auth/password/forgot",
  tags: ["auth"],
  summary: "Send a password reset email",
  description:
    "Always answers 202, whether or not the address has an account. Unlike sign-up -- where the caller is choosing an address and needs to know it is taken -- there is nothing here an honest caller would do differently, so the enumeration oracle buys nobody anything.\n\nThe email is sent by Supabase Auth, not by this service's outbox. Its link carries a recovery token; the client then calls `/auth/password/change` with it.",
  request: {
    body: {
      content: {
        "application/json": { schema: z.object({ email: credentials.email }) },
      },
    },
  },
  responses: {
    202: {
      description: "If that address has an account, a reset email is on its way",
      content: {
        "application/json": { schema: z.object({ accepted: z.literal(true) }) },
      },
    },
    400: jsonError("Invalid body"),
    429: jsonError("Too many attempts"),
  },
});

const changePassword = createRoute({
  method: "post",
  path: "/auth/password/change",
  tags: ["auth"],
  summary: "Set a new password",
  description:
    "Takes any valid access token, which is what makes it serve both cases: a signed-in user changing their password, and someone who has just followed a reset link, since a recovery token is an access token.\n\nSupabase decides whether other sessions survive a password change, per the project's setting; this endpoint does not second-guess it.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            password: z.string().min(8, "Use at least 8 characters").max(72),
          }),
        },
      },
    },
  },
  responses: {
    204: { description: "Changed" },
    400: jsonError("Invalid body, or the password is too weak for the project's policy"),
    401: jsonError("Missing or invalid token"),
    429: jsonError("Too many attempts"),
    502: jsonError("The auth service could not be reached"),
  },
});

const resetPassword = createRoute({
  method: "post",
  path: "/auth/password/reset",
  tags: ["auth"],
  summary: "Set a new password using an emailed code",
  description:
    "The other half of `/auth/password/forgot`. Takes the six-digit code from the email, exchanges it with Supabase for a session, sets the password, and returns that session -- so a reset lands the customer signed in rather than back at a login form.\n\nWrong, expired and already-used codes are one message. Which of the three it was is not something an honest caller needs and not something a guesser should be told.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: credentials.email,
            code: z.string().trim().regex(/^[0-9]{6}$/, "Enter the 6-digit code from the email"),
            password: z.string().min(8, "Use at least 8 characters").max(72),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Password set, and signed in",
      content: { "application/json": { schema: Session } },
    },
    400: jsonError("Invalid body, or the password is too weak for the project's policy"),
    401: jsonError("That code is not usable"),
    429: jsonError("Too many attempts"),
    502: jsonError("The auth service could not be reached"),
  },
});

const verifyCode = createRoute({
  method: "post",
  path: "/auth/verify",
  tags: ["auth"],
  summary: "Confirm an email address with a code",
  description:
    "Serves sign-up confirmation, an address change, and a staff invite -- one endpoint because to Supabase they are the same exchange with a different `type`.\n\nSucceeding returns a session, so confirming an address signs you in rather than sending you to a login form you have just proved you own.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: credentials.email,
            code: z.string().trim().regex(/^[0-9]{6}$/, "Enter the 6-digit code from the email"),
            type: z.enum(["signup", "email_change", "invite"]).default("signup"),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Confirmed, and signed in",
      content: { "application/json": { schema: Session } },
    },
    400: jsonError("Invalid body"),
    401: jsonError("That code is not usable"),
    429: jsonError("Too many attempts"),
  },
});

const changeEmail = createRoute({
  method: "post",
  path: "/auth/email/change",
  tags: ["auth"],
  summary: "Ask to move the account to a new address",
  description:
    "Queues a code to the NEW address; nothing changes until it is confirmed through `/auth/verify` with `type: email_change`. Proving control of the new mailbox is the whole point, so an unconfirmed request leaves the account exactly where it was.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    body: {
      content: {
        "application/json": { schema: z.object({ email: credentials.email }) },
      },
    },
  },
  responses: {
    202: {
      description: "A confirmation code is on its way to the new address",
      content: {
        "application/json": { schema: z.object({ accepted: z.literal(true) }) },
      },
    },
    400: jsonError("Invalid body"),
    401: jsonError("Missing or invalid token"),
    429: jsonError("Too many attempts"),
  },
});

export const authRoute = new OpenAPIHono({ defaultHook: validationHook })
  .openapi(signUp, async (c) => {
    const { email, password, full_name } = c.req.valid("json");
    const log = c.get("log");

    const { status, body } = await gotrue("signup", {
      method: "POST",
      body: { email, password, data: full_name ? { full_name } : undefined },
    });

    if (status >= 400) {
      const reason = reasonOf(body).toLowerCase();
      log?.warn({ status, code: body.error_code }, "auth.signup_refused");

      if (status === 429) throw tooMany();
      if (/already registered|already exists|user_already_exists/.test(reason)) {
        throw new HTTPException(409, {
          message: "That email is already registered. Try signing in instead.",
          cause: { code: "email_exists" },
        });
      }
      // Password policy is configured at the project, so the rule we would
      // have to state here is one this service does not own.
      throw new HTTPException(400, {
        message: /password/.test(reason)
          ? "That password does not meet the requirements."
          : "That sign-up could not be completed.",
        cause: { code: "signup_refused" },
      });
    }

    const session = shapeSession(body);
    if (!session) {
      // GoTrue answered 200 with a user and no session: confirmation is on.
      log?.info({}, "auth.signup_pending_confirmation");
      return c.json({ confirmationRequired: true as const }, 202);
    }
    log?.info({ userId: session.user.id }, "auth.signed_up");
    return c.json(session, 201);
  })

  .openapi(signIn, async (c) => {
    const { email, password } = c.req.valid("json");
    const log = c.get("log");

    // Before GoTrue, not after. A locked address that still reaches the
    // auth service spends its rate limit, which is shared with everyone
    // else signing in.
    const lock = await lockedUntil(email);
    if (lock) {
      log?.warn({ until: lock }, "auth.locked_out");
      throw tooMany();
    }

    const { status, body } = await gotrue("token?grant_type=password", {
      method: "POST",
      body: { email, password },
    });

    if (status >= 400) {
      // Which of the two it was goes to the log, never to the caller.
      log?.warn({ status, reason: reasonOf(body) }, "auth.signin_refused");
      if (status === 429) throw tooMany();

      // 400 and 401 are the two answers that mean "those credentials are
      // wrong". Anything else -- a 404, a 502, GoTrue having a bad
      // afternoon -- is this system's problem, and counting it would
      // turn an auth outage into every account locking itself out at the
      // moment there is already nobody able to sign in.
      if (status === 400 || status === 401) {
        // Counted whether or not the address has an account here.
        // Counting only real ones would make the lockout an enumeration
        // oracle: ten attempts, and 429-instead-of-401 says who banks here.
        const locked = await recordFailure(email);
        if (locked.data) log?.warn({ until: locked.data }, "auth.account_locked");
      }

      throw new HTTPException(401, {
        message: "Email or password is incorrect.",
        cause: { code: "invalid_credentials" },
      });
    }

    const session = shapeSession(body);
    if (!session) {
      throw new HTTPException(401, {
        message: "Email or password is incorrect.",
        cause: { code: "invalid_credentials" },
      });
    }
    // The right password ends the run, so a person who eventually
    // remembers theirs is not carrying nine failures into next week.
    await clearFailures(email);
    log?.info({ userId: session.user.id }, "auth.signed_in");
    return c.json(session, 200);
  })

  .openapi(refresh, async (c) => {
    const { refresh_token } = c.req.valid("json");

    const { status, body } = await gotrue("token?grant_type=refresh_token", {
      method: "POST",
      body: { refresh_token },
    });

    const session = status < 400 ? shapeSession(body) : null;
    if (!session) {
      c.get("log")?.warn({ status }, "auth.refresh_refused");
      throw new HTTPException(401, {
        message: "That session has expired. Sign in again.",
        cause: { code: "refresh_failed" },
      });
    }
    return c.json(session, 200);
  })

  .openapi(signOut, async (c) => {
    const caller = c.get("caller");
    const { status } = await gotrue("logout", { method: "POST", token: caller.token });

    // 401 from GoTrue means the token was already dead, which is the state
    // the caller asked for. Anything else failed for real.
    if (status >= 400 && status !== 401) {
      c.get("log")?.error({ status }, "auth.signout_failed");
      throw new HTTPException(502, {
        message: "The auth service could not be reached. Try again.",
        cause: { code: "auth_unavailable" },
      });
    }
    c.get("log")?.info({ userId: caller.userId }, "auth.signed_out");
    return c.body(null, 204);
  })

  .openapi(forgot, async (c) => {
    const { email } = c.req.valid("json");

    // Not GoTrue's /recover: that mails the link itself, and on this
    // stack it cannot -- SMTP points at a host that does not exist, so it
    // answers 500 and the reset vanishes. We mint the code and queue the
    // mail ourselves, where a failure lands in message_log and is retried.
    const result = await sendAuthCode("recovery", email);

    // Never surfaced. `unknown_user` is exactly the fact this endpoint
    // exists not to reveal, and the others are ours to fix, not the
    // caller's to act on.
    c.get("log")?.info(
      { queued: result.ok, reason: result.ok ? undefined : result.reason },
      "auth.recovery_requested",
    );

    return c.json({ accepted: true as const }, 202);
  })

  .openapi(changePassword, async (c) => {
    const { password } = c.req.valid("json");
    const caller = c.get("caller");

    const { status, body } = await gotrue("user", {
      method: "PUT",
      token: caller.token,
      body: { password },
    });

    if (status >= 400) {
      c.get("log")?.warn({ status, userId: caller.userId }, "auth.password_change_refused");
      if (status === 429) throw tooMany();
      if (status === 401 || status === 403) {
        throw new HTTPException(401, {
          message: "That link or session is no longer valid. Request a new reset email.",
          cause: { code: "token_not_usable" },
        });
      }
      throw passwordRejected(body);
    }

    c.get("log")?.info({ userId: caller.userId }, "auth.password_changed");
    return c.body(null, 204);
  })

  .openapi(resetPassword, async (c) => {
    const { email, code, password } = c.req.valid("json");
    const log = c.get("log");

    // The code buys a session; the session is what authorises the change.
    // There is no separate "is this code valid" step because Supabase
    // spending the code IS the check.
    const verified = await verifyAuthCode("recovery", email, code);
    const session = verified ? shapeSession(verified) : null;
    if (!session) {
      log?.warn({}, "auth.reset_code_rejected");
      throw new HTTPException(401, {
        message: "That code is not valid, or it has expired. Request a new one.",
        cause: { code: "code_not_usable" },
      });
    }

    const { status, body } = await gotrue("user", {
      method: "PUT",
      token: session.accessToken,
      body: { password },
    });
    if (status >= 400) {
      log?.warn({ status }, "auth.reset_password_refused");
      if (status === 429) throw tooMany();
      throw passwordRejected(body);
    }

    // The way out of a lockout you did not cause. Whoever just proved
    // control of this mailbox and set a new password is the owner, and
    // making them wait out somebody else's ten guesses would be the
    // lockout working against the person it exists for.
    await clearFailures(email);

    log?.info({ userId: session.user.id }, "auth.password_reset");
    return c.json(session, 200);
  })

  .openapi(verifyCode, async (c) => {
    const { email, code, type } = c.req.valid("json");

    const verified = await verifyAuthCode(type, email, code);
    const session = verified ? shapeSession(verified) : null;
    if (!session) {
      c.get("log")?.warn({ type }, "auth.verify_rejected");
      throw new HTTPException(401, {
        message: "That code is not valid, or it has expired. Request a new one.",
        cause: { code: "code_not_usable" },
      });
    }

    c.get("log")?.info({ userId: session.user.id, type }, "auth.verified");
    return c.json(session, 200);
  })

  .openapi(changeEmail, async (c) => {
    const { email } = c.req.valid("json");
    const caller = c.get("caller");

    // generate_link identifies the account by its CURRENT address, so the
    // caller's user id is not enough -- it has to be looked up. Scoped to
    // the caller explicitly rather than left to RLS, per fdfbe8d.
    const { data: me } = await caller.db
      .from("customers")
      .select("email")
      .eq("id", caller.userId)
      .maybeSingle();
    const current = (me as { email?: string } | null)?.email;

    // No customers row, or no address on it: nothing to move from. Answer
    // the same 202 regardless, so this cannot be used to probe which
    // accounts exist.
    const result = current
      ? await sendAuthCode("email_change", current, {
          newEmail: email,
          customerId: caller.userId,
        })
      : ({ ok: false, reason: "unknown_user" } as const);
    c.get("log")?.info(
      { userId: caller.userId, queued: result.ok },
      "auth.email_change_requested",
    );

    return c.json({ accepted: true as const }, 202);
  });
