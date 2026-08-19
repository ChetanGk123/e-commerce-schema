import { addressSchema, profileSchema, communicationPreferencesSchema } from "@ecom/schema/validation";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

import { requireAuth, requireStaff } from "../auth";
import { throwOnDbError } from "../errors";
import { jsonError, pageQuery, validationHook } from "../schemas";

/**
 * The customer's own account.
 *
 * All of it runs on the caller's client. Every table here has an
 * own_* policy keyed on auth.uid(), so RLS is the authorisation and
 * this file is shape-shifting -- which is the right amount of code for
 * a surface where the interesting decisions were made in the schema.
 *
 * The one exception is erasure, and it is not a route decision either:
 * anonymize_customer() checks for itself, because every staff member
 * can reach PostgREST directly and a guard in a handler is advice.
 */
const Profile = z
  .object({
    id: z.string().uuid(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    fullName: z.string().nullable(),
    /** Non-null once erased. The row survives; the person does not. */
    anonymizedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("Profile");

const Address = z
  .object({
    id: z.string().uuid(),
    label: z.string().nullable(),
    line1: z.string(),
    line2: z.string().nullable(),
    city: z.string(),
    state: z.string(),
    postalCode: z.string(),
    country: z.string(),
    isDefault: z.boolean(),
  })
  .openapi("Address");

const Preferences = z
  .object({
    orderUpdatesEmail: z.boolean(),
    orderUpdatesSms: z.boolean(),
    orderUpdatesWhatsapp: z.boolean(),
    marketingEmail: z.boolean(),
    marketingSms: z.boolean(),
    marketingWhatsapp: z.boolean(),
  })
  .openapi("CommunicationPreferences");

interface AddressRow {
  id: string;
  label: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  is_default: boolean;
}

interface PrefRow {
  order_updates_email: boolean;
  order_updates_sms: boolean;
  order_updates_whatsapp: boolean;
  marketing_email: boolean;
  marketing_sms: boolean;
  marketing_whatsapp: boolean;
}

const ADDRESS_SELECT =
  "id, label, line1, line2, city, state, postal_code, country, is_default";
const PREF_SELECT =
  "order_updates_email, order_updates_sms, order_updates_whatsapp, marketing_email, marketing_sms, marketing_whatsapp";

const shapeAddress = (a: AddressRow) => ({
  id: a.id,
  label: a.label,
  line1: a.line1,
  line2: a.line2,
  city: a.city,
  state: a.state,
  postalCode: a.postal_code,
  country: a.country,
  isDefault: a.is_default,
});

const shapePrefs = (p: PrefRow) => ({
  orderUpdatesEmail: p.order_updates_email,
  orderUpdatesSms: p.order_updates_sms,
  orderUpdatesWhatsapp: p.order_updates_whatsapp,
  marketingEmail: p.marketing_email,
  marketingSms: p.marketing_sms,
  marketingWhatsapp: p.marketing_whatsapp,
});

const authErrors = {
  401: jsonError("Missing or invalid token"),
  403: jsonError("Not allowed"),
};

const me = createRoute({
  method: "get",
  path: "/account",
  tags: ["account"],
  summary: "My profile, addresses and preferences",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  responses: {
    200: {
      description: "The account",
      content: {
        "application/json": {
          schema: z.object({
            profile: Profile,
            addresses: z.array(Address),
            preferences: Preferences.nullable(),
          }),
        },
      },
    },
    404: jsonError("Signed in, but no customer record -- staff, or a broken signup"),
    ...authErrors,
  },
});

const updateProfile = createRoute({
  method: "patch",
  path: "/account",
  tags: ["account"],
  summary: "Update my name or phone",
  description:
    "Email is not editable here: it is the login identity and lives in Supabase Auth, which owns the confirmation flow.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { body: { content: { "application/json": { schema: profileSchema } } } },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: Profile } } },
    400: jsonError("Invalid body"),
    422: jsonError("A phone number already in use, or not in E.164"),
    ...authErrors,
  },
});

const addAddress = createRoute({
  method: "post",
  path: "/account/addresses",
  tags: ["account"],
  summary: "Add an address",
  description:
    "Setting `is_default` unsets any other default first. uniq_default_address allows exactly one, so doing it the other way round is refused by the database.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    body: {
      content: {
        "application/json": {
          schema: addressSchema.extend({ is_default: z.boolean().default(false) }),
        },
      },
    },
  },
  responses: {
    201: { description: "Added", content: { "application/json": { schema: Address } } },
    400: jsonError("Invalid body"),
    409: jsonError("A default address already exists"),
    ...authErrors,
  },
});

const removeAddress = createRoute({
  method: "delete",
  path: "/account/addresses/{id}",
  tags: ["account"],
  summary: "Remove an address",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: "Removed",
      content: { "application/json": { schema: z.object({ removed: z.boolean() }) } },
    },
    404: jsonError("No such address"),
    ...authErrors,
  },
});

const setPrefs = createRoute({
  method: "put",
  path: "/account/preferences",
  tags: ["account"],
  summary: "Set my communication preferences",
  description:
    "Order updates and marketing are separate consents on purpose. Turning off marketing must never stop a shipping notification, and consent to one is not consent to the other.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: {
    body: {
      content: { "application/json": { schema: communicationPreferencesSchema } },
    },
  },
  responses: {
    200: { description: "Saved", content: { "application/json": { schema: Preferences } } },
    400: jsonError("Invalid body"),
    ...authErrors,
  },
});

const erase = createRoute({
  method: "post",
  path: "/account/erase",
  tags: ["account"],
  summary: "Erase my personal data",
  description:
    "The DPDP erasure right. Scrubs name, email, phone, addresses, consent, wishlist and stock alerts, and redacts the address on every past order. **Irreversible.**\n\nOrders, invoices and store credit survive, because GST requires them kept and because store credit is money owed to the person being erased. The auth.users row is not touched here -- delete it separately, after this, or `customers.id`'s ON DELETE RESTRICT will refuse.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  responses: {
    200: {
      description: "Erased",
      content: { "application/json": { schema: z.object({ erased: z.literal(true) }) } },
    },
    ...authErrors,
  },
});

const eraseCustomer = createRoute({
  method: "post",
  path: "/admin/customers/{id}/erase",
  tags: ["admin", "account"],
  summary: "Erase a customer on their behalf",
  description:
    "Owner or admin only, and the check is inside anonymize_customer() rather than here -- every staff member can reach PostgREST directly with their own JWT, so a guard in a route handler is advice rather than a boundary.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: "Erased",
      content: { "application/json": { schema: z.object({ erased: z.literal(true) }) } },
    },
    403: jsonError("Erasing someone else needs the owner or admin role"),
    401: jsonError("Missing or invalid token"),
  },
});

const listCustomers = createRoute({
  method: "get",
  path: "/admin/customers",
  tags: ["admin", "account"],
  summary: "Customers",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth, requireStaff] as const,
  request: {
    query: z.object({
      q: z.string().trim().min(2).max(120).optional(),
      ...pageQuery,
    }),
  },
  responses: {
    200: {
      description: "A page of customers",
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(Profile),
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

export const accountRoute = new OpenAPIHono({ defaultHook: validationHook })
  .openapi(me, async (c) => {
    const caller = c.get("caller");
    const db = caller.db;

    const [profile, addresses, prefs] = await Promise.all([
      db
        .from("customers")
        .select("id, email, phone, full_name, anonymized_at, created_at")
        .eq("id", caller.userId)
        .maybeSingle(),
      db
        .from("addresses")
        .select(ADDRESS_SELECT)
        .eq("customer_id", caller.userId)
        .order("is_default", { ascending: false }),
      db
        .from("communication_preferences")
        .select(PREF_SELECT)
        .eq("customer_id", caller.userId)
        .maybeSingle(),
    ]);
    for (const r of [profile, addresses, prefs]) throwOnDbError(r.error);

    if (!profile.data) {
      // A staff member has a valid token and no customers row. That is
      // not an error in the system, it is the wrong endpoint.
      throw new HTTPException(404, {
        message: "No customer account for this sign-in",
        cause: { code: "not_a_customer" },
      });
    }
    const p = profile.data as {
      id: string;
      email: string | null;
      phone: string | null;
      full_name: string | null;
      anonymized_at: string | null;
      created_at: string;
    };

    return c.json(
      {
        profile: {
          id: p.id,
          email: p.email,
          phone: p.phone,
          fullName: p.full_name,
          anonymizedAt: p.anonymized_at,
          createdAt: p.created_at,
        },
        addresses: ((addresses.data ?? []) as unknown as AddressRow[]).map(shapeAddress),
        preferences: prefs.data ? shapePrefs(prefs.data as unknown as PrefRow) : null,
      },
      200,
    );
  })

  .openapi(updateProfile, async (c) => {
    const body = c.req.valid("json");
    const caller = c.get("caller");

    const { data, error } = await caller.db
      .from("customers")
      .update({ full_name: body.full_name ?? null, phone: body.phone ?? null })
      .eq("id", caller.userId)
      .select("id, email, phone, full_name, anonymized_at, created_at")
      .single();
    throwOnDbError(error);

    const p = data as {
      id: string;
      email: string | null;
      phone: string | null;
      full_name: string | null;
      anonymized_at: string | null;
      created_at: string;
    };
    return c.json(
      {
        id: p.id,
        email: p.email,
        phone: p.phone,
        fullName: p.full_name,
        anonymizedAt: p.anonymized_at,
        createdAt: p.created_at,
      },
      200,
    );
  })

  .openapi(addAddress, async (c) => {
    const body = c.req.valid("json");
    const caller = c.get("caller");
    const db = caller.db;

    // uniq_default_address permits exactly one default per customer, so
    // the old one has to go first. Two statements, and a failure between
    // them leaves the customer with no default rather than two -- the
    // recoverable side of the two.
    if (body.is_default) {
      const cleared = await db
        .from("addresses")
        .update({ is_default: false })
        .eq("customer_id", caller.userId)
        .eq("is_default", true);
      throwOnDbError(cleared.error);
    }

    const { data, error } = await db
      .from("addresses")
      .insert({
        customer_id: caller.userId,
        label: body.label ?? null,
        line1: body.line1,
        line2: body.line2 ?? null,
        city: body.city,
        state: body.state,
        postal_code: body.postal_code,
        country: body.country,
        is_default: body.is_default,
      })
      .select(ADDRESS_SELECT)
      .single();
    throwOnDbError(error);

    return c.json(shapeAddress(data as unknown as AddressRow), 201);
  })

  .openapi(removeAddress, async (c) => {
    const { id } = c.req.valid("param");
    const { data, error } = await c
      .get("caller")
      .db.from("addresses")
      .delete()
      .eq("id", id)
      // Explicit, not left to RLS: staff_all lets a staff caller reach
      // every address, so relying on the policy here would let one
      // delete somebody else's.
      .eq("customer_id", c.get("caller").userId)
      .select("id");
    throwOnDbError(error);

    // RLS makes someone else's address invisible rather than forbidden,
    // so "nothing removed" is the honest answer to both.
    if (!data || (data as unknown[]).length === 0) {
      throw new HTTPException(404, {
        message: "No such address",
        cause: { code: "not_found" },
      });
    }
    return c.json({ removed: true }, 200);
  })

  .openapi(setPrefs, async (c) => {
    const body = c.req.valid("json");
    const caller = c.get("caller");

    const { data, error } = await caller.db
      .from("communication_preferences")
      .upsert(
        {
          customer_id: caller.userId,
          order_updates_email: body.order_updates_email,
          order_updates_sms: body.order_updates_sms,
          order_updates_whatsapp: body.order_updates_whatsapp,
          marketing_email: body.marketing_email,
          marketing_sms: body.marketing_sms,
          marketing_whatsapp: body.marketing_whatsapp,
        },
        { onConflict: "customer_id" },
      )
      .select(PREF_SELECT)
      .single();
    throwOnDbError(error);

    return c.json(shapePrefs(data as unknown as PrefRow), 200);
  })

  .openapi(erase, async (c) => {
    const caller = c.get("caller");
    const { error } = await caller.db.rpc("anonymize_customer", {
      p_customer_id: caller.userId,
    });
    throwOnDbError(error);
    // The id, and nothing about them -- the point of the call is that
    // there is no longer anything about them to write down.
    c.get("log")?.warn({ customerId: caller.userId }, "account.erased_self");
    return c.json({ erased: true as const }, 200);
  })

  .openapi(eraseCustomer, async (c) => {
    const { id } = c.req.valid("param");
    const { error } = await c
      .get("caller")
      .db.rpc("anonymize_customer", { p_customer_id: id });
    throwOnDbError(error);
    c.get("log")?.warn(
      { customerId: id, by: c.get("caller").userId },
      "account.erased_by_staff",
    );
    return c.json({ erased: true as const }, 200);
  })

  .openapi(listCustomers, async (c) => {
    const { q, limit, offset } = c.req.valid("query");
    let query = c
      .get("caller")
      .db.from("customers")
      .select("id, email, phone, full_name, anonymized_at, created_at", {
        count: "exact",
      });

    if (q) {
      // % and _ are wildcards to ilike; a search for "50%" would
      // otherwise return the whole customer list.
      const esc = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      query = query.or(
        `email.ilike.%${esc}%,full_name.ilike.%${esc}%,phone.ilike.%${esc}%`,
      );
    }

    const { data, error, count } = await query
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    throwOnDbError(error);

    return c.json(
      {
        items: (
          (data ?? []) as unknown as {
            id: string;
            email: string | null;
            phone: string | null;
            full_name: string | null;
            anonymized_at: string | null;
            created_at: string;
          }[]
        ).map((p) => ({
          id: p.id,
          email: p.email,
          phone: p.phone,
          fullName: p.full_name,
          anonymizedAt: p.anonymized_at,
          createdAt: p.created_at,
        })),
        total: count ?? null,
        limit,
        offset,
      },
      200,
    );
  });
