import { STAFF_ROLES } from "@ecom/schema/enums";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { requireAuth, requireRole, requireStaff } from "../auth";
import { throwOnDbError } from "../errors";
import { jsonError, pageQuery, validationHook } from "../schemas";
import { serviceClient } from "../supabase";

/**
 * Staff accounts -- the fourth service-key path.
 *
 * api-plan lists exactly four things the service key is for: checkout,
 * payment capture, webhooks, and creating staff auth users. The first
 * three were built. This is the fourth, and without it there was no
 * supported way to create a staff member at all: `staff_users.id` is
 * `auth.users.id` with no default, and unlike `customers` there is no
 * trigger that fills it in, so a staff account needs an auth user AND a
 * staff_users row written together.
 *
 * WHAT THE ROLE CHECK IS WORTH, per route, because it differs:
 *
 * - Creating: a real boundary. Making an auth user needs the service
 *   key, which lives only in this process, so `requireRole("owner")` is
 *   the only thing between a support account and minting an owner.
 * - Reading and updating: UX. `staff_all` covers every table in public,
 *   `staff_users` included, so any active staff member can already read
 *   and write that table straight through PostgREST with their own JWT.
 *   The gate here shapes the admin surface; it contains nobody. The fix
 *   is the role matrix in api-plan B11 / README, not a check here.
 */

const StaffMember = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    fullName: z.string().nullable(),
    role: z.enum(STAFF_ROLES),
    isActive: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("StaffMember");

interface StaffRow {
  id: string;
  email: string;
  full_name: string | null;
  role: (typeof STAFF_ROLES)[number];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const STAFF_SELECT = "id, email, full_name, role, is_active, created_at, updated_at";

const shape = (s: StaffRow) => ({
  id: s.id,
  email: s.email,
  fullName: s.full_name,
  role: s.role,
  isActive: s.is_active,
  createdAt: s.created_at,
  updatedAt: s.updated_at,
});

const authErrors = {
  401: jsonError("Missing or invalid token"),
  403: jsonError("Requires the owner role"),
};

const list = createRoute({
  method: "get",
  path: "/admin/staff",
  tags: ["admin", "staff"],
  summary: "Everyone with admin access",
  description:
    "Owner-gated to match the admin's staff screen, but be clear about what that is worth: `staff_all` grants every active staff member read and write on `staff_users` through PostgREST directly. This shapes the surface, it does not contain anyone.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff, requireRole("owner")] as const,
  request: {
    query: z.object({
      include_inactive: z.coerce.boolean().default(false),
      ...pageQuery,
    }),
  },
  responses: {
    200: {
      description: "Staff, newest first",
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(StaffMember),
            total: z.number().int().nullable(),
            limit: z.number().int(),
            offset: z.number().int(),
          }),
        },
      },
    },
    ...authErrors,
  },
});

const create = createRoute({
  method: "post",
  path: "/admin/staff",
  tags: ["admin", "staff"],
  summary: "Create a staff account",
  description:
    "Creates the auth user on the service key, then the `staff_users` row as the calling owner so `audit_logs` records who granted the access.\n\nThe password is set here rather than emailed as an invite: this stack's mail provider is optional and unproven (api-plan B11 drained the outbox against a real 401 from Resend), and an invite that silently never arrives is a staff member who cannot sign in with nothing to show for it. Hand it over out of band; they can change it through the normal Supabase password reset.\n\n`email_confirm` is set, because a self-hosted stack with no SMTP would otherwise leave the account unable to sign in until someone confirms an email that was never sent.\n\nNote that the new auth user also gets a `customers` row, from the `handle_new_user` trigger. That is deliberate and predates this endpoint: the two tables are separate roles for one person.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff, requireRole("owner")] as const,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: z.string().email("Enter a valid email address").max(254),
            password: z
              .string()
              .min(12, "Use at least 12 characters")
              .max(72, "Supabase Auth caps passwords at 72 characters"),
            full_name: z.string().trim().min(1).max(120).optional(),
            role: z.enum(STAFF_ROLES).default("support"),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: StaffMember } },
    },
    400: jsonError("Invalid body"),
    409: jsonError("That email already has an account"),
    502: jsonError("Supabase Auth could not be reached"),
    ...authErrors,
  },
});

const update = createRoute({
  method: "patch",
  path: "/admin/staff/{id}",
  tags: ["admin", "staff"],
  summary: "Change a role, or switch an account off",
  description:
    "Deactivation is the delete. `audit_logs.staff_id` and `inventory_movements.created_by` point at these rows, so removing one would take the trail with it -- `is_active = false` is what `requireStaff` checks, and it takes effect on the next request.\n\nAn owner cannot change their own row. That single rule is also what guarantees the store can never be locked out: since no owner can demote or deactivate themselves, at least one active owner always remains. Ask another owner.\n\nEmail and password are not editable here. Both live on the auth user rather than this row, and changing them is a Supabase Auth operation the account holder does for themselves.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff, requireRole("owner")] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              role: z.enum(STAFF_ROLES).optional(),
              is_active: z.boolean().optional(),
              full_name: z.string().trim().min(1).max(120).nullable().optional(),
            })
            .refine((b) => Object.keys(b).length > 0, "Send at least one field to change"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: StaffMember } },
    },
    400: jsonError("Invalid body"),
    403: jsonError("Requires the owner role, or you tried to change your own row"),
    404: jsonError("No such staff member"),
    401: jsonError("Missing or invalid token"),
  },
});

export const staffRoute = new OpenAPIHono({ defaultHook: validationHook })
  .openapi(list, async (c) => {
    const { include_inactive, limit, offset } = c.req.valid("query");

    let query = c.get("caller").db.from("staff_users").select(STAFF_SELECT, { count: "exact" });
    if (!include_inactive) query = query.eq("is_active", true);

    const { data, error, count } = await query
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    throwOnDbError(error);

    return c.json(
      {
        items: ((data ?? []) as unknown as StaffRow[]).map(shape),
        total: count ?? null,
        limit,
        offset,
      },
      200,
    );
  })

  .openapi(create, async (c) => {
    const body = c.req.valid("json");
    const log = c.get("log");

    // The service key, and only here: creating an auth user is the one
    // thing in this file a staff JWT cannot do, which is what makes the
    // owner check above a boundary rather than advice.
    const { data: created, error: authError } = await serviceClient().auth.admin.createUser({
      email: body.email,
      password: body.password,
      email_confirm: true,
      user_metadata: body.full_name ? { full_name: body.full_name } : undefined,
    });

    if (authError || !created?.user) {
      // GoTrue's own words stay in the log: they carry project and
      // configuration detail. The one case worth naming to the caller is
      // a duplicate, because it is the only one they can act on.
      log?.warn({ err: authError?.message, code: authError?.code }, "staff.auth_create_failed");

      const duplicate =
        authError?.code === "email_exists" ||
        authError?.status === 422 ||
        /already been registered|already exists/i.test(authError?.message ?? "");

      throw new HTTPException(duplicate ? 409 : 502, {
        message: duplicate
          ? "That email already has an account. Promoting an existing account to staff is not supported here."
          : "The auth service could not be reached. Try again.",
        cause: { code: duplicate ? "email_exists" : "auth_unavailable" },
      });
    }

    // As the caller, not the service key: staff_users carries an audit
    // trigger, and audit_row() reads auth.uid(). On the service key the
    // row recording who was granted admin access would say nobody did it.
    const { data, error } = await c
      .get("caller")
      .db.from("staff_users")
      .insert({
        id: created.user.id,
        email: body.email,
        full_name: body.full_name ?? null,
        role: body.role,
      })
      .select(STAFF_SELECT)
      .single();

    if (error) {
      // No rollback, and not for lack of trying: handle_new_user has
      // already given this auth user a customers row, and customers.id
      // is ON DELETE RESTRICT, so deleting the auth user would fail.
      //
      // The leftover is harmless. An auth user with no staff_users row
      // is exactly a shopper account -- requireStaff refuses it -- which
      // is the state every signup starts in. It is logged because the
      // operator needs to know the email is now taken.
      log?.error(
        { userId: created.user.id, err: error.message },
        "staff.orphan_auth_user_left_behind",
      );
      throwOnDbError(error);
    }

    log?.info(
      { staffId: created.user.id, role: body.role, by: c.get("caller").userId },
      "staff.created",
    );
    return c.json(shape(data as unknown as StaffRow), 201);
  })

  .openapi(update, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const caller = c.get("caller");

    // Refused before the query: an owner who demotes or deactivates
    // themselves locks the store out of staff management for good, since
    // creating staff needs an owner and only this endpoint can do it.
    if (id === caller.userId) {
      throw new HTTPException(403, {
        message: "You cannot change your own staff account. Ask another owner.",
        cause: { code: "cannot_change_own_staff_row" },
      });
    }

    const { data, error } = await caller.db
      .from("staff_users")
      .update({
        ...(body.role !== undefined && { role: body.role }),
        ...(body.is_active !== undefined && { is_active: body.is_active }),
        ...(body.full_name !== undefined && { full_name: body.full_name }),
      })
      .eq("id", id)
      .select(STAFF_SELECT)
      .maybeSingle();
    throwOnDbError(error);
    if (!data) throw new HTTPException(404, { message: "No such staff member." });

    c.get("log")?.info(
      { staffId: id, changed: Object.keys(body), by: caller.userId },
      "staff.updated",
    );
    return c.json(shape(data as unknown as StaffRow), 200);
  });
