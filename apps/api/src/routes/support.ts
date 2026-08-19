import { ticketSchema, ticketReplySchema, enquirySchema } from "@ecom/schema/validation";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { optionalAuth, requireAuth, requireStaff } from "../auth";
import { throwOnDbError } from "../errors";
import { jsonError, pageQuery, validationHook } from "../schemas";
import { anonClient } from "../supabase";

/**
 * Support.
 *
 * The load-bearing line in this file is the one that is not here: no
 * customer-facing route ever selects `is_internal`, and it would not
 * matter if one did. own_ticket_msgs_r has `is_internal = false` baked
 * into the policy, so an internal note is not hidden from customers --
 * it does not exist for them. That is the difference between a filter
 * someone can forget and a rule they cannot.
 */
const TicketMessage = z
  .object({
    id: z.string().uuid(),
    senderType: z.enum(["customer", "staff", "system"]),
    senderId: z.string().uuid().nullable(),
    body: z.string(),
    createdAt: z.string(),
  })
  .openapi("TicketMessage");

const Ticket = z
  .object({
    id: z.string().uuid(),
    ticketNumber: z.string(),
    subject: z.string(),
    category: z.string(),
    status: z.string(),
    orderId: z.string().uuid().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    messages: z.array(TicketMessage),
  })
  .openapi("Ticket");

/**
 * The staff message, which is the customer's plus the one field that
 * matters. Declared separately rather than left to inheritance:
 * .extend() does not reach inside `messages`, so an AdminTicket built
 * from Ticket alone publishes a schema saying staff messages carry no
 * isInternal -- while the handler returns it. A contract that
 * understates what a response contains is still a wrong contract.
 */
const StaffTicketMessage = TicketMessage.extend({
  isInternal: z.boolean(),
}).openapi("StaffTicketMessage");

const AdminTicket = Ticket.extend({
  customerId: z.string().uuid().nullable(),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  assignedTo: z.string().uuid().nullable(),
  firstResponseAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  messages: z.array(StaffTicketMessage),
}).openapi("AdminTicket");

interface TicketRow {
  id: string;
  ticket_number: string;
  subject: string;
  category: string;
  status: string;
  order_id: string | null;
  created_at: string;
  updated_at: string;
  customer_id?: string | null;
  priority?: "low" | "normal" | "high" | "urgent";
  assigned_to?: string | null;
  first_response_at?: string | null;
  resolved_at?: string | null;
  ticket_messages: {
    id: string;
    sender_type: "customer" | "staff" | "system";
    sender_id: string | null;
    body: string;
    is_internal?: boolean;
    created_at: string;
  }[];
}

// Two select lists, and the customer one simply does not name
// is_internal. Belt to the policy's braces.
const CUSTOMER_TICKET_SELECT =
  "id, ticket_number, subject, category, status, order_id, created_at, updated_at, ticket_messages(id, sender_type, sender_id, body, created_at)";
const ADMIN_TICKET_SELECT =
  "id, ticket_number, subject, category, status, order_id, created_at, updated_at, customer_id, priority, assigned_to, first_response_at, resolved_at, ticket_messages(id, sender_type, sender_id, body, is_internal, created_at)";

const messages = (t: TicketRow) =>
  (t.ticket_messages ?? [])
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

/** The customer's view. isInternal is absent, because for them it is. */
const shape = (t: TicketRow) => ({
  id: t.id,
  ticketNumber: t.ticket_number,
  subject: t.subject,
  category: t.category,
  status: t.status,
  orderId: t.order_id,
  createdAt: t.created_at,
  updatedAt: t.updated_at,
  messages: messages(t).map((m) => ({
    id: m.id,
    senderType: m.sender_type,
    senderId: m.sender_id,
    body: m.body,
    createdAt: m.created_at,
  })),
});

const shapeForStaff = (t: TicketRow) => ({
  ...shape(t),
  customerId: t.customer_id ?? null,
  priority: t.priority ?? ("normal" as const),
  assignedTo: t.assigned_to ?? null,
  firstResponseAt: t.first_response_at ?? null,
  resolvedAt: t.resolved_at ?? null,
  messages: messages(t).map((m) => ({
    id: m.id,
    senderType: m.sender_type,
    senderId: m.sender_id,
    body: m.body,
    isInternal: m.is_internal ?? false,
    createdAt: m.created_at,
  })),
});

const authErrors = {
  401: jsonError("Missing or invalid token"),
  403: jsonError("Not allowed"),
};

const open = createRoute({
  method: "post",
  path: "/support/tickets",
  tags: ["support"],
  summary: "Open a ticket",
  description:
    "The ticket and its first message are written together, so an agent never opens a blank conversation.\n\nStatus, priority and assignment are pinned by RLS at insert -- a customer cannot file a ticket already marked urgent, and cannot attach somebody else's order to it.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { body: { content: { "application/json": { schema: ticketSchema } } } },
  responses: {
    201: { description: "Opened", content: { "application/json": { schema: Ticket } } },
    400: jsonError("Invalid body"),
    403: jsonError("That order is not yours"),
    422: jsonError("No subject, or nothing said"),
    401: jsonError("Missing or invalid token"),
  },
});

const mine = createRoute({
  method: "get",
  path: "/support/tickets",
  tags: ["support"],
  summary: "My tickets",
  description:
    "Internal staff notes are absent, and not because this endpoint filters them: own_ticket_msgs_r carries `is_internal = false` in the policy itself.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  responses: {
    200: {
      description: "Newest first",
      content: { "application/json": { schema: z.object({ items: z.array(Ticket) }) } },
    },
    ...authErrors,
  },
});

const reply = createRoute({
  method: "post",
  path: "/support/tickets/{id}/messages",
  tags: ["support"],
  summary: "Reply to my ticket",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { "application/json": { schema: ticketReplySchema } } },
  },
  responses: {
    201: { description: "Sent", content: { "application/json": { schema: Ticket } } },
    400: jsonError("Invalid body"),
    ...authErrors,
  },
});

const queue = createRoute({
  method: "get",
  path: "/admin/tickets",
  tags: ["admin", "support"],
  summary: "The support queue",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    query: z.object({
      status: z
        .enum(["open", "pending_customer", "pending_internal", "resolved", "closed"])
        .optional(),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
      assigned_to: z.string().uuid().optional(),
      ...pageQuery,
    }),
  },
  responses: {
    200: {
      description: "A page of tickets",
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(AdminTicket),
            total: z.number().int().nullable(),
            limit: z.number().int(),
            offset: z.number().int(),
          }),
        },
      },
    },
    400: jsonError("Invalid query"),
    ...authErrors,
  },
});

const staffReply = createRoute({
  method: "post",
  path: "/admin/tickets/{id}/messages",
  tags: ["admin", "support"],
  summary: "Reply, or leave an internal note",
  description:
    "`is_internal: true` writes a note the customer can never see -- the policy on their side excludes it, so it is not a display choice.\n\nA public reply stamps `first_response_at` if it is the first, and moves the ticket to `pending_customer`. An internal note does neither: the customer has not been answered.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            body: z.string().trim().min(1).max(5000),
            is_internal: z.boolean().default(false),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Sent", content: { "application/json": { schema: AdminTicket } } },
    400: jsonError("Invalid body"),
    404: jsonError("No such ticket"),
    409: jsonError("The ticket is closed"),
    ...authErrors,
  },
});

const triage = createRoute({
  method: "patch",
  path: "/admin/tickets/{id}",
  tags: ["admin", "support"],
  summary: "Set status, priority or assignee",
  description:
    "Resolving stamps `resolved_at`; reopening clears it, or time-to-resolution counts the first attempt and ignores the three that followed.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            status: z
              .enum(["open", "pending_customer", "pending_internal", "resolved", "closed"])
              .optional(),
            priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
            assigned_to: z.string().uuid().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: AdminTicket } } },
    400: jsonError("Invalid body"),
    404: jsonError("No such ticket"),
    ...authErrors,
  },
});

const askAboutProduct = createRoute({
  method: "post",
  path: "/enquiries",
  tags: ["support"],
  summary: "Ask about a product",
  description:
    "Open to guests, which is the point -- a bulk enquiry is often the first contact anyone has with the store. RLS pins status to `new` and refuses an assignee or a converted order, so a guest cannot file a pre-triaged enquiry.",
  security: [{ bearerAuth: [] }],
  middleware: [optionalAuth] as const,
  request: { body: { content: { "application/json": { schema: enquirySchema } } } },
  responses: {
    201: {
      description: "Received",
      content: {
        "application/json": {
          schema: z.object({ id: z.string().uuid(), status: z.string() }),
        },
      },
    },
    400: jsonError("Invalid body"),
    401: jsonError("A token was sent but is not valid"),
  },
});

export const supportRoute = new OpenAPIHono({ defaultHook: validationHook })
  .openapi(open, async (c) => {
    const body = c.req.valid("json");
    const db = c.get("caller").db;

    const { data, error } = await db.rpc("open_ticket", {
      p_subject: body.subject,
      p_body: body.message,
      p_category: body.category ?? "general",
      p_order_id: body.order_id ?? null,
    });
    throwOnDbError(error);

    const created = await db
      .from("support_tickets")
      .select(CUSTOMER_TICKET_SELECT)
      .eq("id", data as unknown as string)
      .single();
    throwOnDbError(created.error);
    return c.json(shape(created.data as unknown as TicketRow), 201);
  })

  .openapi(mine, async (c) => {
    const { data, error } = await c
      .get("caller")
      .db.from("support_tickets")
      .select(CUSTOMER_TICKET_SELECT)
      .eq("customer_id", c.get("caller").userId)
      .order("created_at", { ascending: false });
    throwOnDbError(error);
    return c.json(
      {
        items: ((data ?? []) as unknown as TicketRow[]).map(shape),
      },
      200,
    );
  })

  .openapi(reply, async (c) => {
    const { id } = c.req.valid("param");
    const { body } = c.req.valid("json");
    const caller = c.get("caller");

    // own_ticket_msgs_i pins sender_type, sender_id and is_internal, so
    // a customer cannot post as staff or write an internal note.
    const sent = await caller.db.from("ticket_messages").insert({
      ticket_id: id,
      sender_type: "customer",
      sender_id: caller.userId,
      body,
    });
    throwOnDbError(sent.error);

    const after = await caller.db
      .from("support_tickets")
      .select(CUSTOMER_TICKET_SELECT)
      .eq("id", id)
      .single();
    throwOnDbError(after.error);
    return c.json(shape(after.data as unknown as TicketRow), 201);
  })

  .openapi(queue, async (c) => {
    const { status, priority, assigned_to, limit, offset } = c.req.valid("query");
    let query = c
      .get("caller")
      .db.from("support_tickets")
      .select(ADMIN_TICKET_SELECT, { count: "exact" });

    if (status) query = query.eq("status", status);
    if (priority) query = query.eq("priority", priority);
    if (assigned_to) query = query.eq("assigned_to", assigned_to);

    const { data, error, count } = await query
      // Unanswered first: first_response_at null sorts ahead, which is
      // the queue an agent actually wants.
      .order("first_response_at", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: true })
      .range(offset, offset + limit - 1);
    throwOnDbError(error);

    return c.json(
      {
        items: ((data ?? []) as unknown as TicketRow[]).map(shapeForStaff),
        total: count ?? null,
        limit,
        offset,
      },
      200,
    );
  })

  .openapi(staffReply, async (c) => {
    const { id } = c.req.valid("param");
    const { body, is_internal } = c.req.valid("json");
    const db = c.get("caller").db;

    const { error } = await db.rpc("admin_reply_ticket", {
      p_ticket_id: id,
      p_body: body,
      p_is_internal: is_internal,
    });
    throwOnDbError(error);

    const after = await db.from("support_tickets").select(ADMIN_TICKET_SELECT).eq("id", id).single();
    throwOnDbError(after.error);
    c.get("log")?.info({ ticketId: id, internal: is_internal }, "support.replied");
    return c.json(shapeForStaff(after.data as unknown as TicketRow), 201);
  })

  .openapi(triage, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = c.get("caller").db;

    const { error } = await db.rpc("admin_update_ticket", {
      p_ticket_id: id,
      p_status: body.status ?? null,
      p_priority: body.priority ?? null,
      p_assigned_to: body.assigned_to ?? null,
    });
    throwOnDbError(error);

    const after = await db.from("support_tickets").select(ADMIN_TICKET_SELECT).eq("id", id).single();
    throwOnDbError(after.error);
    return c.json(shapeForStaff(after.data as unknown as TicketRow), 200);
  })

  .openapi(askAboutProduct, async (c) => {
    const body = c.req.valid("json");
    const caller = c.get("caller");

    // Guests reach this on the anon role, where enquiries_insert
    // requires a contact and forbids a customer_id. Signed in, the
    // caller's own client attaches it.
    const db = caller?.db ?? anonClient();
    const { data, error } = await db
      .from("product_enquiries")
      .insert({
        product_id: body.product_id ?? null,
        variant_id: body.variant_id ?? null,
        customer_id: caller?.userId ?? null,
        guest_name: caller ? null : (body.guest_name ?? null),
        guest_email: caller ? null : (body.guest_email ?? null),
        guest_phone: caller ? null : (body.guest_phone ?? null),
        quantity: body.quantity ?? null,
        message: body.message,
      })
      .select("id, status")
      .single();
    throwOnDbError(error);

    return c.json(data as { id: string; status: string }, 201);
  });
