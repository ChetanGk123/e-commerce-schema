import { ROLES } from "@ecom/schema/enums";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { requireAuth, requireRole, requireStaff } from "../auth";
import { throwOnDbError } from "../errors";
import { BUILT_IN, type Message, invalidateTemplateCache, render } from "../mailer";
import { jsonError, validationHook } from "../schemas";

/**
 * Editing the copy that goes to customers.
 *
 * The catalogue of what CAN be sent lives in `mailer.ts` -- keys, the
 * variables each one offers, and copy that works untouched. This surface
 * only ever overrides it, row by row, in `message_templates`.
 *
 * That asymmetry is the design. A key nobody has edited has no row, so a
 * fresh install sends correct email before anyone opens the admin, and
 * DELETE is a working "revert to default" rather than a way to break
 * password reset. There is no way, through this API, to invent a
 * template the service will never send or to delete one it needs.
 */

const Template = z
  .object({
    key: z.string(),
    subject: z.string(),
    body: z.string(),
    description: z.string(),
    /** Substituted from the queued message's payload. */
    variables: z.array(z.string()),
    /** The message is not worth sending without these. */
    required: z.array(z.string()),
    /** False means this is the built-in copy, untouched. */
    customised: z.boolean(),
    updatedAt: z.string().nullable(),
  })
  .openapi("EmailTemplate");

interface Row {
  key: string;
  subject: string;
  body: string;
  description: string | null;
  updated_at: string;
}

const authErrors = {
  401: jsonError("Missing or invalid token"),
  403: jsonError("Requires the owner or admin role"),
};

/** A built-in plus whatever overrides it, as one thing to render or list. */
const merge = (key: string, row?: Row): z.infer<typeof Template> => {
  const def = BUILT_IN[key]!;
  return {
    key,
    subject: row?.subject ?? def.subject,
    body: row?.body ?? def.body,
    description: row?.description ?? def.description,
    variables: [...def.variables],
    required: [...def.required],
    customised: row !== undefined,
    updatedAt: row?.updated_at ?? null,
  };
};

const missingRequired = (body: string, required: readonly string[]) =>
  required.filter((r) => !new RegExp(`\\{\\{\\s*${r}\\s*\\}\\}`).test(body));

const list = createRoute({
  method: "get",
  path: "/admin/email-templates",
  tags: ["admin", "email"],
  summary: "Every email the store can send",
  description:
    "The full catalogue, whether or not it has been customised. `customised: false` means the copy shown is the built-in and no row exists for it yet.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff, requireRole(ROLES.OWNER, ROLES.ADMIN)] as const,
  responses: {
    200: {
      description: "Templates, by key",
      content: {
        "application/json": { schema: z.object({ items: z.array(Template) }) },
      },
    },
    ...authErrors,
  },
});

const getOne = createRoute({
  method: "get",
  path: "/admin/email-templates/{key}",
  tags: ["admin", "email"],
  summary: "One template, with the variables it can use",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff, requireRole(ROLES.OWNER, ROLES.ADMIN)] as const,
  request: { params: z.object({ key: z.string() }) },
  responses: {
    200: { description: "The template", content: { "application/json": { schema: Template } } },
    404: jsonError("No such template"),
    ...authErrors,
  },
});

const save = createRoute({
  method: "put",
  path: "/admin/email-templates/{key}",
  tags: ["admin", "email"],
  summary: "Customise a template",
  description:
    "Upserts the override. Only keys the service actually sends are accepted -- inventing one would produce a template nothing ever renders and no way to notice.\n\nA body that drops a required variable is refused by name. Saving a password reset with no `{{code}}` in it would send customers an email they cannot act on, and nothing downstream would report a problem.\n\nThe subject is one header line; a newline in it is refused by the database, for every caller including the service key.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff, requireRole(ROLES.OWNER, ROLES.ADMIN)] as const,
  request: {
    params: z.object({ key: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            subject: z
              .string()
              .trim()
              .min(1, "A subject is required")
              .max(200)
              .refine((v) => !/[\r\n]/.test(v), "A subject must be a single line"),
            body: z.string().trim().min(1, "A body is required").max(20_000),
            description: z.string().trim().max(300).nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Saved", content: { "application/json": { schema: Template } } },
    400: jsonError("Invalid body"),
    404: jsonError("No such template key"),
    422: jsonError("The body drops a variable the message needs"),
    ...authErrors,
  },
});

const revert = createRoute({
  method: "delete",
  path: "/admin/email-templates/{key}",
  tags: ["admin", "email"],
  summary: "Revert to the built-in copy",
  description:
    "Deletes the override. The email keeps sending -- it goes back to the copy shipped with the service, which is why there is no way to end up with no template at all.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff, requireRole(ROLES.OWNER, ROLES.ADMIN)] as const,
  request: { params: z.object({ key: z.string() }) },
  responses: {
    200: { description: "Reverted", content: { "application/json": { schema: Template } } },
    404: jsonError("No such template key"),
    ...authErrors,
  },
});

const preview = createRoute({
  method: "post",
  path: "/admin/email-templates/{key}/preview",
  tags: ["admin", "email"],
  summary: "See it rendered before a customer does",
  description:
    "Renders with sample values, or with `payload` if you send one. Nothing is queued and nothing is sent.\n\nSend `subject` and `body` to preview an unsaved draft -- which is the point: the alternative is saving it and finding out from a customer.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff, requireRole(ROLES.OWNER, ROLES.ADMIN)] as const,
  request: {
    params: z.object({ key: z.string() }),
    body: {
      required: false,
      content: {
        "application/json": {
          schema: z.object({
            subject: z.string().max(200).optional(),
            body: z.string().max(20_000).optional(),
            payload: z.record(z.union([z.string(), z.number()])).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Rendered",
      content: {
        "application/json": {
          schema: z.object({
            subject: z.string(),
            text: z.string(),
            /** False when the draft was rejected and the built-in rendered instead. */
            usedOverride: z.boolean(),
            missingRequired: z.array(z.string()),
          }),
        },
      },
    },
    400: jsonError("Invalid body"),
    404: jsonError("No such template key"),
    ...authErrors,
  },
});

/** Stand-ins, so a preview shows the shape a customer would receive. */
const SAMPLE: Record<string, string | number> = {
  code: "123456",
  order_number: "ORD-2026-00042",
  grand_total: 1915.14,
};

const known = (key: string) => {
  if (!BUILT_IN[key]) {
    throw new HTTPException(404, {
      message: "There is no email with that key.",
      cause: { code: "unknown_template" },
    });
  }
};

export const emailTemplatesRoute = new OpenAPIHono({ defaultHook: validationHook })
  .openapi(list, async (c) => {
    const { data, error } = await c
      .get("caller")
      .db.from("message_templates")
      .select("key, subject, body, description, updated_at");
    throwOnDbError(error);

    const rows = new Map(((data ?? []) as unknown as Row[]).map((r) => [r.key, r]));
    return c.json({ items: Object.keys(BUILT_IN).map((k) => merge(k, rows.get(k))) }, 200);
  })

  .openapi(getOne, async (c) => {
    const { key } = c.req.valid("param");
    known(key);

    const { data, error } = await c
      .get("caller")
      .db.from("message_templates")
      .select("key, subject, body, description, updated_at")
      .eq("key", key)
      .maybeSingle();
    throwOnDbError(error);

    return c.json(merge(key, (data as unknown as Row) ?? undefined), 200);
  })

  .openapi(save, async (c) => {
    const { key } = c.req.valid("param");
    const body = c.req.valid("json");
    known(key);

    // Refused here with the names, not just left to fail silently at send
    // time. The renderer ignores an override like this as a backstop --
    // staff can write the table directly -- but somebody using the admin
    // deserves to be told which variable they dropped.
    const missing = missingRequired(body.body, BUILT_IN[key]!.required);
    if (missing.length > 0) {
      throw new HTTPException(422, {
        message: `This email needs ${missing
          .map((m) => `{{${m}}}`)
          .join(", ")} in the body, or it cannot be acted on.`,
        cause: { code: "missing_required_variable" },
      });
    }

    const { data, error } = await c
      .get("caller")
      .db.from("message_templates")
      .upsert(
        {
          key,
          subject: body.subject,
          body: body.body,
          description: body.description ?? null,
        },
        { onConflict: "key" },
      )
      .select("key, subject, body, description, updated_at")
      .single();
    throwOnDbError(error);

    // Local only: another instance keeps its copy until the TTL lapses.
    invalidateTemplateCache();
    c.get("log")?.info({ key, by: c.get("caller").userId }, "email_template.saved");

    return c.json(merge(key, data as unknown as Row), 200);
  })

  .openapi(revert, async (c) => {
    const { key } = c.req.valid("param");
    known(key);

    const { error } = await c.get("caller").db.from("message_templates").delete().eq("key", key);
    throwOnDbError(error);

    invalidateTemplateCache();
    c.get("log")?.info({ key, by: c.get("caller").userId }, "email_template.reverted");

    // Deleting an override cannot leave the store unable to send: the
    // built-in is what comes back.
    return c.json(merge(key), 200);
  })

  .openapi(preview, async (c) => {
    const { key } = c.req.valid("param");
    const draft = c.req.valid("json") ?? {};
    known(key);

    const def = BUILT_IN[key]!;
    const payload: Record<string, unknown> = { ...SAMPLE, ...(draft.payload ?? {}) };

    const saved = await c
      .get("caller")
      .db.from("message_templates")
      .select("subject, body")
      .eq("key", key)
      .maybeSingle();
    throwOnDbError(saved.error);
    const stored = (saved.data as { subject: string; body: string } | null) ?? undefined;

    // A draft is only half-supplied while someone is typing, so the other
    // half comes from whatever is saved -- or the built-in, if nothing is.
    const base = stored ?? def;
    const override =
      draft.subject !== undefined || draft.body !== undefined
        ? { subject: draft.subject ?? base.subject, body: draft.body ?? base.body }
        : stored;

    const message: Message = {
      id: "00000000-0000-4000-8000-000000000000",
      channel: "email",
      template: key,
      recipient: "preview@example.com",
      payload,
      attempts: 0,
    };

    const out = render(message, override);
    return c.json(
      {
        subject: out.subject,
        text: out.text,
        usedOverride: out.usedOverride,
        missingRequired: override ? missingRequired(override.body, def.required) : [],
      },
      200,
    );
  });
